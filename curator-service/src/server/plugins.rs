use crate::handlers;
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

/// Routes a plugin `{ command, params }` payload to the matching command
/// handler. All implementation lives in `handlers::plugin_commands::*`; this
/// is a lean, declarative mapping.
async fn dispatch_plugin_command(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    command: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    use handlers::plugin_commands as pc;
    match command {
        "PathExists" => pc::storage::path_exists(ctx, params).await,
        "GetTranscodeProgress" => pc::media::get_transcode_progress(ctx, params).await,
        "GetMediaMetadata" => pc::media::get_media_metadata(ctx, params).await,
        "EphemeralConvertImages" => pc::media::ephemeral_convert_images(ctx, params).await,
        "TranscodeVideo" => pc::media::transcode_video(ctx, params).await,
        "CreateGifFromImages" => pc::media::create_gif_from_images(ctx, params).await,
        "ProcessGifEffects" => pc::media::process_gif_effects(ctx, params).await,
        "SplitGif" => pc::media::split_gif(ctx, params).await,
        "CheckPluginRuntimeInstalled" => pc::runtime::check_installed(ctx, params).await,
        "InstallPluginRuntime" => pc::runtime::install(ctx, params).await,
        "GetPluginRuntimeInstallProgress" => pc::runtime::install_progress(ctx, params).await,
        "CheckTool" => pc::tools::check(ctx, params).await,
        "SetToolPath" => pc::tools::set_path(ctx, params).await,
        "InstallTool" => pc::tools::install(ctx, params).await,
        "GetToolInstallProgress" => pc::tools::install_progress(ctx, params).await,
        "ResolveOutputPath" => pc::download::resolve_output_path(ctx, params).await,
        "DownloadStart" => pc::download::start(ctx, params).await,
        "DownloadProgress" => pc::download::progress(ctx, params).await,
        "DownloadCancel" => pc::download::cancel(ctx, params).await,
        "HttpGet" => pc::network::http_get(ctx, params).await,
        "HttpDownload" => pc::network::http_download(ctx, params).await,
        "PluginDbExecute" => pc::db::execute(ctx, plugin_id, params).await,
        "PluginDbQuery" => pc::db::query(ctx, plugin_id, params).await,
        "FileExists" => pc::storage::file_exists(ctx, plugin_id, params).await,
        "DirStat" => pc::storage::dir_stat(ctx, plugin_id, params).await,
        "FileMove" => pc::storage::file_move(ctx, plugin_id, params).await,
        "FileDelete" => pc::storage::file_delete(ctx, plugin_id, params).await,
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
