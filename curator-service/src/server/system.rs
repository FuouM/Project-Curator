use crate::handlers;
use crate::server::convert;
use crate::server::preferred_source;
use crate::ClientContext;
use curator_core::grpc::system::{
    system_service_server::SystemService, DashboardInitResult, RandomImageResult,
    ReindexFailedVectorsResult, ReindexVectorsResult, SettingsResult, StatusResult,
    UpdateSettingsRequest,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct SystemServiceImpl {
    ctx: Arc<ClientContext>,
}

impl SystemServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl SystemService for SystemServiceImpl {
    async fn ping(&self, _request: TonicRequest<()>) -> Result<TonicResponse<()>, Status> {
        Ok(TonicResponse::new(()))
    }

    async fn get_status(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<StatusResult>, Status> {
        let active = { self.ctx.settings.lock().await.embedding_model };
        let (image_count, vector_count, pending_jobs, preprocessing_jobs, ram_usage_bytes) =
            handlers::settings::query_status(&self.ctx.db, active)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(StatusResult {
            image_count,
            vector_count,
            pending_jobs,
            preprocessing_jobs,
            ram_usage_bytes,
        }))
    }

    async fn get_dashboard_init(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DashboardInitResult>, Status> {
        let preferred = preferred_source(&self.ctx).await;
        let d = handlers::dashboard::get_dashboard_init_logic(
            &self.ctx.db,
            &self.ctx.data_dir,
            &self.ctx.settings,
            &self.ctx.taggers,
            &preferred,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(DashboardInitResult {
            image_count: d.image_count,
            vector_count: d.vector_count,
            pending_jobs: d.pending_jobs,
            preprocessing_jobs: d.preprocessing_jobs,
            tagger_loaded: d.tagger_loaded,
            tagger_model_path: d.tagger_model_path,
            tagger_total_tags: d.tagger_total_tags as u32,
            clip_device: convert::device_to_proto(&d.clip_device),
            tagger_device: convert::device_to_proto(&d.tagger_device),
            tagger_wd_device: convert::device_to_proto(&d.tagger_wd_device),
            idle_timeout_secs: d.idle_timeout_secs,
            embedding_model: convert::embedding_to_proto(d.embedding_model),
            detection_device: convert::device_to_proto(&d.detection_device),
            detection_metrics_device: convert::device_to_proto(&d.detection_metrics_device),
            ocr_device: convert::device_to_proto(&d.ocr_device),
            model_precisions: d
                .model_precisions
                .iter()
                .map(|(k, v)| (k.clone(), convert::precision_to_proto(v)))
                .collect(),
            preferred_tagger: convert::tagger_to_proto(d.preferred_tagger),
            taggers: d.taggers.into_iter().map(Into::into).collect(),
            featured_images: d.featured_images.into_iter().map(Into::into).collect(),
            latest_images: d.latest_images.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_random_image(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<RandomImageResult>, Status> {
        let preferred = preferred_source(&self.ctx).await;
        let (image, index) = handlers::image::get_random_image_logic(&self.ctx.db, &preferred)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(RandomImageResult {
            image: Some(image.into()),
            index,
        }))
    }

    async fn get_settings(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<SettingsResult>, Status> {
        let s = self.ctx.settings.lock().await;
        Ok(TonicResponse::new(SettingsResult {
            clip_device: convert::device_to_proto(&s.clip_device),
            tagger_device: convert::device_to_proto(&s.tagger_device),
            tagger_wd_device: convert::device_to_proto(&s.tagger_wd_device),
            idle_timeout_secs: s.idle_timeout_secs,
            embedding_model: convert::embedding_to_proto(s.embedding_model),
            detection_device: convert::device_to_proto(&s.detection_device),
            detection_metrics_device: convert::device_to_proto(&s.detection_metrics_device),
            ocr_device: convert::device_to_proto(&s.ocr_device),
            model_precisions: s
                .model_precisions
                .iter()
                .map(|(k, v)| (k.clone(), convert::precision_to_proto(v)))
                .collect(),
            preferred_tagger: convert::tagger_to_proto(s.preferred_tagger),
            taggers: self.ctx.taggers.statuses().into_iter().map(Into::into).collect(),
        }))
    }

    async fn update_settings(
        &self,
        request: TonicRequest<UpdateSettingsRequest>,
    ) -> Result<TonicResponse<SettingsResult>, Status> {
        let req = request.into_inner();
        let model_precisions = if req.model_precisions.is_empty() {
            None
        } else {
            Some(
                req.model_precisions
                    .iter()
                    .map(|(k, v)| (k.clone(), convert::precision_from_proto(*v)))
                    .collect(),
            )
        };
        let s = handlers::settings::update_settings_logic(handlers::settings::UpdateSettingsParams {
            db: &self.ctx.db,
            model_manager: &self.ctx.model_manager,
            vector_index: &self.ctx.vector_index,
            taggers: &self.ctx.taggers,
            data_dir: &self.ctx.data_dir,
            settings: &self.ctx.settings,
            clip_device: req.clip_device.map(convert::device_from_proto),
            tagger_device: req.tagger_device.map(convert::device_from_proto),
            tagger_wd_device: req.tagger_wd_device.map(convert::device_from_proto),
            idle_timeout_secs: req.idle_timeout_secs,
            embedding_model: req.embedding_model.map(convert::embedding_from_proto),
            detection_device: req.detection_device.map(convert::device_from_proto),
            detection_metrics_device: req
                .detection_metrics_device
                .map(convert::device_from_proto),
            ocr_device: req.ocr_device.map(convert::device_from_proto),
            model_precisions,
            preferred_tagger: convert::tagger_from_proto(req.preferred_tagger),
        })
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(SettingsResult {
            clip_device: convert::device_to_proto(&s.clip_device),
            tagger_device: convert::device_to_proto(&s.tagger_device),
            tagger_wd_device: convert::device_to_proto(&s.tagger_wd_device),
            idle_timeout_secs: s.idle_timeout_secs,
            embedding_model: convert::embedding_to_proto(s.embedding_model),
            detection_device: convert::device_to_proto(&s.detection_device),
            detection_metrics_device: convert::device_to_proto(&s.detection_metrics_device),
            ocr_device: convert::device_to_proto(&s.ocr_device),
            model_precisions: s
                .model_precisions
                .iter()
                .map(|(k, v)| (k.clone(), convert::precision_to_proto(v)))
                .collect(),
            preferred_tagger: convert::tagger_to_proto(s.preferred_tagger),
            taggers: self.ctx.taggers.statuses().into_iter().map(Into::into).collect(),
        }))
    }

    async fn reindex_vectors(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ReindexVectorsResult>, Status> {
        let active = self.ctx.model_manager.active_model();
        handlers::tags::reindex_vectors_logic(&self.ctx.db, &self.ctx.vector_index, active)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ReindexVectorsResult { started: true }))
    }

    async fn reindex_failed_vectors(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ReindexFailedVectorsResult>, Status> {
        let active = self.ctx.model_manager.active_model();
        let requeued = handlers::tags::reindex_failed_vectors_logic(&self.ctx.db, active)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ReindexFailedVectorsResult { requeued }))
    }
}
