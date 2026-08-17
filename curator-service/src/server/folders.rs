use crate::ClientContext;
use crate::server::internal_status;

use curator_core::grpc::folders::{
    DeleteFolderRequest, DeleteFolderResult, DuplicateFoldersResult, MergeFoldersRequest,
    MergeFoldersResult, StorageStatsResult, UpdateFolderPathRequest, UpdateFolderPathResult,
    folders_service_server::FoldersService,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct FoldersServiceImpl {
    ctx: Arc<ClientContext>,
}

impl FoldersServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl FoldersService for FoldersServiceImpl {
    async fn get_storage_stats(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<StorageStatsResult>, Status> {
        let stats = curator_core::ImageRepo::get_storage_stats(&self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(StorageStatsResult {
            stats: Some(stats.into()),
        }))
    }

    async fn update_folder_path(
        &self,
        request: TonicRequest<UpdateFolderPathRequest>,
    ) -> Result<TonicResponse<UpdateFolderPathResult>, Status> {
        let req = request.into_inner();
        let success =
            curator_core::FolderRepo::update_folder_path(req.id, &req.new_path, &self.ctx.db)
                .await
                .map_err(internal_status)?;
        Ok(TonicResponse::new(UpdateFolderPathResult { success }))
    }

    async fn delete_folder(
        &self,
        request: TonicRequest<DeleteFolderRequest>,
    ) -> Result<TonicResponse<DeleteFolderResult>, Status> {
        let req = request.into_inner();
        let success = curator_core::FolderRepo::delete_folder(req.id, &self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(DeleteFolderResult { success }))
    }

    async fn detect_duplicate_folders(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DuplicateFoldersResult>, Status> {
        let groups = curator_core::FolderRepo::detect_duplicate_folders(&self.ctx.db)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(DuplicateFoldersResult {
            groups: groups.into_iter().map(Into::into).collect(),
        }))
    }

    async fn merge_folders(
        &self,
        request: TonicRequest<MergeFoldersRequest>,
    ) -> Result<TonicResponse<MergeFoldersResult>, Status> {
        let req = request.into_inner();
        let _write_guard = self.ctx.import_lock.lock().await;
        let (success, images_moved) = curator_core::FolderRepo::merge_folders(
            req.keep_folder_id,
            req.merge_folder_id,
            &self.ctx.db,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(MergeFoldersResult {
            success,
            images_moved,
        }))
    }
}
