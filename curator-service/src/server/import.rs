use crate::ClientContext;
use crate::handlers;
use crate::server::internal_status;
use curator_core::grpc::import::{
    BackfillResult, CancelImportResult, ClassifyFolderSafetyRequest, ClassifyFolderSafetyResult,
    EphemeralClassifySafetyRequest, EphemeralClassifySafetyResult, ImportImageRequest,
    ImportProgress, ImportResult, ImportedFoldersResult, IndexFolderRequest, IndexFolderResult,
    MediaMetadataBackfillResult, RescanFolderRequest, RescanFolderResult, RescanSafetyResult,
    SafetyRescanProgress, import_service_server::ImportService,
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
        let paths: Vec<String> = if !req.paths.is_empty() {
            req.paths
        } else if !req.path.is_empty() {
            req.path
                .split(|c| c == ';' || c == '\n' || c == '\r')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            Vec::new()
        };

        // Import performs a long burst of SQLite writes; serialize against
        // concurrent scan/import operations (see `dispatch`).
        let _write_guard = self.ctx.import_lock.lock().await;
        let active = self.active_embedding_model().await;
        let ffmpeg = self.resolved_ffmpeg().await;
        let (image_id, sha256, imported_count, folder_ids) = handlers::import::import_paths_logic(
            &paths,
            &self.ctx.db,
            active,
            ffmpeg.as_deref(),
            &self.ctx.data_dir,
            &self.ctx.import_controller,
        )
        .await
        .map_err(internal_status)?;

        Ok(TonicResponse::new(ImportResult {
            image_id,
            sha256,
            imported_count: imported_count as u32,
            folder_id: folder_ids.first().copied(),
            folder_ids,
        }))
    }

    async fn get_import_progress(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ImportProgress>, Status> {
        let p = self.ctx.import_controller.get_progress();
        Ok(TonicResponse::new(ImportProgress {
            running: p.running,
            phase: p.phase,
            discovered_files: p.discovered_files,
            processed_files: p.processed_files,
            total_files: p.total_files,
            current_file: p.current_file,
            error_message: p.error_message,
        }))
    }

    async fn cancel_import(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<CancelImportResult>, Status> {
        let success = self.ctx.import_controller.request_cancel();
        let message = if success {
            "Cancellation requested".to_string()
        } else {
            "No import is currently running".to_string()
        };
        Ok(TonicResponse::new(CancelImportResult { success, message }))
    }

    async fn get_imported_folders(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ImportedFoldersResult>, Status> {
        let folders = curator_core::FolderRepo::get_imported_folders(&self.ctx.db)
            .await
            .map_err(internal_status)?;
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
            .map_err(internal_status)?;
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
        .map_err(internal_status)?;
        Ok(TonicResponse::new(MediaMetadataBackfillResult {
            processed,
            updated,
        }))
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
            &self.ctx.import_controller,
        )
        .await
        .map_err(internal_status)?;
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
            .map_err(internal_status)?;
        Ok(TonicResponse::new(IndexFolderResult {
            folder_id: req.folder_id,
            queued,
        }))
    }

    async fn rescan_safety(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<RescanSafetyResult>, Status> {
        let result = self
            .ctx
            .safety
            .start_rescan(self.ctx.db.clone())
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(result))
    }

    async fn classify_folder_safety(
        &self,
        request: TonicRequest<ClassifyFolderSafetyRequest>,
    ) -> Result<TonicResponse<ClassifyFolderSafetyResult>, Status> {
        let req = request.into_inner();
        let (processed, updated) = self
            .ctx
            .safety
            .classify_folder_safety(&self.ctx.db, req.folder_id)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(ClassifyFolderSafetyResult {
            folder_id: req.folder_id,
            processed,
            updated,
        }))
    }

    async fn get_safety_rescan_progress(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<SafetyRescanProgress>, Status> {
        let progress = self.ctx.safety.rescan_progress().await;
        Ok(TonicResponse::new(progress))
    }

    async fn ephemeral_classify_safety(
        &self,
        request: TonicRequest<EphemeralClassifySafetyRequest>,
    ) -> Result<TonicResponse<EphemeralClassifySafetyResult>, Status> {
        let req = request.into_inner();
        let c = self
            .ctx
            .safety
            .classify_path(&req.path)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(EphemeralClassifySafetyResult {
            path: req.path,
            safe_score: Some(c.safe_score),
            hentai_score: Some(c.hentai_score),
            porn_score: Some(c.porn_score),
            sexy_score: Some(c.sexy_score),
            drawing_score: Some(c.drawing_score),
        }))
    }
}
