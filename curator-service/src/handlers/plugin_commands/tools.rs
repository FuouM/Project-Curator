//! Tool installer commands for plugins (`CheckTool`, `SetToolPath`,
//! `InstallTool`, `GetToolInstallProgress`). Delegates to
//! `crate::handlers::tools`.

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;
use crate::handlers;

pub async fn check(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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

pub async fn set_path(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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

pub async fn install(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let tool = params["tool"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing tool"))?;
    match handlers::tools::install_tool(&ctx.data_dir, tool, ctx.tool_install_progress.clone())
        .await
    {
        Ok(outcome) => Ok(serde_json::json!({
            "InstallToolResult": { "started": outcome.started, "error": outcome.error }
        })),
        Err(e) => Ok(serde_json::json!({
            "InstallToolResult": { "started": false, "error": e.to_string() }
        })),
    }
}

pub async fn install_progress(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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
