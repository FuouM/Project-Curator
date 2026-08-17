use crate::ClientContext;
use crate::handlers;
use crate::server::internal_status;
use curator_core::grpc::common as commonpb;
use curator_core::grpc::models::{
    ConversionLogsResult, ConversionStatusUpdate, DownloadProgressResult, DownloadStatusUpdate,
    FFmpegStatusResult, GetMediaMetadataRequest, MediaMetadataResult, ModelActionResult,
    ModelIdRequest, ModelStatusResult, QuantizeModelRequest, SetFFmpegPathRequest,
    models_service_server::ModelsService,
};
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct ModelsServiceImpl {
    ctx: Arc<ClientContext>,
}

impl ModelsServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

fn is_terminal_download_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

/// Build a Server-streaming response that polls `progress` for `key` every
/// 250 ms, emitting each snapshot, and ends once the download reaches a
/// terminal status. Shared by the model-download and FFmpeg-download streams.
fn download_status_stream(
    progress: handlers::models::DownloadProgressMap,
    key: String,
) -> tonic::Response<ReceiverStream<Result<DownloadStatusUpdate, Status>>> {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    tokio::spawn(async move {
        loop {
            let snapshot = {
                let map = progress.lock().await;
                map.get(&key).cloned()
            };
            if let Some(p) = snapshot {
                let done = is_terminal_download_status(&p.status);
                let _ = tx
                    .send(Ok(DownloadStatusUpdate {
                        progress: Some(p.into()),
                        complete: done,
                    }))
                    .await;
                if done {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
    tonic::Response::new(ReceiverStream::new(rx))
}

#[tonic::async_trait]
impl ModelsService for ModelsServiceImpl {
    async fn get_model_status(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ModelStatusResult>, Status> {
        let models = handlers::models::get_model_status(
            &self.ctx.data_dir.join("models"),
            &self.ctx.download_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ModelStatusResult {
            models: models.into_iter().map(Into::into).collect(),
        }))
    }

    type DownloadModelStream = ReceiverStream<Result<DownloadStatusUpdate, Status>>;

    async fn download_model(
        &self,
        request: TonicRequest<ModelIdRequest>,
    ) -> Result<TonicResponse<Self::DownloadModelStream>, Status> {
        let req = request.into_inner();
        let outcome = handlers::models::download_model(
            &self.ctx.data_dir.join("models"),
            &req.model_id,
            &self.ctx.download_progress,
            &self.ctx.cancel_tokens,
        )
        .await
        .map_err(internal_status)?;
        if !outcome.success {
            return Err(internal_status(outcome.message));
        }

        Ok(download_status_stream(
            self.ctx.download_progress.clone(),
            req.model_id,
        ))
    }

    async fn cancel_download(
        &self,
        request: TonicRequest<ModelIdRequest>,
    ) -> Result<TonicResponse<ModelActionResult>, Status> {
        let req = request.into_inner();
        let outcome = handlers::models::cancel_download(
            &req.model_id,
            &self.ctx.download_progress,
            &self.ctx.cancel_tokens,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ModelActionResult {
            success: outcome.success,
            message: outcome.message,
        }))
    }

    async fn remove_model(
        &self,
        request: TonicRequest<ModelIdRequest>,
    ) -> Result<TonicResponse<ModelActionResult>, Status> {
        let req = request.into_inner();
        let outcome =
            handlers::models::remove_model(&self.ctx.data_dir.join("models"), &req.model_id)
                .await
                .map_err(internal_status)?;
        Ok(TonicResponse::new(ModelActionResult {
            success: outcome.success,
            message: outcome.message,
        }))
    }

    async fn get_download_progress(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DownloadProgressResult>, Status> {
        let downloads = handlers::models::get_download_progress(&self.ctx.download_progress)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(DownloadProgressResult {
            downloads: downloads.into_iter().map(Into::into).collect(),
        }))
    }

    async fn quantize_model(
        &self,
        request: TonicRequest<QuantizeModelRequest>,
    ) -> Result<TonicResponse<ModelActionResult>, Status> {
        let req = request.into_inner();
        let outcome = handlers::models::quantize_model(
            &self.ctx.data_dir.join("models"),
            &req.model_id,
            &req.format,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ModelActionResult {
            success: outcome.success,
            message: outcome.message,
        }))
    }

    type ConvertModelStream = ReceiverStream<Result<ConversionStatusUpdate, Status>>;

    async fn convert_model(
        &self,
        request: TonicRequest<ModelIdRequest>,
    ) -> Result<TonicResponse<Self::ConvertModelStream>, Status> {
        let req = request.into_inner();
        let outcome =
            handlers::models::convert_model(&self.ctx.data_dir.join("models"), &req.model_id)
                .await
                .map_err(internal_status)?;
        if !outcome.success {
            // Nothing started — emit a single terminal update carrying the reason.
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let _ = tx
                .send(Ok(ConversionStatusUpdate {
                    logs: outcome.message,
                    complete: true,
                }))
                .await;
            return Ok(TonicResponse::new(ReceiverStream::new(rx)));
        }

        let ctx = self.ctx.clone();
        let model_id = req.model_id;
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                let logs =
                    handlers::models::get_conversion_logs(&ctx.data_dir.join("models"), &model_id)
                        .await;
                match logs {
                    Ok(logs) => {
                        let complete = !logs.is_running;
                        let _ = tx
                            .send(Ok(ConversionStatusUpdate {
                                logs: logs.logs,
                                complete,
                            }))
                            .await;
                        if complete {
                            break;
                        }
                    }
                    Err(_) => break,
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        });
        Ok(TonicResponse::new(ReceiverStream::new(rx)))
    }

    async fn get_conversion_logs(
        &self,
        request: TonicRequest<ModelIdRequest>,
    ) -> Result<TonicResponse<ConversionLogsResult>, Status> {
        let req = request.into_inner();
        let logs =
            handlers::models::get_conversion_logs(&self.ctx.data_dir.join("models"), &req.model_id)
                .await
                .map_err(internal_status)?;
        Ok(TonicResponse::new(ConversionLogsResult {
            logs: logs.logs,
            is_running: logs.is_running,
        }))
    }

    type DownloadFFmpegStream = ReceiverStream<Result<DownloadStatusUpdate, Status>>;

    async fn download_f_fmpeg(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<Self::DownloadFFmpegStream>, Status> {
        const FFMPEG_DOWNLOAD_ID: &str = "ffmpeg-portable";

        let outcome = handlers::models::download_ffmpeg(
            &self.ctx.data_dir,
            &self.ctx.download_progress,
            &self.ctx.cancel_tokens,
        )
        .await
        .map_err(internal_status)?;
        if !outcome.started {
            // Nothing started — emit a single terminal update carrying the reason.
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let _ = tx
                .send(Ok(DownloadStatusUpdate {
                    progress: Some(commonpb::DownloadProgress {
                        model_id: FFMPEG_DOWNLOAD_ID.to_string(),
                        status: "failed".to_string(),
                        error: Some(outcome.message),
                        ..Default::default()
                    }),
                    complete: true,
                }))
                .await;
            return Ok(TonicResponse::new(ReceiverStream::new(rx)));
        }

        Ok(download_status_stream(
            self.ctx.download_progress.clone(),
            FFMPEG_DOWNLOAD_ID.to_string(),
        ))
    }

    async fn get_f_fmpeg_status(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<FFmpegStatusResult>, Status> {
        let status = handlers::ffmpeg::get_ffmpeg_status(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(FFmpegStatusResult {
            resolved_path: status.resolved_path,
            version: status.version,
            available: status.available,
            portable_path: status.portable_path,
        }))
    }

    async fn set_f_fmpeg_path(
        &self,
        request: TonicRequest<SetFFmpegPathRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::ffmpeg::set_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings, req.path)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn get_media_metadata(
        &self,
        request: TonicRequest<GetMediaMetadataRequest>,
    ) -> Result<TonicResponse<MediaMetadataResult>, Status> {
        let req = request.into_inner();
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        let resolved = handlers::resolve_relative_path(&self.ctx.data_dir, &req.path);
        let meta =
            curator_core::transcode::read_media_metadata(std::path::Path::new(&resolved), &ffmpeg)
                .map_err(internal_status)?;
        Ok(TonicResponse::new(MediaMetadataResult {
            duration_ms: meta.duration_ms,
            fps: meta.fps,
            total_frames: meta.total_frames,
        }))
    }
}
