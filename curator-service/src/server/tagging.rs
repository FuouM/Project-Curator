use crate::handlers;
use crate::server::convert;
use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::common as commonpb;
use curator_core::grpc::tagging::{
    tagging_service_server::TaggingService, EphemeralTagImageRequest, EphemeralTagResult,
    TagImageBatchRequest, TagImageRequest, TagImageResult, TaggerStatusResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct TaggingServiceImpl {
    ctx: Arc<ClientContext>,
}

impl TaggingServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl TaggingService for TaggingServiceImpl {
    async fn tag_image(
        &self,
        request: TonicRequest<TagImageRequest>,
    ) -> Result<TonicResponse<TagImageResult>, Status> {
        let req = request.into_inner();
        let preferred = { self.ctx.settings.lock().await.preferred_tagger };
        let model = convert::tagger_from_proto(req.tagger).unwrap_or(preferred);
        let engine = self.ctx.taggers.engine(&model);
        let threshold = req.threshold.unwrap_or(engine.spec().default_threshold);
        let force = req.force.unwrap_or(false);
        let outcome = handlers::image::tag_image_logic(req.image_id, threshold, force, &self.ctx.db, engine)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(TagImageResult {
            image_id: req.image_id,
            tags_applied: outcome.tags_applied as u32,
            skipped: outcome.skipped,
            tags: outcome.tags.into_iter().map(Into::into).collect(),
        }))
    }

    async fn tag_image_batch(
        &self,
        request: TonicRequest<TagImageBatchRequest>,
    ) -> Result<TonicResponse<commonpb::BatchTagResult>, Status> {
        let req = request.into_inner();
        let (processed, failed, skipped) = handlers::tagging::tag_image_batch_logic(
            req.image_ids,
            req.threshold,
            req.force,
            convert::tagger_from_proto(req.tagger),
            &self.ctx.settings,
            &self.ctx.taggers,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(commonpb::BatchTagResult {
            processed: processed as u32,
            failed: failed as u32,
            skipped: skipped as u32,
        }))
    }

    async fn get_tagger_status(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<TaggerStatusResult>, Status> {
        let preferred = { self.ctx.settings.lock().await.preferred_tagger };
        Ok(TonicResponse::new(TaggerStatusResult {
            preferred_tagger: convert::tagger_to_proto(preferred),
            taggers: self.ctx.taggers.statuses().into_iter().map(Into::into).collect(),
        }))
    }

    async fn ephemeral_tag_image(
        &self,
        request: TonicRequest<EphemeralTagImageRequest>,
    ) -> Result<TonicResponse<EphemeralTagResult>, Status> {
        let req = request.into_inner();
        let (path, tags) = handlers::tagging::ephemeral_tag_image_logic(
            req.path,
            req.threshold,
            convert::tagger_from_proto(req.tagger),
            &self.ctx.settings,
            &self.ctx.taggers,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(EphemeralTagResult {
            path,
            tags: tags.into_iter().map(Into::into).collect(),
        }))
    }
}
