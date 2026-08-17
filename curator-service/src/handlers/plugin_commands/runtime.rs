//! Plugin runtime-install commands (`CheckPluginRuntimeInstalled`,
//! `InstallPluginRuntime`, `GetPluginRuntimeInstallProgress`).
//!
//! "Runtime" here refers to a plugin that ships an `install.json` spec with an
//! extracted runtime directory (an `index.html` entrypoint), not the generic
//! command surface.

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;
use crate::handlers;

pub async fn check_installed(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let plugin = params["plugin"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing plugin"))?;
    let installed = handlers::plugins::plugin_runtime_index_exists(&ctx.data_dir, plugin)
        .map_err(crate::server::internal_status)?;
    Ok(serde_json::json!({
        "CheckPluginRuntimeInstalledResult": { "installed": installed }
    }))
}

pub async fn install(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let plugin = params["plugin"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing plugin"))?
        .to_string();
    if !handlers::plugins::plugin_runtime_spec_exists(&ctx.data_dir, &plugin)
        .map_err(crate::server::internal_status)?
    {
        return Ok(serde_json::json!({
            "InstallPluginRuntimeResult": { "started": false, "error": "plugin has no install.json runtime spec" }
        }));
    }

    // Guard against a second concurrent install of the same plugin.
    let running = {
        let guard = ctx.plugin_runtime_progress.lock().await;
        matches!(
            guard.get(&plugin).map(|s| s.status.as_str()),
            Some("downloading" | "extracting")
        )
    };
    if running {
        return Ok(serde_json::json!({
            "InstallPluginRuntimeResult": { "started": false, "error": "install already running" }
        }));
    }

    let ctx_clone = ctx.clone();
    tokio::spawn(async move {
        let progress = ctx_clone.plugin_runtime_progress.clone();
        if let Err(e) = handlers::plugin_runtime::install_plugin_runtime(
            ctx_clone.data_dir.clone(),
            plugin.clone(),
            progress.clone(),
        )
        .await
        {
            handlers::plugin_runtime::progress_mut(&progress, &plugin, |s| {
                s.status = "failed".to_string();
                s.error = Some(e.to_string());
            })
            .await;
            handlers::plugin_runtime::progress_log(&progress, &plugin, format!("[ERROR] {e}"))
                .await;
        }
    });
    Ok(serde_json::json!({
        "InstallPluginRuntimeResult": { "started": true }
    }))
}

pub async fn install_progress(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let plugin = params["plugin"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing plugin"))?;
    let p =
        handlers::plugin_runtime::get_runtime_progress(&ctx.plugin_runtime_progress, plugin).await;
    Ok(serde_json::json!({
        "GetPluginRuntimeInstallProgressResult": {
            "status": p.status,
            "percent": p.percent,
            "logs": p.logs,
            "error": p.error,
        }
    }))
}
