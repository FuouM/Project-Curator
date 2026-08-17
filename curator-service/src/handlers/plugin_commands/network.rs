//! Network transport for plugins (`HttpGet` / `HttpDownload`).
//!
//! A single keep-alive `ureq` agent is shared across all plugin requests.
//! Note the agent's global 30-second timeout is baked in at construction, so
//! per-command `timeout_ms` parameters are advisory only — see the refactoring
//! roadmap for configurable per-command timeout profiles.

use std::sync::Arc;
use tonic::Status;

use crate::handlers;
use crate::ClientContext;

static HTTP_AGENT: std::sync::LazyLock<ureq::Agent> = std::sync::LazyLock::new(|| {
    ureq::config::Config::builder()
        .max_redirects(10)
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .build()
        .new_agent()
});

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Curator/1.0";

pub async fn http_get(
    _ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let url = params["url"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing url"))?;
    let method = params["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
    let result = if method == "POST" {
        let content_type = params["content_type"]
            .as_str()
            .unwrap_or("application/x-www-form-urlencoded");
        let mut req = HTTP_AGENT
            .post(url)
            .header("Content-Type", content_type)
            .header("User-Agent", USER_AGENT);
        if let Some(headers_obj) = params["headers"].as_object() {
            for (k, v) in headers_obj {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }
        let body = params["body"].as_str().unwrap_or("");
        req.send(body)
    } else {
        let mut req = HTTP_AGENT
            .get(url)
            .header("User-Agent", USER_AGENT);
        if let Some(headers_obj) = params["headers"].as_object() {
            for (k, v) in headers_obj {
                if let Some(v_str) = v.as_str() {
                    req = req.header(k.as_str(), v_str);
                }
            }
        }
        req.call()
    };
    match result {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let etag = resp
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let mut body = String::new();
            if status != 304 {
                const MAX_GET_BODY: usize = 8 * 1024 * 1024;
                use std::io::Read;
                let read = resp
                    .body_mut()
                    .as_reader()
                    .take(MAX_GET_BODY as u64 + 1)
                    .read_to_string(&mut body);
                if let Err(e) = read {
                    return Ok(serde_json::json!({
                        "Error": { "message": format!("failed reading response body: {e}") }
                    }));
                }
            }
            Ok(serde_json::json!({
                "HttpGetResult": {
                    "status": status,
                    "body": body,
                    "etag": etag
                }
            }))
        }
        Err(e) => Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        })),
    }
}

pub async fn http_download(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let url = params["url"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing url"))?;
    let raw_output = params["output_path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing output_path"))?;
    let target = std::path::PathBuf::from(handlers::resolve_relative_path(
        &ctx.data_dir,
        raw_output,
    ));
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(crate::server::internal_status)?;
    }
    let mut response = match HTTP_AGENT
        .get(url)
        .header("User-Agent", USER_AGENT)
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(serde_json::json!({
                "Error": { "message": e.to_string() }
            }));
        }
    };
    if !response.status().is_success() {
        return Ok(serde_json::json!({
            "Error": {
                "message": format!("http download failed: status {}", response.status())
            }
        }));
    }
    let tmp = target.with_extension("tmp");
    let copy_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        let mut reader = response.body_mut().as_reader();
        std::io::copy(&mut reader, &mut file)?;
        Ok(())
    })();
    if let Err(e) = copy_result {
        let _ = std::fs::remove_file(&tmp);
        return Ok(serde_json::json!({
            "Error": { "message": format!("failed writing download: {e}") }
        }));
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Ok(serde_json::json!({
            "Error": { "message": format!("failed finalizing download: {e}") }
        }));
    }
    let size = target.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "HttpDownloadResult": {
            "written_to": raw_output,
            "size_bytes": size,
            "absolute_path": target.to_string_lossy().into_owned()
        }
    }))
}
