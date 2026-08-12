use crate::handlers;
use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::common as commonpb;
use curator_core::grpc::tags::{
    tags_service_server::TagsService, AddTagRequest, BackfillTagSourceRequest, RemoveTagRequest,
    UnblacklistTagRequest,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct TagsServiceImpl {
    ctx: Arc<ClientContext>,
}

impl TagsServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl TagsService for TagsServiceImpl {
    async fn add_tag(
        &self,
        request: TonicRequest<AddTagRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::tags::add_tag_logic(req.image_id, &req.tag, &req.category, &self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn remove_tag(
        &self,
        request: TonicRequest<RemoveTagRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::tags::remove_tag_logic(req.image_id, &req.tag, &self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn unblacklist_tag(
        &self,
        request: TonicRequest<UnblacklistTagRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::tags::unblacklist_tag_logic(req.image_id, &req.tag, &self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn get_tag_statistics(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<commonpb::TagStatisticsResult>, Status> {
        let preferred_source = super::preferred_source(&self.ctx).await;
        let tags = handlers::tags::get_tag_statistics_logic(&preferred_source, &self.ctx.db)
            .await
            .map_err(|e| internal_status(format!("Failed to fetch tag statistics: {:?}", e)))?;
        Ok(TonicResponse::new(commonpb::TagStatisticsResult {
            tags: tags.into_iter().map(Into::into).collect(),
        }))
    }

    async fn backfill_tag_source(
        &self,
        request: TonicRequest<BackfillTagSourceRequest>,
    ) -> Result<TonicResponse<commonpb::BatchTagResult>, Status> {
        let req = request.into_inner();
        let from_tagger = crate::server::convert::tagger_from_proto(Some(req.from_tagger))
            .ok_or_else(|| Status::invalid_argument("invalid from_tagger"))?;
        let to_tagger = crate::server::convert::tagger_from_proto(Some(req.to_tagger))
            .ok_or_else(|| Status::invalid_argument("invalid to_tagger"))?;
        if from_tagger == to_tagger {
            return Err(Status::invalid_argument(
                "from_tagger and to_tagger must differ",
            ));
        }
        let to_engine = self.ctx.taggers.engine(&to_tagger);
        let to_source = to_tagger.source_name();
        let threshold = to_engine.spec().default_threshold;
        let result = handlers::image::backfill_tag_source_logic(
            &self.ctx.db,
            from_tagger.source_name(),
            to_source,
            to_engine,
            threshold,
        )
        .await
        .map_err(|e| {
            tracing::error!("BackfillTagSource failed: {:?}", e);
            internal_status(e)
        })?;
        Ok(TonicResponse::new(commonpb::BatchTagResult {
            processed: result.processed as u32,
            failed: result.failed as u32,
            skipped: result.skipped as u32,
        }))
    }
}
