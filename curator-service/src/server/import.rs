use crate::handlers;
use crate::ClientContext;
use curator_core::grpc::import::{
    import_service_server::ImportService, BackfillResult, ImportImageRequest, ImportResult,
    ImportedFoldersResult, IndexFolderRequest, IndexFolderResult, MediaMetadataBackfillResult,
    RescanFolderRequest, RescanFolderResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct ImportServiceImpl {
    ctx: Arc<ClientContext>,
}

impl ImportServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }

    async fn active_embedding_model(&self) -> curator_core::ipc::EmbeddingModel {
        let s = self.ctx.settings.lock().await;
        s.embedding_model
    }

    async fn resolved_ffmpeg(&self) -> Option<std::path::PathBuf> {
        handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .ok()
    }
}

#[tonic::async_trait]
impl ImportService for ImportServiceImpl {
    async fn import_image(
        &self,
        request: TonicRequest<ImportImageRequest>,
    ) -> Result<TonicResponse<ImportResult>, Status> {
        let req = request.into_inner();
        // Import performs a long burst of SQLite writes; serialize against
        // concurrent scan/import operations (see `dispatch`).
        let _write_guard = self.ctx.import_lock.lock().await;
        let active = self.active_embedding_model().await;
        let ffmpeg = self.resolved_ffmpeg().await;
        let (image_id, sha256, imported_count, folder_id) =
            handlers::import::import_image_logic(
                &req.path,
                &self.ctx.db,
                active,
                ffmpeg.as_deref(),
                &self.ctx.data_dir,
            )
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ImportResult {
            image_id,
            sha256,
            imported_count: imported_count as u32,
            folder_id,
        }))
    }

    async fn get_imported_folders(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ImportedFoldersResult>, Status> {
        let folders = handlers::import::get_imported_folders_logic(&self.ctx.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(ImportedFoldersResult {
            folders: folders.into_iter().map(Into::into).collect(),
        }))
    }

    async fn backfill_image_folders(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<BackfillResult>, Status> {
        let _write_guard = self.ctx.import_lock.lock().await;
        let images_backfilled = handlers::import::backfill_image_folders(&self.ctx.db)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(BackfillResult { images_backfilled }))
    }

    async fn backfill_media_metadata(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<MediaMetadataBackfillResult>, Status> {
        let _write_guard = self.ctx.import_lock.lock().await;
        let ffmpeg = self.resolved_ffmpeg().await;
        let (processed, updated) = handlers::import::backfill_media_metadata(
            &self.ctx.db,
            ffmpeg.as_deref(),
            &self.ctx.data_dir,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(MediaMetadataBackfillResult { processed, updated }))
    }

    async fn rescan_folder(
        &self,
        request: TonicRequest<RescanFolderRequest>,
    ) -> Result<TonicResponse<RescanFolderResult>, Status> {
        let req = request.into_inner();
        let _write_guard = self.ctx.import_lock.lock().await;
        let active = self.active_embedding_model().await;
        let ffmpeg = self.resolved_ffmpeg().await;
        let (imported, found) = handlers::import::rescan_folder_logic(
            req.folder_id,
            &self.ctx.db,
            active,
            ffmpeg.as_deref(),
            &self.ctx.data_dir,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(RescanFolderResult {
            folder_id: req.folder_id,
            imported,
            found,
        }))
    }

    async fn index_folder(
        &self,
        request: TonicRequest<IndexFolderRequest>,
    ) -> Result<TonicResponse<IndexFolderResult>, Status> {
        let req = request.into_inner();
        let _write_guard = self.ctx.import_lock.lock().await;
        let active = self.active_embedding_model().await;
        let queued = handlers::import::index_folder_logic(req.folder_id, &self.ctx.db, active)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(TonicResponse::new(IndexFolderResult {
            folder_id: req.folder_id,
            queued,
        }))
    }
}
