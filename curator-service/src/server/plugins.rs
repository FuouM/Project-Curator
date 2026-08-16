use crate::handlers;
use crate::handlers::plugins::plugin_runtime_spec_exists;
use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::plugins::{
    plugins_service_server::PluginsService, InvokePluginRequest, InvokePluginResponse,
    PluginFileResult, PluginsListResult, ReadPluginFileRequest, SetPluginEnabledRequest,
    ValidatePluginRequest, ValidationResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct PluginsServiceImpl {
    ctx: Arc<ClientContext>,
}

impl PluginsServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

async fn dispatch_plugin_command(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    command: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    match command {
        "PathExists" => {
            let raw_path = params["path"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing path"))?;
            let path = handlers::resolve_relative_path(&ctx.data_dir, raw_path);
            let exists = handlers::misc::path_exists(&path)
                .await
                .map_err(internal_status)?;
            Ok(serde_json::json!({
                "PathExistsResult": { "exists": exists }
            }))
        }
        "GetTranscodeProgress" => {
            let job_id = params["job_id"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
            let progress = curator_core::transcode::get_transcode_progress(job_id, &ctx.transcode_progress).await;
            Ok(serde_json::json!({
                "TranscodeProgressResult": {
                    "running": progress.running,
                    "percent": progress.percent,
                    "fps": progress.fps,
                    "x_speed": progress.x_speed,
                    "out_time_ms": progress.out_time_ms,
                    "output_path": progress.output_path,
                    "error": progress.error,
                    "command": progress.command,
                    "input_size_bytes": progress.input_size_bytes,
                    "output_size_bytes": progress.output_size_bytes,
                    "output_video_size_bytes": progress.output_video_size_bytes,
                    "output_audio_size_bytes": progress.output_audio_size_bytes,
                }
            }))
        }
        "GetMediaMetadata" => {
            let path = params["path"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing path"))?;
            let resolved = handlers::resolve_relative_path(&ctx.data_dir, path);
            match handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings).await {
                Ok(ffmpeg) => {
                    match curator_core::transcode::read_media_metadata(std::path::Path::new(&resolved), &ffmpeg) {
                        Ok(meta) => Ok(serde_json::json!({
                            "MediaMetadataResult": {
                                "duration_ms": meta.duration_ms,
                                "fps": meta.fps,
                                "total_frames": meta.total_frames,
                            }
                        })),
                        Err(e) => Ok(serde_json::json!({
                            "Error": { "message": e.to_string() }
                        })),
                    }
                }
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }
        "EphemeralConvertImages" => {
            let quality = params["quality"].as_u64().unwrap_or(80) as u8;
            let conversions_array = params["conversions"]
                .as_array()
                .ok_or_else(|| Status::invalid_argument("missing conversions"))?;
            let mut conversions = Vec::new();
            for item in conversions_array {
                if let (Some(src), Some(dst)) = (item[0].as_str(), item[1].as_str()) {
                    let resolved_src = handlers::resolve_relative_path(&ctx.data_dir, src);
                    let resolved_dst = handlers::resolve_relative_path(&ctx.data_dir, dst);
                    conversions.push((resolved_src, resolved_dst));
                }
            }
            let converted = curator_core::convert::convert_images(conversions, quality)
                .await
                .map_err(internal_status)?;
            let converted_json: Vec<serde_json::Value> = converted
                .into_iter()
                .map(|c| serde_json::json!({
                    "source_path": c.source_path,
                    "output_path": c.output_path,
                    "error": c.error,
                }))
                .collect();
            Ok(serde_json::json!({
                "ConvertImagesResult": {
                    "converted": converted_json
                }
            }))
        }
        "TranscodeVideo" => {
            let job_id = params["job_id"].as_str().unwrap_or_default();
            let input_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["input_path"].as_str().unwrap_or_default(),
            );
            let output_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_path"].as_str().unwrap_or_default(),
            );
            let target_format = params["target_format"].as_str().unwrap_or_default();
            let vcodec = params["vcodec"].as_str().map(|s| s.to_string());
            let acodec = params["acodec"].as_str().map(|s| s.to_string());
            let crf = params["crf"].as_u64().map(|v| v as u32);
            let video_bitrate = params["video_bitrate"].as_u64().map(|v| v as u32);
            let preset = params["preset"].as_str().map(|s| s.to_string());
            let target_size_mb = params["target_size_mb"].as_f64();
            let audio_bitrate = params["audio_bitrate"].as_u64().map(|v| v as u32);
            let mixdown = params["mixdown"].as_str().map(|s| s.to_string());
            let sample_rate = params["sample_rate"].as_u64().map(|v| v as u32);
            let custom_args = params["custom_args"].as_str().map(|s| s.to_string());

            let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
                .await
                .map_err(internal_status)?;

            let opts = curator_core::transcode::TranscodeOptions {
                vcodec,
                acodec,
                crf,
                video_bitrate,
                preset,
                target_size_mb,
                audio_bitrate,
                mixdown,
                sample_rate,
                custom_args,
            };

            if let Err(e) = curator_core::transcode::start_transcode(
                job_id,
                &input_path,
                &output_path,
                target_format,
                opts,
                &ffmpeg,
                &ctx.transcode_progress,
            )
            .await
            {
                return Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                }));
            }
            Ok(serde_json::json!("Success"))
        }
        "CreateGifFromImages" => {
            let job_id = params["job_id"].as_str().unwrap_or_default();
            let image_pattern = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["image_pattern"].as_str().unwrap_or_default(),
            );
            let frame_rate = params["frame_rate"].as_f64().unwrap_or(10.0) as f32;
            let output_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_path"].as_str().unwrap_or_default(),
            );
            let width = params["width"].as_u64().map(|v| v as u32);
            let height = params["height"].as_u64().map(|v| v as u32);
            let loop_count = params["loop_count"].as_i64().map(|v| v as i32);
            let target_format = params["target_format"].as_str().unwrap_or("gif");

            let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
                .await
                .map_err(internal_status)?;

            let opts = curator_core::gif::CreateGifOptions {
                frame_rate: Some(frame_rate),
                width,
                height,
                loop_count,
            };

            if let Err(e) = curator_core::gif::create_gif_from_images(
                job_id.to_string(),
                image_pattern,
                output_path,
                target_format.to_string(),
                opts,
                &ffmpeg,
                &ctx.transcode_progress,
            )
            .await
            {
                return Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                }));
            }
            Ok(serde_json::json!("Success"))
        }
        "ProcessGifEffects" => {
            let job_id = params["job_id"].as_str().unwrap_or_default();
            let input_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["input_path"].as_str().unwrap_or_default(),
            );
            let output_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_path"].as_str().unwrap_or_default(),
            );
            let crop = params["crop"].as_str().map(|s| s.to_string());
            let scale = params["scale"].as_str().map(|s| s.to_string());
            let speed_multiplier = params["speed_multiplier"].as_f64().map(|v| v as f32);
            let reverse = params["reverse"].as_bool().unwrap_or(false);
            let bounce = params["bounce"].as_bool().unwrap_or(false);
            let rotate = params["rotate"].as_str().map(|s| s.to_string());
            let brightness = params["brightness"].as_f64().map(|v| v as f32);
            let contrast = params["contrast"].as_f64().map(|v| v as f32);
            let saturation = params["saturation"].as_f64().map(|v| v as f32);
            let grayscale = params["grayscale"].as_bool().unwrap_or(false);
            let invert = params["invert"].as_bool().unwrap_or(false);
            let caption_image_base64 = params["caption_image_base64"].as_str().map(|s| s.to_string());
            let caption_image_height = params["caption_image_height"].as_u64().map(|v| v as u32);
            let caption_style = params["caption_style"].as_str().map(|s| s.to_string());
            let max_colors = params["max_colors"].as_u64().map(|v| v as u32);
            let dither_type = params["dither_type"].as_str().map(|s| s.to_string());
            let drop_frames_factor = params["drop_frames_factor"].as_u64().map(|v| v as u32);
            let target_format = params["target_format"].as_str().unwrap_or("gif");
            let loop_count = params["loop_count"].as_i64().map(|v| v as i32);
            let fps = params["fps"].as_u64().map(|v| v as u32);
            let trim_start = params["trim_start"].as_f64();
            let trim_end = params["trim_end"].as_f64();

            let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
                .await
                .map_err(internal_status)?;

            let opts = curator_core::gif::GifEffectsOptions {
                crop,
                scale,
                speed_multiplier,
                reverse,
                bounce,
                rotate,
                brightness,
                contrast,
                saturation,
                grayscale,
                invert,
                caption_image_base64,
                caption_image_height,
                caption_style,
                max_colors,
                dither_type,
                drop_frames_factor,
                loop_count,
                fps,
                trim_start,
                trim_end,
            };

            if let Err(e) = curator_core::gif::process_gif_effects(
                job_id.to_string(),
                input_path,
                output_path,
                target_format.to_string(),
                opts,
                &ffmpeg,
                &ctx.transcode_progress,
            )
            .await
            {
                return Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                }));
            }
            Ok(serde_json::json!("Success"))
        }
        "SplitGif" => {
            let job_id = params["job_id"].as_str().unwrap_or_default();
            let input_path = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["input_path"].as_str().unwrap_or_default(),
            );
            let output_dir = handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_dir"].as_str().unwrap_or_default(),
            );

            let ffmpeg = handlers::resolve_ffmpeg_path(&ctx.data_dir, &ctx.settings)
                .await
                .map_err(internal_status)?;

            if let Err(e) = curator_core::gif::split_gif(
                job_id.to_string(),
                input_path,
                output_dir,
                &ffmpeg,
                &ctx.transcode_progress,
            )
            .await
            {
                return Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                }));
            }
            Ok(serde_json::json!("Success"))
        }

        "CheckPluginRuntimeInstalled" => {
            let plugin = params["plugin"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing plugin"))?;
            let installed =
                crate::handlers::plugins::plugin_runtime_index_exists(&ctx.data_dir, plugin)
                    .map_err(internal_status)?;
            Ok(serde_json::json!({
                "CheckPluginRuntimeInstalledResult": { "installed": installed }
            }))
        }

        "InstallPluginRuntime" => {
            let plugin = params["plugin"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing plugin"))?
                .to_string();
            if !plugin_runtime_spec_exists(&ctx.data_dir, &plugin).map_err(internal_status)? {
                return Ok(serde_json::json!({
                    "InstallPluginRuntimeResult": { "started": false, "error": "plugin has no install.json runtime spec" }
                }));
            }

            // Guard against a second concurrent install of the same plugin.
            let running = {
                let guard = ctx.plugin_runtime_progress.lock().await;
                matches!(guard.get(&plugin).map(|s| s.status.as_str()),
                         Some("downloading" | "extracting"))
            };
            if running {
                return Ok(serde_json::json!({
                    "InstallPluginRuntimeResult": { "started": false, "error": "install already running" }
                }));
            }

            let ctx_clone = ctx.clone();
            tokio::spawn(async move {
                let progress = ctx_clone.plugin_runtime_progress.clone();
                if let Err(e) = crate::handlers::plugin_runtime::install_plugin_runtime(
                    ctx_clone.data_dir.clone(),
                    plugin.clone(),
                    progress.clone(),
                )
                .await
                {
                    crate::handlers::plugin_runtime::progress_mut(&progress, &plugin, |s| {
                        s.status = "failed".to_string();
                        s.error = Some(e.to_string());
                    })
                    .await;
                    crate::handlers::plugin_runtime::progress_log(
                        &progress,
                        &plugin,
                        format!("[ERROR] {e}"),
                    )
                    .await;
                }
            });
            Ok(serde_json::json!({
                "InstallPluginRuntimeResult": { "started": true }
            }))
        }

        "GetPluginRuntimeInstallProgress" => {
            let plugin = params["plugin"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing plugin"))?;
            let p = crate::handlers::plugin_runtime::get_runtime_progress(
                &ctx.plugin_runtime_progress,
                plugin,
            )
            .await;
            Ok(serde_json::json!({
                "GetPluginRuntimeInstallProgressResult": {
                    "status": p.status,
                    "percent": p.percent,
                    "logs": p.logs,
                    "error": p.error,
                }
            }))
        }

        "CheckTool" => {
            let tool = params["tool"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing tool"))?;
            match handlers::tools::check_tool(&ctx.data_dir, &ctx.settings, tool).await {
                Ok(s) => Ok(serde_json::json!({
                    "CheckToolResult": {
                        "installed": s.available,
                        "path": s.resolved_path,
                        "version": s.version,
                        "portable_path": s.portable_path,
                    }
                })),
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }

        "SetToolPath" => {
            let tool = params["tool"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing tool"))?;
            let path = params["path"].as_str().map(|s| s.to_string());
            match handlers::tools::set_tool_path(&ctx.data_dir, &ctx.settings, tool, path).await {
                Ok(()) => Ok(serde_json::json!("Success")),
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }

        "InstallTool" => {
            let tool = params["tool"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing tool"))?;
            match handlers::tools::install_tool(&ctx.data_dir, tool, ctx.tool_install_progress.clone()).await {
                Ok(outcome) => Ok(serde_json::json!({
                    "InstallToolResult": { "started": outcome.started, "error": outcome.error }
                })),
                Err(e) => Ok(serde_json::json!({
                    "InstallToolResult": { "started": false, "error": e.to_string() }
                })),
            }
        }

        "GetToolInstallProgress" => {
            let tool = params["tool"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing tool"))?;
            let p = handlers::tools::get_tool_install_progress(&ctx.tool_install_progress, tool).await;
            Ok(serde_json::json!({
                "GetToolInstallProgressResult": {
                    "status": p.status,
                    "percent": p.percent,
                    "logs": p.logs,
                    "error": p.error,
                }
            }))
        }

        "ResolveOutputPath" => {
            let job_id = params["job_id"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
            let output_path = std::path::PathBuf::from(handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_path"].as_str().unwrap_or_default(),
            ));
            let auto_rename = params["auto_rename"].as_bool().unwrap_or(false);
            let resolved = handlers::download::resolve_output_path(
                &ctx.download_jobs,
                &ctx.download_path_claims,
                job_id,
                &output_path,
                auto_rename,
            )
            .await;
            Ok(serde_json::json!({
                "ResolveOutputPathResult": {
                    "output_path": resolved.to_string_lossy().into_owned()
                }
            }))
        }

        "DownloadStart" => {
            let engine_id = params["engine"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing engine"))?;
            let url = params["url"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing url"))?;
            let job_id = params["job_id"]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let output_path = std::path::PathBuf::from(handlers::resolve_relative_path(
                &ctx.data_dir,
                params["output_path"].as_str().unwrap_or_default(),
            ));
            let engine = ctx
                .engines
                .get(engine_id)
                .cloned()
                .ok_or_else(|| Status::invalid_argument(format!("unknown engine: {engine_id}")))?;

            let job = handlers::download::DownloadJob {
                job_id: job_id.clone(),
                engine: engine_id.to_string(),
                url: url.to_string(),
                output_path,
                max_connections: params["max_connections"].as_u64().unwrap_or(8) as u16,
                speed_limit_kb: params["speed_limit_kb"].as_u64(),
                user_agent: params["user_agent"].as_str().map(|s| s.to_string()),
                headers: params["headers"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|h| h.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                max_tries: params["max_tries"].as_u64(),
                timeout_secs: params["timeout_secs"].as_u64(),
                auto_rename: params["auto_rename"].as_bool().unwrap_or(false),
            };

            if let Err(e) = handlers::download::start_download(
                job,
                engine,
                ctx.data_dir.clone(),
                ctx.settings.clone(),
                ctx.download_jobs.clone(),
                ctx.download_cancels.clone(),
                ctx.download_path_claims.clone(),
            )
            .await
            {
                return Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                }));
            }
            Ok(serde_json::json!({
                "DownloadStartResult": { "job_id": job_id }
            }))
        }

        "DownloadProgress" => {
            let job_id = params["job_id"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
            let p = handlers::download::get_download_progress(&ctx.download_jobs, job_id).await;
            Ok(serde_json::json!({
                "DownloadProgressResult": {
                    "running": p.running,
                    "status": p.status,
                    "percent": p.percent,
                    "downloaded_bytes": p.downloaded_bytes,
                    "total_bytes": p.total_bytes,
                    "speed_bps": p.speed_bps,
                    "eta_secs": p.eta_secs,
                    "connections": p.connections,
                    "output_path": p.output_path,
                    "error": p.error,
                    "logs": p.logs,
                    "command": p.command,
                    "engine": p.engine,
                }
            }))
        }

        "DownloadCancel" => {
            let job_id = params["job_id"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
            handlers::download::cancel_download(&ctx.download_jobs, &ctx.download_cancels, job_id)
                .await
                .map_err(internal_status)?;
            Ok(serde_json::json!("Success"))
        }

        "PluginDbExecute" => {
            let db = params["db"].as_str().unwrap_or("plugin.db");
            let sql = params["sql"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing sql"))?;
            if plugin_id.is_empty() {
                return Err(Status::invalid_argument("missing plugin_id"));
            }
            let params_arr = params["params"].as_array().cloned().unwrap_or_default();
            match curator_core::plugin_db_execute(&ctx.data_dir, plugin_id, db, sql, &params_arr)
                .await
            {
                Ok(rows_affected) => Ok(serde_json::json!({
                    "PluginDbExecuteResult": { "rows_affected": rows_affected }
                })),
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }

        "PluginDbQuery" => {
            let db = params["db"].as_str().unwrap_or("plugin.db");
            let sql = params["sql"]
                .as_str()
                .ok_or_else(|| Status::invalid_argument("missing sql"))?;
            if plugin_id.is_empty() {
                return Err(Status::invalid_argument("missing plugin_id"));
            }
            let params_arr = params["params"].as_array().cloned().unwrap_or_default();
            match curator_core::plugin_db_query(&ctx.data_dir, plugin_id, db, sql, &params_arr).await {
                Ok(rows) => Ok(serde_json::json!({
                    "PluginDbQueryResult": { "rows": rows }
                })),
                Err(e) => Ok(serde_json::json!({
                    "Error": { "message": e.to_string() }
                })),
            }
        }


        unknown => Err(Status::invalid_argument(format!("Unknown plugin command: {unknown}"))),
    }
}

#[tonic::async_trait]
impl PluginsService for PluginsServiceImpl {
    async fn validate_plugin(
        &self,
        request: TonicRequest<ValidatePluginRequest>,
    ) -> Result<TonicResponse<ValidationResult>, Status> {
        let req = request.into_inner();
        match handlers::plugins::validate_plugin_logic(&req.manifest_path).await {
            Ok((name, version)) => Ok(TonicResponse::new(ValidationResult {
                name,
                version,
                valid: true,
                error: None,
            })),
            Err(e) => Ok(TonicResponse::new(ValidationResult {
                name: String::new(),
                version: String::new(),
                valid: false,
                error: Some(e.to_string()),
            })),
        }
    }

    async fn list_plugins(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<PluginsListResult>, Status> {
        let plugins = handlers::plugins::list_plugins(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .map_err(internal_status)?;
        Ok(TonicResponse::new(PluginsListResult {
            plugins: plugins.into_iter().map(Into::into).collect(),
        }))
    }

    async fn set_plugin_enabled(
        &self,
        request: TonicRequest<SetPluginEnabledRequest>,
    ) -> Result<TonicResponse<()>, Status> {
        let req = request.into_inner();
        handlers::plugins::set_plugin_enabled(
            &self.ctx.data_dir,
            &self.ctx.settings,
            &req.plugin_name,
            req.enabled,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(()))
    }

    async fn read_plugin_file(
        &self,
        request: TonicRequest<ReadPluginFileRequest>,
    ) -> Result<TonicResponse<PluginFileResult>, Status> {
        let req = request.into_inner();
        let content = handlers::plugins::read_plugin_file(
            &self.ctx.data_dir,
            &req.plugin_name,
            &req.relative_path,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(PluginFileResult { content }))
    }

    async fn invoke_plugin(
        &self,
        request: TonicRequest<InvokePluginRequest>,
    ) -> Result<TonicResponse<InvokePluginResponse>, Status> {
        let req = request.into_inner();
        let params: serde_json::Value = if req.parameters_json.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&req.parameters_json)
                .map_err(|e| Status::invalid_argument(format!("invalid parameters_json: {e}")))?
        };

        let response = dispatch_plugin_command(&self.ctx, &req.plugin_id, &req.command, &params).await?;
        let response_json = serde_json::to_string(&response)
            .map_err(|e| internal_status(format!("failed to serialize response: {e}")))?;
        Ok(TonicResponse::new(InvokePluginResponse { response_json }))
    }
}

