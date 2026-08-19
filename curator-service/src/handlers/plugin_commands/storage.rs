//! Sandboxed file operations for plugins (`PathExists`, `FileExists`,
//! `FileRead`, `FileWrite`, `FileList`, `DirStat`, `FileMove`, `FileDelete`).
//!
//! `FileExists` / `FileRead` / `FileWrite` / `FileList` / `DirStat` /
//! `FileMove` / `FileDelete` are confined to the plugin's
//! `plugin_data/<plugin_id>/` sandbox via the shared `SandboxedPath` type:
//! any resolved path that escapes that root (absolute input, `..`,
//! `.curator/…`, NTFS tricks) is rejected. `PathExists` intentionally probes
//! arbitrary workspace / `.curator` paths (used by `plugins/lib/ipc-utils.ts`
//! for output-collision checks).
//!
//! `FileExistsBatch` / `DirStatBatch` resolve many paths in a single call so
//! plugins stop issuing per-file/per-dir IPC bursts (e.g. dynasty-scans cache
//! overview). Sandbox rejection is per-item — a single unsafe path yields an
//! `error` on that item, never a whole-batch failure. Recursive walks run on
//! the blocking pool via `spawn_blocking`.

use std::io::Read;
use std::sync::Arc;
use tonic::Status;

use base64::Engine;

use crate::ClientContext;
use crate::handlers;

use curator_core::db::{SandboxError, SandboxedPath};

/// Cap on a single sandboxed file read/write to bound daemon memory.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn sandbox_err(e: SandboxError) -> Status {
    Status::invalid_argument(e.to_string())
}

/// Resolve a sandboxed path, mapping rejection to the legacy `Error` JSON.
fn resolve(ctx: &Arc<ClientContext>, plugin_id: &str, raw_path: &str) -> Result<SandboxedPath, Status> {
    SandboxedPath::resolve(&ctx.data_dir, plugin_id, raw_path).map_err(sandbox_err)
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

/// Workspace-anchored file-size probe (mirrors `PathExists` semantics): used by
/// gif-maker to measure `.curator/temp_gif/…` media files that live outside the
/// plugin sandbox. Returns `size_bytes` when the file exists, else `null`.
pub async fn get_file_size(
    ctx: &Arc<ClientContext>,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let path = handlers::resolve_relative_path(&ctx.data_dir, raw_path);
    let size = std::fs::metadata(&path).map(|m| m.len()).ok();
    Ok(serde_json::json!({
        "GetFileSizeResult": { "size_bytes": size }
    }))
}

pub async fn file_exists(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let meta = resolved.absolute().metadata().ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let exists = resolved.absolute().is_file() && size > 0;
    Ok(serde_json::json!({
        "FileExistsResult": {
            "exists": exists,
            "size_bytes": size,
            "absolute_path": resolved.absolute().to_string_lossy().into_owned()
        }
    }))
}

/// Resolves many sandboxed paths in one IPC round-trip. Each path is resolved
/// independently: sandbox rejections (absolute input, `..`, `.curator/…`) are
/// captured as a per-item `error` string and never fail the whole batch.
pub async fn file_exists_batch(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let paths: Vec<String> = params["paths"]
        .as_array()
        .ok_or_else(|| Status::invalid_argument("missing paths"))?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let data_dir = Arc::clone(&ctx.data_dir);
    let plugin_id = plugin_id.to_string();
    let items = tokio::task::spawn_blocking(move || {
        file_exists_batch_items(&data_dir, &plugin_id, &paths)
    })
    .await
    .map_err(crate::server::internal_status)?;
    Ok(serde_json::json!({ "FileExistsBatchResult": { "items": items } }))
}

/// Pure batch resolution for `FileExistsBatch` (testable without a full
/// `ClientContext`).
fn file_exists_batch_items(
    data_dir: &std::path::Path,
    plugin_id: &str,
    paths: &[String],
) -> Vec<serde_json::Value> {
    paths
        .iter()
        .map(|raw| match SandboxedPath::resolve(data_dir, plugin_id, raw) {
            Ok(resolved) => {
                let meta = resolved.absolute().metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let exists = resolved.absolute().is_file() && size > 0;
                serde_json::json!({
                    "path": raw,
                    "exists": exists,
                    "size_bytes": size,
                    "absolute_path": resolved.absolute().to_string_lossy().into_owned(),
                    "error": ""
                })
            }
            Err(e) => serde_json::json!({
                "path": raw,
                "exists": false,
                "size_bytes": 0,
                "absolute_path": "",
                "error": e.to_string()
            }),
        })
        .collect()
}

pub async fn file_read(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let path = resolved.absolute();
    if !path.is_file() {
        return Ok(serde_json::json!({
            "Error": { "message": "file does not exist" }
        }));
    }
    let size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);
    if size > MAX_FILE_BYTES {
        return Ok(serde_json::json!({
            "Error": { "message": "file exceeds 16MB sandbox read cap" }
        }));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return Ok(serde_json::json!({
                "Error": { "message": format!("failed opening file: {e}") }
            }));
        }
    };
    if let Err(e) = f.read_to_end(&mut bytes) {
        return Ok(serde_json::json!({
            "Error": { "message": format!("failed reading file: {e}") }
        }));
    }
    Ok(serde_json::json!({
        "FileReadResult": {
            "content_base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "size_bytes": bytes.len() as u64,
            "absolute_path": path.to_string_lossy().into_owned()
        }
    }))
}

pub async fn file_write(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let content = params["content_base64"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing content_base64"))?;
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let path = resolved.absolute();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|_| Status::invalid_argument("invalid base64 content"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Ok(serde_json::json!({
            "Error": { "message": "payload exceeds 16MB sandbox write cap" }
        }));
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(serde_json::json!({
                "Error": { "message": format!("failed creating parent directory: {e}") }
            }));
        }
    }
    if let Err(e) = std::fs::write(path, &bytes) {
        return Ok(serde_json::json!({
            "Error": { "message": format!("failed writing file: {e}") }
        }));
    }
    Ok(serde_json::json!({
        "FileWriteResult": {
            "size_bytes": bytes.len() as u64,
            "absolute_path": path.to_string_lossy().into_owned()
        }
    }))
}

pub async fn file_list(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"].as_str().unwrap_or("");
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let path = resolved.absolute();
    if !path.is_dir() {
        return Ok(serde_json::json!({
            "Error": { "message": "directory does not exist" }
        }));
    }
    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(path) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata().ok();
            entries.push(serde_json::json!({
                "name": name,
                "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "size_bytes": meta.map(|m| m.len()).unwrap_or(0),
            }));
        }
    }
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(serde_json::json!({
        "FileListResult": { "entries": entries }
    }))
}

pub async fn dir_stat(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_path = params["path"].as_str().unwrap_or("");
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let path = resolved.absolute();
    let (total_bytes, file_count) = stat_one(&path);
    Ok(serde_json::json!({
        "DirStatResult": {
            "total_bytes": total_bytes,
            "file_count": file_count,
            "absolute_path": path.to_string_lossy().into_owned()
        }
    }))
}

/// Resolves many sandboxed paths in one IPC round-trip. Sandbox rejections
/// (absolute input, `..`, `.curator/…`) are captured as a per-item `error`
/// string and never fail the whole batch.
pub async fn dir_stat_batch(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let paths: Vec<String> = params["paths"]
        .as_array()
        .ok_or_else(|| Status::invalid_argument("missing paths"))?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let data_dir = Arc::clone(&ctx.data_dir);
    let plugin_id = plugin_id.to_string();
    let items = tokio::task::spawn_blocking(move || {
        dir_stat_batch_items(&data_dir, &plugin_id, &paths)
    })
    .await
    .map_err(crate::server::internal_status)?;
    Ok(serde_json::json!({ "DirStatBatchResult": { "items": items } }))
}

/// Pure batch resolution for `DirStatBatch` (testable without a full
/// `ClientContext`).
fn dir_stat_batch_items(
    data_dir: &std::path::Path,
    plugin_id: &str,
    paths: &[String],
) -> Vec<serde_json::Value> {
    paths
        .iter()
        .map(|raw| match SandboxedPath::resolve(data_dir, plugin_id, raw) {
            Ok(resolved) => {
                let (total_bytes, file_count) = stat_one(resolved.absolute());
                serde_json::json!({
                    "path": raw,
                    "total_bytes": total_bytes,
                    "file_count": file_count,
                    "absolute_path": resolved.absolute().to_string_lossy().into_owned(),
                    "error": ""
                })
            }
            Err(e) => serde_json::json!({
                "path": raw,
                "total_bytes": 0,
                "file_count": 0,
                "absolute_path": "",
                "error": e.to_string()
            }),
        })
        .collect()
}

fn stat_one(path: &std::path::Path) -> (u64, u64) {
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;
    if path.is_dir() {
        dir_size_recursive(path, &mut total_bytes, &mut file_count);
    } else if path.is_file() {
        if let Ok(meta) = path.metadata() {
            total_bytes = meta.len();
            file_count = 1;
        }
    }
    (total_bytes, file_count)
}

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

pub async fn file_move(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let raw_src = params["src"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing src"))?;
    let raw_dst = params["dst"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing dst"))?;
    let src = resolve(ctx, plugin_id, raw_src)?;
    let dst = resolve(ctx, plugin_id, raw_dst)?;
    if let Some(parent) = dst.absolute().parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(serde_json::json!({
                "Error": { "message": format!("failed creating parent directory: {e}") }
            }));
        }
    }
    match std::fs::rename(src.absolute(), dst.absolute()) {
        Ok(()) => Ok(serde_json::json!({
            "FileMoveResult": {
                "absolute_path": dst.absolute().to_string_lossy().into_owned()
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
    let raw_path = params["path"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing path"))?;
    let resolved = resolve(ctx, plugin_id, raw_path)?;
    let path = resolved.absolute();
    if path.is_dir() {
        match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(serde_json::json!("Success")),
            Err(e) => Ok(serde_json::json!({
                "Error": { "message": format!("directory delete failed: {e}") }
            })),
        }
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(serde_json::json!("Success")),
            Err(e) => Ok(serde_json::json!({
                "Error": { "message": format!("file delete failed: {e}") }
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (std::path::PathBuf, std::path::PathBuf) {
        let unique = format!(
            "curator_storage_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let plugin_root = root.join("plugin_data/dynasty-scans");
        std::fs::create_dir_all(&plugin_root.join("pages/series_a")).expect("create pages");
        std::fs::write(
            plugin_root.join("pages/series_a/01.webp"),
            vec![0u8; 512],
        )
        .expect("write page");
        (root, plugin_root)
    }

    fn cleanup(root: &std::path::Path) {
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn file_exists_batch_happy_path_and_missing() {
        let (root, plugin_root) = setup();
        let paths = vec![
            "pages/series_a/01.webp".to_string(),
            "pages/series_a/missing.webp".to_string(),
        ];
        let items = file_exists_batch_items(&root, "dynasty-scans", &paths);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["path"], "pages/series_a/01.webp");
        assert_eq!(items[0]["exists"], true);
        assert_eq!(items[0]["size_bytes"], 512);
        assert_eq!(items[0]["error"], "");
        assert_eq!(items[1]["exists"], false);
        assert_eq!(items[1]["error"], "");
        assert!(items[1]["absolute_path"].as_str().unwrap().replace('\\', "/").contains("pages/series_a/missing.webp"));
        cleanup(&root);
        let _ = plugin_root;
    }

    #[test]
    fn file_exists_batch_per_item_sandbox_rejection() {
        let (root, plugin_root) = setup();
        let paths = vec![
            "pages/series_a/01.webp".to_string(),
            "C:/Windows/System32/notepad.exe".to_string(),
            "../escape.webp".to_string(),
        ];
        let items = file_exists_batch_items(&root, "dynasty-scans", &paths);
        assert_eq!(items.len(), 3);
        // Good path resolves normally.
        assert_eq!(items[0]["exists"], true);
        // Both bad paths are rejected per-item, not whole-batch.
        assert_eq!(items[1]["exists"], false);
        assert_ne!(items[1]["error"], "");
        assert_eq!(items[2]["exists"], false);
        assert_ne!(items[2]["error"], "");
        cleanup(&root);
        let _ = plugin_root;
    }

    #[test]
    fn dir_stat_batch_recursive_walk_and_missing() {
        let (root, plugin_root) = setup();
        std::fs::write(
            plugin_root.join("pages/series_a/02.webp"),
            vec![0u8; 256],
        )
        .expect("write second page");
        let paths = vec![
            "pages/series_a".to_string(),
            "pages/nope".to_string(),
        ];
        let items = dir_stat_batch_items(&root, "dynasty-scans", &paths);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["path"], "pages/series_a");
        assert_eq!(items[0]["file_count"], 2);
        assert_eq!(items[0]["total_bytes"], 768);
        assert_eq!(items[0]["error"], "");
        // Missing dir: zero stat, no error (frontend treats 0 as "not cached").
        assert_eq!(items[1]["total_bytes"], 0);
        assert_eq!(items[1]["file_count"], 0);
        assert_eq!(items[1]["error"], "");
        cleanup(&root);
        let _ = plugin_root;
    }

    #[test]
    fn dir_stat_batch_per_item_sandbox_rejection() {
        let (root, plugin_root) = setup();
        let paths = vec!["pages/series_a".to_string(), "..".to_string()];
        let items = dir_stat_batch_items(&root, "dynasty-scans", &paths);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["file_count"], 1);
        assert_ne!(items[1]["error"], "");
        assert_eq!(items[1]["total_bytes"], 0);
        cleanup(&root);
        let _ = plugin_root;
    }

    #[test]
    fn batch_empty_paths_returns_empty_items() {
        let (root, _plugin_root) = setup();
        let items = file_exists_batch_items(&root, "dynasty-scans", &[]);
        assert!(items.is_empty());
        cleanup(&root);
    }
}
