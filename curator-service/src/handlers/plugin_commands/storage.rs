//! Sandboxed file operations for plugins (`PathExists`, `FileExists`,
//! `DirStat`, `FileMove`, `FileDelete`).
//!
//! `FileExists` / `DirStat` / `FileMove` / `FileDelete` are confined to the
//! plugin's `plugin_data/<plugin_id>/` sandbox: any resolved path that escapes
//! that root is rejected. `PathExists` intentionally probes arbitrary
//! workspace / `.curator` paths (used by `plugins/lib/ipc-utils.ts` for
//! output-collision checks).

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;
use crate::handlers;

/// Resolves a plugin-relative (or `.curator`/absolute) path inside the plugin
/// sandbox root. Mirrors the historical per-command resolution: empty paths
/// resolve to the plugin root, absolute paths pass through, `.curator` paths
/// resolve against the workspace root, and everything else joins onto
/// `plugin_data/<plugin_id>/`.
fn resolve_plugin_path(
    data_dir: &std::path::Path,
    plugin_id: &str,
    raw_path: &str,
) -> std::path::PathBuf {
    let plugin_root = data_dir.join("plugin_data").join(plugin_id);
    if raw_path.is_empty() {
        return plugin_root;
    }
    let p = std::path::Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else if raw_path.starts_with(".curator") {
        std::path::PathBuf::from(handlers::resolve_relative_path(data_dir, raw_path))
    } else {
        plugin_root.join(raw_path)
    }
}

/// True when the resolved path stays inside the plugin sandbox root.
fn inside_sandbox(resolved: &std::path::Path, plugin_root: &std::path::Path) -> bool {
    resolved.starts_with(plugin_root)
}

pub async fn path_exists(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let path = handlers::resolve_relative_path(&ctx.data_dir, raw_path);
    let exists = handlers::misc::path_exists(&path)
        .await
        .map_err(crate::server::internal_status)?;
    Ok(serde_json::json!({
        "PathExistsResult": { "exists": exists }
    }))
}

pub async fn file_exists(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let plugin_root = ctx.data_dir.join("plugin_data").join(plugin_id);
    let resolved = resolve_plugin_path(&ctx.data_dir, plugin_id, raw_path);
    if !inside_sandbox(&resolved, &plugin_root) {
        return Ok(serde_json::json!({
            "Error": { "message": "path escapes plugin data directory" }
        }));
    }
    let meta = resolved.metadata().ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let exists = resolved.is_file() && size > 0;
    Ok(serde_json::json!({
        "FileExistsResult": {
            "exists": exists,
            "size_bytes": size,
            "absolute_path": resolved.to_string_lossy().into_owned()
        }
    }))
}

pub async fn dir_stat(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let raw_path = params["path"].as_str().unwrap_or("");
    let plugin_root = ctx.data_dir.join("plugin_data").join(plugin_id);
    let resolved = resolve_plugin_path(&ctx.data_dir, plugin_id, raw_path);
    if !inside_sandbox(&resolved, &plugin_root) {
        return Ok(serde_json::json!({
            "Error": { "message": "path escapes plugin data directory" }
        }));
    }
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;
    fn dir_size_recursive(path: &std::path::Path, total_bytes: &mut u64, file_count: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_dir() {
                        dir_size_recursive(&entry.path(), total_bytes, file_count);
                    } else if file_type.is_file() {
                        if let Ok(meta) = entry.metadata() {
                            *total_bytes += meta.len();
                            *file_count += 1;
                        }
                    }
                }
            }
        }
    }
    if resolved.is_dir() {
        dir_size_recursive(&resolved, &mut total_bytes, &mut file_count);
    } else if resolved.is_file() {
        if let Ok(meta) = resolved.metadata() {
            total_bytes = meta.len();
            file_count = 1;
        }
    }
    Ok(serde_json::json!({
        "DirStatResult": {
            "total_bytes": total_bytes,
            "file_count": file_count,
            "absolute_path": resolved.to_string_lossy().into_owned()
        }
    }))
}

pub async fn file_move(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let plugin_root = ctx.data_dir.join("plugin_data").join(plugin_id);
    let raw_src = params["src"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing src"))?;
    let raw_dst = params["dst"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing dst"))?;
    let src = resolve_plugin_path(&ctx.data_dir, plugin_id, raw_src);
    let dst = resolve_plugin_path(&ctx.data_dir, plugin_id, raw_dst);
    if !inside_sandbox(&src, &plugin_root) || !inside_sandbox(&dst, &plugin_root) {
        return Ok(serde_json::json!({
            "Error": { "message": "path escapes plugin data directory" }
        }));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(crate::server::internal_status)?;
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => Ok(serde_json::json!({
            "FileMoveResult": {
                "absolute_path": dst.to_string_lossy().into_owned()
            }
        })),
        Err(e) => Ok(serde_json::json!({
            "Error": { "message": format!("file move failed: {e}") }
        })),
    }
}

pub async fn file_delete(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let plugin_root = ctx.data_dir.join("plugin_data").join(plugin_id);
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let resolved = resolve_plugin_path(&ctx.data_dir, plugin_id, raw_path);
    if !inside_sandbox(&resolved, &plugin_root) {
        return Ok(serde_json::json!({
            "Error": { "message": "path escapes plugin data directory" }
        }));
    }
    if resolved.is_dir() {
        match std::fs::remove_dir_all(&resolved) {
            Ok(()) => Ok(serde_json::json!("Success")),
            Err(e) => Ok(serde_json::json!({
                "Error": { "message": format!("directory delete failed: {e}") }
            })),
        }
    } else {
        match std::fs::remove_file(&resolved) {
            Ok(()) => Ok(serde_json::json!("Success")),
            Err(e) => Ok(serde_json::json!({
                "Error": { "message": format!("file delete failed: {e}") }
            })),
        }
    }
}
