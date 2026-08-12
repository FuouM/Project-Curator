use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::characters::{
    characters_service_server::CharactersService, AddDetectionRequest, AddDetectionResult,
    AssignCharacterIdentityRequest, CharacterDetectionsResult, CharacterIdentitiesList,
    CharacterSearchBatchResult, CharacterSearchResult, CreateCharacterIdentityRequest,
    DeleteCharacterIdentityRequest, DeleteDetectionRequest, DetectionBatchResult,
    DetectionCropResult, DetectionCropsResult, EphemeralDetectCharactersRequest,
    EphemeralDetectionResult, GetDetectionCropRequest, GetDetectionCropsRequest, ImageIdRequest,
    ImageIdsRequest, IdentifyDetectionRequest, IdentifyDetectionResult, RenameCharacterIdentityRequest,
    SearchByCharacterBatchRequest, SearchByCharacterRequest, UnassignedDetectionsList,
    UpdateDetectionBoundingBoxRequest,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct CharactersServiceImpl {
    ctx: Arc<ClientContext>,
}

impl CharactersServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl CharactersService for CharactersServiceImpl {
    async fn detect_characters(
        &self,
        request: TonicRequest<ImageIdRequest>,
    ) -> Result<TonicResponse<curator_core::grpc::common::DetectionResult>, Status> {
        let req = request.into_inner();
        let result = self
            .ctx
            .detection
            .detect_image(req.image_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(
            curator_core::grpc::common::DetectionResult {
                image_id: result.image_id,
                detections: result.detections.into_iter().map(Into::into).collect(),
            },
        ))
    }

    async fn detect_characters_batch(
        &self,
        request: TonicRequest<ImageIdsRequest>,
    ) -> Result<TonicResponse<DetectionBatchResult>, Status> {
        let req = request.into_inner();
        let results = self
            .ctx
            .detection
            .detect_batch(&req.image_ids)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(DetectionBatchResult {
            results: results.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_character_detections(
        &self,
        request: TonicRequest<ImageIdRequest>,
    ) -> Result<TonicResponse<CharacterDetectionsResult>, Status> {
        let req = request.into_inner();
        let detections = self
            .ctx
            .detection
            .get_detections(req.image_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(CharacterDetectionsResult {
            image_id: req.image_id,
            detections: detections.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_character_detections_batch(
        &self,
        request: TonicRequest<ImageIdsRequest>,
    ) -> Result<TonicResponse<DetectionBatchResult>, Status> {
        let req = request.into_inner();
        let results = self
            .ctx
            .detection
            .get_detections_batch(&req.image_ids)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(DetectionBatchResult {
            results: results.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_detection_crop(
        &self,
        request: TonicRequest<GetDetectionCropRequest>,
    ) -> Result<TonicResponse<DetectionCropResult>, Status> {
        let req = request.into_inner();
        let bytes = self
            .ctx
            .detection
            .load_crop_jpeg(req.detection_id)
            .await
            .map_err(internal_status)?
            .ok_or_else(|| Status::not_found("Image file not found"))?;
        Ok(TonicResponse::new(DetectionCropResult {
            crop_webp_bytes: bytes,
        }))
    }

    async fn get_detection_crops(
        &self,
        request: TonicRequest<GetDetectionCropsRequest>,
    ) -> Result<TonicResponse<DetectionCropsResult>, Status> {
        let req = request.into_inner();
        let mut crops = Vec::with_capacity(req.detection_ids.len());
        for detection_id in req.detection_ids {
            if let Some(bytes) = self
                .ctx
                .detection
                .load_crop_jpeg(detection_id)
                .await
                .map_err(internal_status)?
            {
                crops.push(curator_core::detection::DetectionCropEntry {
                    detection_id,
                    crop_webp_bytes: bytes,
                });
            }
        }
        Ok(TonicResponse::new(DetectionCropsResult {
            crops: crops.into_iter().map(Into::into).collect(),
        }))
    }

    async fn assign_character_identity(
        &self,
        request: TonicRequest<AssignCharacterIdentityRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        self.ctx
            .detection
            .assign_identity(req.detection_id, req.identity_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn create_character_identity(
        &self,
        request: TonicRequest<CreateCharacterIdentityRequest>,
    ) -> Result<TonicResponse<CharacterIdentitiesList>, Status> {
        let req = request.into_inner();
        let id = self
            .ctx
            .detection
            .create_identity(req.name)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(CharacterIdentitiesList {
            identities: vec![curator_core::grpc::common::CharacterIdentity {
                id,
                name: String::new(),
                detection_count: 0,
                created_at: String::new(),
            }],
        }))
    }

    async fn rename_character_identity(
        &self,
        request: TonicRequest<RenameCharacterIdentityRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        self.ctx
            .detection
            .rename_identity(req.identity_id, req.name)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn delete_character_identity(
        &self,
        request: TonicRequest<DeleteCharacterIdentityRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        self.ctx
            .detection
            .delete_identity(req.identity_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn list_character_identities(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<CharacterIdentitiesList>, Status> {
        let identities = self
            .ctx
            .detection
            .list_identities()
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(CharacterIdentitiesList {
            identities: identities.into_iter().map(Into::into).collect(),
        }))
    }

    async fn reidentify_all_detections(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<curator_core::grpc::common::ReidentifyResult>, Status> {
        let result = self
            .ctx
            .detection
            .reidentify_all()
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(
            curator_core::grpc::common::ReidentifyResult {
                total_detections: result.total_detections as i64,
                matched: result.matched as i64,
                unmatched: result.unmatched as i64,
            },
        ))
    }

    async fn search_by_character(
        &self,
        request: TonicRequest<SearchByCharacterRequest>,
    ) -> Result<TonicResponse<CharacterSearchResult>, Status> {
        let req = request.into_inner();
        let image_ids = self
            .ctx
            .detection
            .search_by_character(req.identity_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(CharacterSearchResult { image_ids }))
    }

    async fn search_by_character_batch(
        &self,
        request: TonicRequest<SearchByCharacterBatchRequest>,
    ) -> Result<TonicResponse<CharacterSearchBatchResult>, Status> {
        let req = request.into_inner();
        let results = self
            .ctx
            .detection
            .search_by_character_batch(&req.identity_ids)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(CharacterSearchBatchResult {
            results: results.into_iter().map(Into::into).collect(),
        }))
    }

    async fn list_unassigned_detections(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<UnassignedDetectionsList>, Status> {
        let detections = self
            .ctx
            .detection
            .list_unassigned_detections()
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(UnassignedDetectionsList {
            detections: detections.into_iter().map(Into::into).collect(),
        }))
    }

    async fn delete_detection(
        &self,
        request: TonicRequest<DeleteDetectionRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        self.ctx
            .detection
            .delete_detection(req.detection_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn update_detection_bounding_box(
        &self,
        request: TonicRequest<UpdateDetectionBoundingBoxRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        self.ctx
            .detection
            .update_detection_bbox(req.detection_id, req.x0, req.y0, req.x1, req.y1)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn add_detection(
        &self,
        request: TonicRequest<AddDetectionRequest>,
    ) -> Result<TonicResponse<AddDetectionResult>, Status> {
        let req = request.into_inner();
        let detection = self
            .ctx
            .detection
            .add_detection(req.image_id, req.x0, req.y0, req.x1, req.y1)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(AddDetectionResult {
            detection: Some(detection.into()),
        }))
    }

    async fn identify_detection(
        &self,
        request: TonicRequest<IdentifyDetectionRequest>,
    ) -> Result<TonicResponse<IdentifyDetectionResult>, Status> {
        let req = request.into_inner();
        let identity_id = self
            .ctx
            .detection
            .identify_detection(req.detection_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(IdentifyDetectionResult { identity_id }))
    }

    async fn ephemeral_detect_characters(
        &self,
        request: TonicRequest<EphemeralDetectCharactersRequest>,
    ) -> Result<TonicResponse<EphemeralDetectionResult>, Status> {
        let req = request.into_inner();
        let path_obj = std::path::Path::new(&req.path);
        let detections = self
            .ctx
            .detection
            .detect_image_path(path_obj)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(EphemeralDetectionResult {
            path: req.path,
            detections: detections.into_iter().map(Into::into).collect(),
        }))
    }

    async fn clear_crop_cache(&self, _request: TonicRequest<()>) -> Result<TonicResponse<()>, Status> {
        self.ctx
            .detection
            .crop_cache
            .clear()
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }
}

