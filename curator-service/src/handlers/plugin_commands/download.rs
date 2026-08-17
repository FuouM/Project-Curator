//! Generic download-job commands for plugins (`ResolveOutputPath`,
//! `DownloadStart`, `DownloadProgress`, `DownloadCancel`).
//!
//! Thin parameter parsing over the engine-agnostic download manager in
//! `crate::handlers::download` (aria2 today; future engines are additive).

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;
use crate::handlers;

pub async fn resolve_output_path(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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

pub async fn start(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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
            .map(|a| {
                a.iter()
                    .filter_map(|h| h.as_str().map(|s| s.to_string()))
                    .collect()
            })
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

pub async fn progress(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
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

pub async fn cancel(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let job_id = params["job_id"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing job_id"))?;
    handlers::download::cancel_download(&ctx.download_jobs, &ctx.download_cancels, job_id)
        .await
        .map_err(crate::server::internal_status)?;
    Ok(serde_json::json!("Success"))
}
