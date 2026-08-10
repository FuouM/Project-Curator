use crate::handlers;
use crate::ClientContext;
use curator_core::grpc::ocr::{
    ocr_service_server::OcrService, EphemeralOcrResult, EphemeralRunOcrRequest, ImageIdRequest,
    OcrDetectionsResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct OcrServiceImpl {
    ctx: Arc<ClientContext>,
}

impl OcrServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl OcrService for OcrServiceImpl {
    async fn run_ocr(
        &self,
        request: TonicRequest<ImageIdRequest>,
    ) -> Result<TonicResponse<OcrDetectionsResult>, Status> {
        let req = request.into_inner();
        let (image_id, detections, bubble_boxes) =
            handlers::ocr::run_ocr_logic(req.image_id, &self.ctx.db, &self.ctx.ocr)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(OcrDetectionsResult {
            image_id,
            detections: detections.into_iter().map(Into::into).collect(),
            bubble_boxes: bubble_boxes.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_ocr_detections(
        &self,
        request: TonicRequest<ImageIdRequest>,
    ) -> Result<TonicResponse<OcrDetectionsResult>, Status> {
        let req = request.into_inner();
        let (image_id, detections, bubble_boxes) =
            handlers::ocr::get_ocr_detections_logic(req.image_id, &self.ctx.db)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(OcrDetectionsResult {
            image_id,
            detections: detections.into_iter().map(Into::into).collect(),
            bubble_boxes: bubble_boxes.into_iter().map(Into::into).collect(),
        }))
    }

    async fn ephemeral_run_ocr(
        &self,
        request: TonicRequest<EphemeralRunOcrRequest>,
    ) -> Result<TonicResponse<EphemeralOcrResult>, Status> {
        let req = request.into_inner();
        let (path, detections, bubble_boxes) =
            handlers::ocr::ephemeral_run_ocr_logic(req.path, &self.ctx.ocr)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(EphemeralOcrResult {
            path,
            detections: detections.into_iter().map(Into::into).collect(),
            bubble_boxes: bubble_boxes.into_iter().map(Into::into).collect(),
        }))
    }
}
