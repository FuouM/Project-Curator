use crate::ClientContext;
use crate::handlers;
use crate::server::internal_status;
use curator_core::grpc::tools::{
    BenchmarkImagesResult, BenchmarkSingleImageRequest, CheckToolRequest, ConvertImagesResult,
    CreateGifFromImagesRequest, EphemeralConvertImagesRequest, GetBenchmarkImagesRequest,
    GetToolInstallProgressRequest, GetTranscodeProgressRequest, ImageProcessingBenchmarkProgress,
    InstallToolRequest, InstallToolResult, MediaTransformRequest, PathExistsRequest,
    PathExistsResult, ProcessGifEffectsRequest, RunImageProcessingBenchmarkRequest,
    SetToolPathRequest,
    SingleImageBenchmarkResult, SplitGifRequest, ToolInstallProgressResult, ToolStatusResult,
    TranscodeProgressResult, TranscodeVideoRequest, tools_service_server::ToolsService,
};
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct ToolsServiceImpl {
    ctx: Arc<ClientContext>,
}

impl ToolsServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl ToolsService for ToolsServiceImpl {
    async fn ephemeral_convert_images(
        &self,
        request: TonicRequest<EphemeralConvertImagesRequest>,
    ) -> Result<TonicResponse<ConvertImagesResult>, Status> {
        let req = request.into_inner();
        let conversions = req
            .conversions
            .into_iter()
            .map(|pair| (pair.source_path, pair.target_path))
            .collect();
        let converted = curator_core::convert::convert_images(
            conversions,
            req.quality as u8,
            req.max_dimension,
            req.max_bytes.map(|v| v as u64),
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ConvertImagesResult { converted }))
    }

    async fn path_exists(
        &self,
        request: TonicRequest<PathExistsRequest>,
    ) -> Result<TonicResponse<PathExistsResult>, Status> {
        let req = request.into_inner();
        let exists = std::path::Path::new(&req.path).exists();
        Ok(TonicResponse::new(PathExistsResult { exists }))
    }

    async fn transcode_video(
        &self,
        request: TonicRequest<TranscodeVideoRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        let resolved_input = handlers::resolve_relative_path(&self.ctx.data_dir, &req.input_path);
        let resolved_output = handlers::resolve_relative_path(&self.ctx.data_dir, &req.output_path);
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        let opts = curator_core::transcode::TranscodeOptions {
            vcodec: req.vcodec,
            acodec: req.acodec,
            crf: req.crf,
            video_bitrate: req.video_bitrate,
            preset: req.preset,
            target_size_mb: req.target_size_mb,
            audio_bitrate: req.audio_bitrate,
            mixdown: req.mixdown,
            sample_rate: req.sample_rate,
            custom_args: req.custom_args,
        };
        curator_core::transcode::start_transcode(
            &req.job_id,
            &resolved_input,
            &resolved_output,
            &req.target_format,
            opts,
            &ffmpeg,
            &self.ctx.transcode_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn get_transcode_progress(
        &self,
        request: TonicRequest<GetTranscodeProgressRequest>,
    ) -> Result<TonicResponse<TranscodeProgressResult>, Status> {
        let req = request.into_inner();
        let state = curator_core::transcode::get_transcode_progress(
            &req.job_id,
            &self.ctx.transcode_progress,
        )
        .await;
        Ok(TonicResponse::new(TranscodeProgressResult {
            job_id: req.job_id,
            running: state.running,
            percent: state.percent,
            fps: state.fps,
            x_speed: state.x_speed,
            out_time_ms: state.out_time_ms,
            output_path: state.output_path,
            error: state.error,
            command: state.command,
            input_size_bytes: state.input_size_bytes,
            output_size_bytes: state.output_size_bytes,
            output_video_size_bytes: state.output_video_size_bytes,
            output_audio_size_bytes: state.output_audio_size_bytes,
        }))
    }

    async fn create_gif_from_images(
        &self,
        request: TonicRequest<CreateGifFromImagesRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        let resolved_output = handlers::resolve_relative_path(&self.ctx.data_dir, &req.output_path);
        let resolved_pattern =
            handlers::resolve_relative_path(&self.ctx.data_dir, &req.image_pattern);
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        let opts = curator_core::gif::CreateGifOptions {
            frame_rate: Some(req.frame_rate),
            width: req.width,
            height: req.height,
            loop_count: req.loop_count,
        };
        curator_core::gif::create_gif_from_images(
            req.job_id,
            resolved_pattern,
            resolved_output,
            req.target_format,
            opts,
            &ffmpeg,
            &self.ctx.transcode_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn process_gif_effects(
        &self,
        request: TonicRequest<ProcessGifEffectsRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        let resolved_input = handlers::resolve_relative_path(&self.ctx.data_dir, &req.input_path);
        let resolved_output = handlers::resolve_relative_path(&self.ctx.data_dir, &req.output_path);
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        let opts = curator_core::gif::GifEffectsOptions {
            crop: req.crop,
            scale: req.scale,
            speed_multiplier: req.speed_multiplier,
            reverse: req.reverse,
            bounce: req.bounce,
            rotate: req.rotate,
            brightness: req.brightness,
            contrast: req.contrast,
            saturation: req.saturation,
            grayscale: req.grayscale,
            invert: req.invert,
            caption_image_base64: req.caption_image_base64,
            caption_image_height: req.caption_image_height,
            caption_style: req.caption_style,
            max_colors: req.max_colors,
            dither_type: req.dither_type,
            drop_frames_factor: req.drop_frames_factor,
            loop_count: req.loop_count,
            fps: req.fps,
            trim_start: req.trim_start,
            trim_end: req.trim_end,
        };
        curator_core::gif::process_gif_effects(
            req.job_id,
            resolved_input,
            resolved_output,
            req.target_format,
            opts,
            &ffmpeg,
            &self.ctx.transcode_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn split_gif(
        &self,
        request: TonicRequest<SplitGifRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        let resolved_input = handlers::resolve_relative_path(&self.ctx.data_dir, &req.input_path);
        let resolved_output_dir =
            handlers::resolve_relative_path(&self.ctx.data_dir, &req.output_dir);
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        curator_core::gif::split_gif(
            req.job_id,
            resolved_input,
            resolved_output_dir,
            &ffmpeg,
            &self.ctx.transcode_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn media_transform(
        &self,
        request: TonicRequest<MediaTransformRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        let resolved_input = handlers::resolve_relative_path(&self.ctx.data_dir, &req.input_path);
        let resolved_output = handlers::resolve_relative_path(&self.ctx.data_dir, &req.output_path);
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        curator_core::transcode::start_media_transform(
            &req.job_id,
            &resolved_input,
            &resolved_output,
            req.target_format.as_deref(),
            req.video_filters,
            req.custom_args,
            &ffmpeg,
            &self.ctx.transcode_progress,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn check_tool(
        &self,
        request: TonicRequest<CheckToolRequest>,
    ) -> Result<TonicResponse<ToolStatusResult>, Status> {
        let req = request.into_inner();
        let status = handlers::tools::check_tool(
            &self.ctx.data_dir,
            &self.ctx.settings,
            &req.tool,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(ToolStatusResult {
            tool: req.tool,
            available: status.available,
            resolved_path: status.resolved_path,
            version: status.version,
            portable_path: status.portable_path,
        }))
    }

    async fn set_tool_path(
        &self,
        request: TonicRequest<SetToolPathRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::tools::set_tool_path(
            &self.ctx.data_dir,
            &self.ctx.settings,
            &req.tool,
            req.path,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn install_tool(
        &self,
        request: TonicRequest<InstallToolRequest>,
    ) -> Result<TonicResponse<InstallToolResult>, Status> {
        let req = request.into_inner();
        let outcome = handlers::tools::install_tool(
            &self.ctx.data_dir,
            &req.tool,
            self.ctx.tool_install_progress.clone(),
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(InstallToolResult {
            started: outcome.started,
            error: outcome.error,
        }))
    }

    async fn get_tool_install_progress(
        &self,
        request: TonicRequest<GetToolInstallProgressRequest>,
    ) -> Result<TonicResponse<ToolInstallProgressResult>, Status> {
        let req = request.into_inner();
        let p = handlers::tools::get_tool_install_progress(
            &self.ctx.tool_install_progress,
            &req.tool,
        )
        .await;
        Ok(TonicResponse::new(ToolInstallProgressResult {
            tool: req.tool,
            status: p.status,
            percent: p.percent,
            logs: p.logs,
            error: p.error,
        }))
    }

    async fn get_benchmark_images(
        &self,
        request: TonicRequest<GetBenchmarkImagesRequest>,
    ) -> Result<TonicResponse<BenchmarkImagesResult>, Status> {
        let req = request.into_inner();
        let filepaths =
            handlers::benchmarks::get_benchmark_images(&self.ctx.db, req.limit as usize)
                .await
                .map_err(internal_status)?;
        Ok(TonicResponse::new(BenchmarkImagesResult { filepaths }))
    }

    async fn benchmark_single_image(
        &self,
        request: TonicRequest<BenchmarkSingleImageRequest>,
    ) -> Result<TonicResponse<SingleImageBenchmarkResult>, Status> {
        let req = request.into_inner();
        let res = handlers::benchmarks::run_single_image_benchmark(
            &self.ctx.model_manager,
            &req.filepath,
            &self.ctx.settings,
            &self.ctx.taggers,
        )
        .await
        .map_err(|e| {
            internal_status(format!(
                "Failed to benchmark image {:?}: {:?}",
                req.filepath, e
            ))
        })?;
        Ok(TonicResponse::new(SingleImageBenchmarkResult {
            read_time_ms: res.read_time_ms,
            decode_time_ms: res.decode_time_ms,
            thumbnail_time_ms: res.thumbnail_time_ms,
            clip_preprocess_time_ms: res.clip_preprocess_time_ms,
            tagger_preprocess_time_ms: res.tagger_preprocess_time_ms,
            yolo_preprocess_time_ms: res.yolo_preprocess_time_ms,
            ccip_extract_preprocess_time_ms: res.ccip_extract_preprocess_time_ms,
            ocr_det_preprocess_time_ms: res.ocr_det_preprocess_time_ms,
            ocr_rec_preprocess_time_ms: res.ocr_rec_preprocess_time_ms,
        }))
    }

    type RunImageProcessingBenchmarkStream =
        ReceiverStream<Result<ImageProcessingBenchmarkProgress, Status>>;

    async fn run_image_processing_benchmark(
        &self,
        request: TonicRequest<RunImageProcessingBenchmarkRequest>,
    ) -> Result<TonicResponse<Self::RunImageProcessingBenchmarkStream>, Status> {
        let req = request.into_inner();
        handlers::benchmarks::start_image_processing_benchmark(
            self.ctx.model_manager.clone(),
            req.filepaths,
            self.ctx.settings.clone(),
            self.ctx.taggers.clone(),
            self.ctx.benchmark_progress.clone(),
        )
        .await
        .map_err(internal_status)?;

        let progress = self.ctx.benchmark_progress.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                let snapshot = {
                    let slot = progress.lock().await;
                    slot.clone().unwrap_or_default()
                };
                let done = !snapshot.running;
                let _ = tx.send(Ok(progress_to_proto(&snapshot))).await;
                if done {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        Ok(TonicResponse::new(ReceiverStream::new(rx)))
    }

    async fn get_image_processing_benchmark_progress(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<ImageProcessingBenchmarkProgress>, Status> {
        let p = handlers::benchmarks::get_image_processing_benchmark_progress(
            &self.ctx.benchmark_progress,
        )
        .await;
        Ok(TonicResponse::new(progress_to_proto(&p)))
    }
}

fn progress_to_proto(
    p: &handlers::ImageProcessingBenchmarkProgress,
) -> ImageProcessingBenchmarkProgress {
    ImageProcessingBenchmarkProgress {
        running: p.running,
        processed: p.processed as u32,
        total: p.total as u32,
        read_time_ms: p.read_time_ms,
        decode_time_ms: p.decode_time_ms,
        thumbnail_time_ms: p.thumbnail_time_ms,
        clip_preprocess_time_ms: p.clip_preprocess_time_ms,
        tagger_preprocess_time_ms: p.tagger_preprocess_time_ms,
        yolo_preprocess_time_ms: p.yolo_preprocess_time_ms,
        ccip_extract_preprocess_time_ms: p.ccip_extract_preprocess_time_ms,
        ocr_det_preprocess_time_ms: p.ocr_det_preprocess_time_ms,
        ocr_rec_preprocess_time_ms: p.ocr_rec_preprocess_time_ms,
    }
}
