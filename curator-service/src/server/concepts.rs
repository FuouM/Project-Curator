use crate::handlers;
use crate::ClientContext;
use curator_core::grpc::concepts::{
    concepts_service_server::ConceptsService, AddConceptSamplesRequest, AutoConceptTagsCleanedResult,
    CleanAutoConceptTagsRequest, ConceptListResult, ConceptRescannedResult, ConceptResult,
    ConceptSamplesResult, CreateConceptRequest, DeleteConceptRequest, RemoveConceptSampleRequest,
    RescanConceptRequest, UpdateConceptRequest,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct ConceptsServiceImpl {
    ctx: Arc<ClientContext>,
}

impl ConceptsServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl ConceptsService for ConceptsServiceImpl {
    async fn create_concept(
        &self,
        request: TonicRequest<CreateConceptRequest>,
    ) -> Result<TonicResponse<ConceptResult>, Status> {
        let req = request.into_inner();
        let concept = handlers::concepts::create_concept_logic(
            &self.ctx.db,
            &req.name,
            &req.category,
            req.threshold,
            &req.sample_image_ids,
            &self.ctx.model_manager,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptResult {
            concept: Some(concept.into()),
        }))
    }

    async fn list_concepts(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ConceptListResult>, Status> {
        let concepts = handlers::concepts::list_concepts_logic(&self.ctx.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptListResult {
            concepts: concepts.into_iter().map(Into::into).collect(),
        }))
    }

    async fn update_concept(
        &self,
        request: TonicRequest<UpdateConceptRequest>,
    ) -> Result<TonicResponse<ConceptResult>, Status> {
        let req = request.into_inner();
        let concept = handlers::concepts::update_concept_logic(
            &self.ctx.db,
            req.id,
            req.threshold,
            req.category,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptResult {
            concept: Some(concept.into()),
        }))
    }

    async fn delete_concept(
        &self,
        request: TonicRequest<DeleteConceptRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::concepts::delete_concept_logic(&self.ctx.db, req.id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(()))
    }

    async fn add_concept_samples(
        &self,
        request: TonicRequest<AddConceptSamplesRequest>,
    ) -> Result<TonicResponse<ConceptResult>, Status> {
        let req = request.into_inner();
        let concept = handlers::concepts::add_concept_samples_logic(
            &self.ctx.db,
            req.concept_id,
            &req.image_ids,
            &self.ctx.model_manager,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptResult {
            concept: Some(concept.into()),
        }))
    }

    async fn remove_concept_sample(
        &self,
        request: TonicRequest<RemoveConceptSampleRequest>,
    ) -> Result<TonicResponse<ConceptResult>, Status> {
        let req = request.into_inner();
        let concept = handlers::concepts::remove_concept_sample_logic(
            &self.ctx.db,
            req.concept_id,
            req.image_id,
            &self.ctx.model_manager,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptResult {
            concept: Some(concept.into()),
        }))
    }

    async fn rescan_concept(
        &self,
        request: TonicRequest<RescanConceptRequest>,
    ) -> Result<TonicResponse<ConceptRescannedResult>, Status> {
        let req = request.into_inner();
        let tagged_count = handlers::concepts::rescan_concept_logic(
            &self.ctx.db,
            req.concept_id,
            &self.ctx.model_manager,
            &self.ctx.vector_index,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptRescannedResult {
            concept_id: req.concept_id,
            tagged_count: tagged_count as u32,
        }))
    }

    async fn get_concept_samples(
        &self,
        request: TonicRequest<RescanConceptRequest>,
    ) -> Result<TonicResponse<ConceptSamplesResult>, Status> {
        let req = request.into_inner();
        let preferred_source = {
            let s = self.ctx.settings.lock().await;
            s.preferred_tagger.source_name().to_string()
        };
        let samples = handlers::concepts::get_concept_samples_logic(
            &self.ctx.db,
            req.concept_id,
            &preferred_source,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ConceptSamplesResult {
            concept_id: req.concept_id,
            samples: samples.into_iter().map(Into::into).collect(),
        }))
    }

    async fn clean_auto_concept_tags(
        &self,
        request: TonicRequest<CleanAutoConceptTagsRequest>,
    ) -> Result<TonicResponse<AutoConceptTagsCleanedResult>, Status> {
        let req = request.into_inner();
        let cleaned_count = handlers::concepts::clean_auto_concept_tags_logic(&self.ctx.db, req.concept_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(AutoConceptTagsCleanedResult { cleaned_count }))
    }
}
