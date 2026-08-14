use crate::handlers;
use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::gallery::{
    gallery_service_server::GalleryService, ClearThumbnailCacheResult, GetImageRequest,
    GetThumbnailRequest, ImageResult, ListImagesRequest, ListResult, PurgeResult,
    SetFavoriteRequest, SetNoteRequest, ThumbnailResult,
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
        let image =
            handlers::image::get_image_logic(req.image_id, &preferred_source, &self.ctx.db)
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
        let (images, total_count) = handlers::image::list_images_logic(
            req.limit as usize,
            req.offset as usize,
            req.only_favorites,
            &preferred_source,
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
        handlers::tags::set_favorite_logic(req.image_id, req.favorite, &self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn set_note(
        &self,
        request: TonicRequest<SetNoteRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::image::set_note_logic(req.image_id, req.note, &self.ctx.db)
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
        let deleted_count =
            handlers::image::purge_missing_thumbnails_logic(&self.ctx.thumbnail_cache, &self.ctx.db)
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
        Ok(TonicResponse::new(ClearThumbnailCacheResult { deleted_count }))
    }
}
