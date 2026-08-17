use crate::ClientContext;
use crate::handlers;
use crate::server::internal_status;
use curator_core::grpc::gallery::{
    ClearThumbnailCacheResult, GetImageRequest, GetThumbnailRequest, ImageResult,
    ListImagesRequest, ListResult, PurgeResult, SetFavoriteRequest, SetNoteRequest,
    ThumbnailResult, gallery_service_server::GalleryService,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct GalleryServiceImpl {
    ctx: Arc<ClientContext>,
}

impl GalleryServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl GalleryService for GalleryServiceImpl {
    async fn get_image(
        &self,
        request: TonicRequest<GetImageRequest>,
    ) -> Result<TonicResponse<ImageResult>, Status> {
        let req = request.into_inner();
        let preferred_source = super::preferred_source(&self.ctx).await;
        let vector_source = self.ctx.settings.lock().await.embedding_model.source_name().to_string();
        let image = curator_core::ImageRepo::get_image(
            req.image_id,
            &preferred_source,
            &vector_source,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ImageResult {
            image: Some(image.into()),
        }))
    }

    async fn list_images(
        &self,
        request: TonicRequest<ListImagesRequest>,
    ) -> Result<TonicResponse<ListResult>, Status> {
        let req = request.into_inner();
        let preferred_source = super::preferred_source(&self.ctx).await;
        let vector_source = self.ctx.settings.lock().await.embedding_model.source_name().to_string();
        let (images, total_count) = curator_core::ImageRepo::list_images(
            req.limit as usize,
            req.offset as usize,
            req.only_favorites,
            &preferred_source,
            &vector_source,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ListResult {
            images: images.into_iter().map(Into::into).collect(),
            total_count,
        }))
    }

    async fn set_favorite(
        &self,
        request: TonicRequest<SetFavoriteRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        curator_core::ImageRepo::set_favorite(&self.ctx.db, req.image_id, req.favorite)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn set_note(
        &self,
        request: TonicRequest<SetNoteRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        curator_core::ImageRepo::set_note(&self.ctx.db, req.image_id, req.note)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn get_thumbnail(
        &self,
        request: TonicRequest<GetThumbnailRequest>,
    ) -> Result<TonicResponse<ThumbnailResult>, Status> {
        let req = request.into_inner();
        let (data, is_missing) = handlers::image::get_thumbnail_logic(
            req.image_id,
            req.width,
            req.mtime,
            req.kind.map(|k| k as u8),
            &self.ctx.thumbnail_cache,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ThumbnailResult { data, is_missing }))
    }

    async fn purge_missing_thumbnails(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<PurgeResult>, Status> {
        let deleted_count = handlers::image::purge_missing_thumbnails_logic(
            &self.ctx.thumbnail_cache,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(PurgeResult { deleted_count }))
    }

    async fn clear_thumbnail_cache(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ClearThumbnailCacheResult>, Status> {
        let deleted_count = handlers::image::clear_thumbnails_logic(&self.ctx.thumbnail_cache)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(ClearThumbnailCacheResult {
            deleted_count,
        }))
    }
}
