use std::collections::HashMap;
use std::path::{Path, PathBuf};

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use anyhow::Context;
use anyhow::Result;
use curator_core::ipc::{
    DownloadProgress, ManifestFileInfo, ModelStatusInfo,
};
use sha2::{Sha256, Digest};
use tokio::sync::Mutex;
use tracing::{info, warn, error};

/// Shared state for tracking active downloads.
pub type DownloadProgressMap = Arc<Mutex<HashMap<String, DownloadProgress>>>;

/// Cancellation tokens for active downloads.
pub type CancelTokens = Arc<Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>;

/// Outcome of a model action (download, remove, quantize, convert). `success`
/// is `false` when the action was rejected for a recoverable reason (e.g. the
/// model is already downloading); hard failures are `Err` from the caller.
#[derive(Debug, Clone)]
pub struct ModelActionOutcome {
    pub success: bool,
    pub message: String,
}

/// Outcome of starting the portable FFmpeg download. `started` is `false` when
/// FFmpeg is already installed/verifying, so the UI can report why nothing new
/// began.
#[derive(Debug, Clone)]
pub struct FFmpegDownloadOutcome {
    pub started: bool,
    pub message: String,
}

/// Logs and live status of the ONNX model conversion process.
#[derive(Debug, Clone)]
pub struct ConversionLogs {
    pub logs: String,
    pub is_running: bool,
}

/// Locate the project root containing `scripts/venv/Scripts/python.exe` and the
/// named helper script. Checks the current working directory first, then walks
/// up to 5 parents from the current executable. Falls back to `cwd_fallback`.
fn find_script_root(script_name: &str, cwd_fallback: PathBuf) -> PathBuf {
    let script_present = |root: &Path| -> bool {
        root.join("scripts/venv/Scripts/python.exe").exists()
            && root.join("scripts").join(script_name).exists()
    };

    let mut project_root = std::env::current_dir().unwrap_or(cwd_fallback);
    if !script_present(&project_root) {
        if let Ok(exe_path) = std::env::current_exe() {
            let mut p = exe_path.as_path();
            for _ in 0..5 {
                if let Some(parent) = p.parent() {
                    if script_present(parent) {
                        project_root = parent.to_path_buf();
                        break;
                    }
                    p = parent;
                }
            }
        }
    }
    project_root
}

/// Read the git-tracked model manifest from the workspace root. The manifest
/// is authored by the repository maintainers, so it lives at
/// `<workspace_root>/model_manifest.json` and is resolved as
/// `data_dir.parent().join("model_manifest.json")` (the same convention used
/// to resolve the workspace-root `plugins/` directory). Fails fast when
/// `data_dir` has no parent.
fn read_manifest(data_dir: &Path) -> Result<Vec<ModelManifestEntry>> {
    let workspace_root = data_dir.parent().context(format!(
        "data_dir {:?} has no parent; cannot resolve workspace-root model_manifest.json",
        data_dir
    ))?;
    let manifest_path = workspace_root.join("model_manifest.json");
    if !manifest_path.exists() {
        anyhow::bail!("Model manifest not found at {:?}", manifest_path);
    }
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| anyhow::anyhow!("Failed to read manifest: {}", e))?;
    let manifest: ModelManifest =
        serde_json::from_str(&content).map_err(|e| anyhow::anyhow!("Failed to parse manifest: {}", e))?;
    Ok(manifest.models)
}

#[derive(serde::Deserialize)]
struct ModelManifest {
    models: Vec<ModelManifestEntry>,
}

#[derive(serde::Deserialize)]
struct ModelManifestEntry {
    id: String,
    name: String,
    description: String,
    category: String,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    url: String,
    files: Vec<ManifestFileEntry>,
    #[serde(default)]
    quantizable: Vec<String>,
    #[serde(default)]
    required_by: Vec<String>,
    /// Optional in-app Safetensors -> ONNX conversion spec. `None` means the
    /// model has no convert step.
    #[serde(default)]
    convert: Option<ConvertSpec>,
}

#[derive(serde::Deserialize)]
struct ManifestFileEntry {
    url: String,
    dest: String,
    sha256: String,
}

/// Declares how a downloaded Safetensors model is converted to ONNX inside the
/// app (mirrors `convert_to_onnx.py` / `convert_nsfw_to_onnx.py`).
#[derive(serde::Deserialize)]
struct ConvertSpec {
    #[serde(default)]
    script: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    outputs: Vec<ConvertOutput>,
}

/// A single artifact produced by conversion. `path` is relative to the model
/// dir and `variant` is reported in `quantized_variants` when present (e.g.
/// "onnx" for the exported FP32 graph).
#[derive(serde::Deserialize)]
struct ConvertOutput {
    path: String,
    #[serde(default)]
    variant: String,
}

/// Get download status for all models.
pub async fn get_model_status(
    model_dir: &Path,
    progress_map: &DownloadProgressMap,
) -> Result<Vec<ModelStatusInfo>> {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = read_manifest(data_dir)?;

    let _progress = progress_map.lock().await;
    let mut models = Vec::new();

    for entry in &entries {
        let mut downloaded_files = Vec::new();
        let total_size: u64 = 0;
        let mut downloaded_size: u64 = 0;

        for file in &entry.files {
            let dest_path = model_dir.join(&file.dest);
            if dest_path.exists() {
                downloaded_files.push(file.dest.clone());
                if let Ok(meta) = std::fs::metadata(&dest_path) {
                    downloaded_size += meta.len();
                }
            }
        }

        // Collect base ONNX files: declared .onnx sources plus conversion
        // outputs (a converted Safetensors tagger's ONNX artifact is not a
        // manifest download file).
        let mut onnx_bases: Vec<PathBuf> = Vec::new();
        for file in &entry.files {
            if file.dest.ends_with(".onnx") {
                let input_path = model_dir.join(&file.dest);
                if input_path.exists() {
                    onnx_bases.push(input_path);
                }
            }
        }
        if let Some(convert) = &entry.convert {
            for out in &convert.outputs {
                if out.path.ends_with(".onnx") {
                    let input_path = model_dir.join(&out.path);
                    if input_path.exists() {
                        onnx_bases.push(input_path);
                    }
                }
            }
        }

        // Check for quantized variants: every base ONNX must have a sibling
        // "<name>_<format>.onnx" produced by the quantize step.
        let mut quantized_variants = Vec::new();
        for format in &entry.quantizable {
            let all_exist = onnx_bases.iter().all(|input_path| {
                input_path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .map(|file_name| {
                        let output_name =
                            file_name.replace(".onnx", &format!("_{}.onnx", format));
                        input_path
                            .parent()
                            .unwrap()
                            .join(output_name)
                            .exists()
                    })
                    .unwrap_or(false)
            });
            if !onnx_bases.is_empty() && all_exist {
                quantized_variants.push(format.clone());
            }
        }

        // Conversion-produced variants (e.g. the ONNX export of a Safetensors tagger).
        if let Some(convert) = &entry.convert {
            for out in &convert.outputs {
                if model_dir.join(&out.path).exists() {
                    quantized_variants.push(out.variant.clone());
                }
            }
        }

        let status = if downloaded_files.len() == entry.files.len() {
            "downloaded".to_string()
        } else if downloaded_files.is_empty() {
            "not_downloaded".to_string()
        } else {
            "partial".to_string()
        };

        models.push(ModelStatusInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            category: entry.category.clone(),
            optional: entry.optional,
            url: entry.url.clone(),
            files: entry
                .files
                .iter()
                .map(|f| ManifestFileInfo {
                    url: f.url.clone(),
                    dest: f.dest.clone(),
                    sha256: f.sha256.clone(),
                })
                .collect(),
            downloaded_files,
            total_size,
            downloaded_size,
            status,
            quantized_variants,
            quantizable: entry.quantizable.clone(),
            required_by: entry.required_by.clone(),
        });
    }

    Ok(models)
}

/// Start downloading a model.
pub async fn download_model(
    model_dir: &Path,
    model_id: &str,
    progress_map: &DownloadProgressMap,
    cancel_tokens: &CancelTokens,
) -> Result<ModelActionOutcome> {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = read_manifest(data_dir)?;

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Ok(ModelActionOutcome {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            });
        }
    };

    // Check if already downloading
    {
        let progress = progress_map.lock().await;
        if let Some(p) = progress.get(model_id) {
            if p.status == "downloading" {
                return Ok(ModelActionOutcome {
                    success: false,
                    message: format!("Model '{}' is already being downloaded", model_id),
                });
            }
        }
    }

    // Initialize progress
    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut tokens = cancel_tokens.lock().await;
        tokens.insert(model_id.to_string(), cancel_token.clone());
    }

    let total_files = entry.files.len();
    {
        let mut progress = progress_map.lock().await;
        progress.insert(
            model_id.to_string(),
            DownloadProgress {
                model_id: model_id.to_string(),
                status: "downloading".to_string(),
                files_total: total_files,
                files_completed: 0,
                bytes_total: 0,
                bytes_downloaded: 0,
                bytes_per_second: 0,
                elapsed_secs: 0.0,
                error: None,
            },
        );
    }

    let model_id_owned = model_id.to_string();
    let files: Vec<_> = entry.files.iter().map(|f| (f.url.clone(), f.dest.clone(), f.sha256.clone())).collect();
    let model_dir_owned = model_dir.to_path_buf();
    let progress_map_clone = progress_map.clone();
    let cancel_tokens_clone = cancel_tokens.clone();

    tokio::spawn(async move {
        let start_time = Instant::now();
        let mut bytes_downloaded_total: u64 = 0;
        let mut bytes_total: u64 = 0;
        let mut files_completed: usize = 0;

        // Calculate total size from existing files and URLs
        for (_, dest, _) in &files {
            let path = model_dir_owned.join(dest);
            if let Ok(meta) = std::fs::metadata(&path) {
                bytes_total += meta.len();
            }
        }

        for (url, dest, expected_sha) in files.iter() {
            // Check for cancellation
            {
                let tokens = cancel_tokens_clone.lock().await;
                if let Some(token) = tokens.get(&model_id_owned) {
                    if token.is_cancelled() {
                        let mut progress = progress_map_clone.lock().await;
                        if let Some(p) = progress.get_mut(&model_id_owned) {
                            p.status = "cancelled".to_string();
                        }
                        return;
                    }
                }
            }

            let dest_path = model_dir_owned.join(dest);

            // Skip if file exists and checksum matches
            if dest_path.exists() && !expected_sha.is_empty() {
                if let Ok(existing) = std::fs::read(&dest_path) {
                    let mut hasher = Sha256::new();
                    hasher.update(&existing);
                    let hash = format!("{:x}", hasher.finalize());
                    if hash == *expected_sha {
                        files_completed += 1;
                        continue;
                    }
                }
            }

            // Skip if file exists and no checksum to validate
            if dest_path.exists() && expected_sha.is_empty() {
                files_completed += 1;
                continue;
            }

            // Create parent directory
            if let Some(parent) = dest_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(format!("Failed to create directory: {}", e));
                    }
                    return;
                }
            }

            // Download
            info!("Downloading {} -> {:?}", url, dest_path);
            let config = ureq::config::Config::builder()
                .max_redirects(10)
                .timeout_global(Some(Duration::from_secs(60)))
                .build();
            let agent = config.new_agent();
            let mut response = match agent.get(url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Curator/1.0")
                .call() {
                Ok(r) => r,
                Err(e) => {
                    let err_msg = format!("Download failed for {}: {}", url, e);
                    error!("{}", err_msg);
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(err_msg);
                    }
                    return;
                }
            };

            // Get content length for progress
            let content_length = response
                .headers()
                .get("Content-Length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            bytes_total += content_length;

            // Stream to temp file
            let temp_path = dest_path.with_extension("tmp");
            let mut reader = response.body_mut().as_reader();
            let mut file = match std::fs::File::create(&temp_path) {
                Ok(f) => f,
                Err(e) => {
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(format!("Failed to create temp file: {}", e));
                    }
                    return;
                }
            };

            let mut file_bytes_downloaded: u64 = 0;
            let mut buf = [0u8; 64 * 1024]; // 64KB buffer
            loop {
                use std::io::Read;
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => {
                        let _ = std::fs::remove_file(&temp_path);
                        let mut progress = progress_map_clone.lock().await;
                        if let Some(p) = progress.get_mut(&model_id_owned) {
                            p.status = "failed".to_string();
                            p.error = Some(format!("Read error: {}", e));
                        }
                        return;
                    }
                };

                if let Err(e) = std::io::Write::write_all(&mut file, &buf[..n]) {
                    let _ = std::fs::remove_file(&temp_path);
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(format!("Write error: {}", e));
                    }
                    return;
                }

                file_bytes_downloaded += n as u64;
                bytes_downloaded_total += n as u64;

                // Update progress every 100KB
                if file_bytes_downloaded % (100 * 1024) < n as u64 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let bps = if elapsed > 0.0 {
                        (bytes_downloaded_total as f64 / elapsed) as u64
                    } else {
                        0
                    };

                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.bytes_downloaded = bytes_downloaded_total;
                        p.bytes_total = bytes_total;
                        p.bytes_per_second = bps;
                        p.elapsed_secs = elapsed;
                    }
                }
            }

            // Validate checksum if provided
            if !expected_sha.is_empty() {
                let content = match std::fs::read(&temp_path) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = std::fs::remove_file(&temp_path);
                        let mut progress = progress_map_clone.lock().await;
                        if let Some(p) = progress.get_mut(&model_id_owned) {
                            p.status = "failed".to_string();
                            p.error = Some(format!("Failed to read downloaded file: {}", e));
                        }
                        return;
                    }
                };
                let mut hasher = Sha256::new();
                hasher.update(&content);
                let hash = format!("{:x}", hasher.finalize());
                if hash != *expected_sha {
                    let err_msg = format!("Checksum mismatch for {}: expected {}, got {}", dest, expected_sha, hash);
                    error!("{}", err_msg);
                    let _ = std::fs::remove_file(&temp_path);
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(err_msg);
                    }
                    return;
                }
            }

            // Move temp file to final destination
            if let Err(e) = std::fs::rename(&temp_path, &dest_path) {
                let err_msg = format!("Failed to move temp file to {:?}: {}", dest_path, e);
                error!("{}", err_msg);
                let _ = std::fs::remove_file(&temp_path);
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(&model_id_owned) {
                    p.status = "failed".to_string();
                    p.error = Some(err_msg);
                }
                return;
            }

            files_completed += 1;
            info!("Downloaded {}/{}: {:?}", files_completed, total_files, dest_path);

            // Update progress
            let elapsed = start_time.elapsed().as_secs_f64();
            let bps = if elapsed > 0.0 {
                (bytes_downloaded_total as f64 / elapsed) as u64
            } else {
                0
            };
            let mut progress = progress_map_clone.lock().await;
            if let Some(p) = progress.get_mut(&model_id_owned) {
                p.files_completed = files_completed;
                p.bytes_downloaded = bytes_downloaded_total;
                p.bytes_total = bytes_total;
                p.bytes_per_second = bps;
                p.elapsed_secs = elapsed;
            }
        }

        // Mark as completed
        let mut progress = progress_map_clone.lock().await;
        if let Some(p) = progress.get_mut(&model_id_owned) {
            p.status = "completed".to_string();
            p.bytes_per_second = 0;
        }

        // Clean up cancel token
        let mut tokens = cancel_tokens_clone.lock().await;
        tokens.remove(&model_id_owned);

        info!("Model '{}' download completed", model_id_owned);
    });

    Ok(ModelActionOutcome {
        success: true,
        message: format!("Download started for model '{}'", model_id),
    })
}

const FFMPEG_DOWNLOAD_ID: &str = "ffmpeg-portable";/// Portable Windows FFmpeg essentials build (ffmpeg.exe + ffprobe.exe + a few
/// DLLs). Pinned to the `release` branch so the URL never depends on a version
/// string; integrity is verified by executing `ffmpeg -version` after unpack.
const FFMPEG_DOWNLOAD_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/// Download the portable FFmpeg build into `<data_dir>/bin/` as a background
/// job. Progress is recorded on the shared download progress map under the
/// reserved id "ffmpeg-portable" and surfaced through GetDownloadProgress.
/// On completion, `ffmpeg.exe`/`ffprobe.exe` are verified by running
/// `-version`; a failed verification surfaces as an error (no silent fallback).
pub async fn download_ffmpeg(
    data_dir: &Path,
    progress_map: &DownloadProgressMap,
    cancel_tokens: &CancelTokens,
) -> Result<FFmpegDownloadOutcome> {
    let bin_dir = data_dir.join("bin");
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        return Ok(FFmpegDownloadOutcome {
            started: false,
            message: format!("Failed to create bin directory: {}", e),
        });
    }

    // Already downloading?
    {
        let progress = progress_map.lock().await;
        if let Some(p) = progress.get(FFMPEG_DOWNLOAD_ID) {
            if p.status == "downloading" {
                return Ok(FFmpegDownloadOutcome {
                    started: false,
                    message: "FFmpeg download already in progress".to_string(),
                });
            }
        }
    }

    // Already installed (verified) — bail early with a clear message.
    let ffmpeg_exe = bin_dir.join("ffmpeg.exe");
    if ffmpeg_exe.exists() {
        let ok = probe_ffmpeg_binary(&ffmpeg_exe);
        if ok {
            return Ok(FFmpegDownloadOutcome {
                started: false,
                message: "FFmpeg is already installed and verified".to_string(),
            });
        }
    }

    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut tokens = cancel_tokens.lock().await;
        tokens.insert(FFMPEG_DOWNLOAD_ID.to_string(), cancel_token.clone());
    }
    {
        let mut progress = progress_map.lock().await;
        progress.insert(
            FFMPEG_DOWNLOAD_ID.to_string(),
            DownloadProgress {
                model_id: FFMPEG_DOWNLOAD_ID.to_string(),
                status: "downloading".to_string(),
                files_total: 1,
                files_completed: 0,
                bytes_total: 0,
                bytes_downloaded: 0,
                bytes_per_second: 0,
                elapsed_secs: 0.0,
                error: None,
            },
        );
    }

    let data_dir_owned = data_dir.to_path_buf();
    let bin_dir_owned = bin_dir;
    let progress_map_clone = progress_map.clone();
    let cancel_tokens_clone = cancel_tokens.clone();

    tokio::spawn(async move {
        let start_time = Instant::now();
        let zip_path = data_dir_owned.join("bin").join("ffmpeg-release-essentials.zip");
        let temp_path = zip_path.with_extension("tmp");

        // ── 1. Download zip (streamed, byte-progress reported) ─────────────
        let config = ureq::config::Config::builder()
            .max_redirects(10)
            .timeout_global(Some(Duration::from_secs(60)))
            .build();
        let agent = config.new_agent();
        let mut response = match agent.get(FFMPEG_DOWNLOAD_URL).call() {
            Ok(r) => r,
            Err(e) => {
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "failed".to_string();
                    p.error = Some(format!("Download failed: {}", e));
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }
        };

        let content_length = response
            .headers()
            .get("Content-Length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let mut reader = response.body_mut().as_reader();
        let mut file = match std::fs::File::create(&temp_path) {
            Ok(f) => f,
            Err(e) => {
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "failed".to_string();
                    p.error = Some(format!("Failed to create temp file: {}", e));
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }
        };

        let mut downloaded: u64 = 0;
        let mut buf = [0u8; 64 * 1024];
        loop {
            if cancel_tokens_clone.lock().await.get(FFMPEG_DOWNLOAD_ID).map(|t| t.is_cancelled()).unwrap_or(false) {
                let _ = std::fs::remove_file(&temp_path);
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "cancelled".to_string();
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }

            let n = match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    let _ = std::fs::remove_file(&temp_path);
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                        p.status = "failed".to_string();
                        p.error = Some(format!("Download read error: {}", e));
                    }
                    let mut tokens = cancel_tokens_clone.lock().await;
                    tokens.remove(FFMPEG_DOWNLOAD_ID);
                    return;
                }
            };
            if let Err(e) = std::io::Write::write_all(&mut file, &buf[..n]) {
                let _ = std::fs::remove_file(&temp_path);
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "failed".to_string();
                    p.error = Some(format!("Download write error: {}", e));
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }
            downloaded += n as u64;
            let elapsed = start_time.elapsed().as_secs_f64();
            let bps = if elapsed > 0.0 { (downloaded as f64 / elapsed) as u64 } else { 0 };
            let mut progress = progress_map_clone.lock().await;
            if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                p.bytes_downloaded = downloaded;
                p.bytes_total = content_length.max(downloaded);
                p.bytes_per_second = bps;
                p.elapsed_secs = elapsed;
            }
        }
        drop(file);

        if let Err(e) = std::fs::rename(&temp_path, &zip_path) {
            let _ = std::fs::remove_file(&temp_path);
            let mut progress = progress_map_clone.lock().await;
            if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                p.status = "failed".to_string();
                p.error = Some(format!("Failed to finalize download: {}", e));
            }
            let mut tokens = cancel_tokens_clone.lock().await;
            tokens.remove(FFMPEG_DOWNLOAD_ID);
            return;
        }

        // ── 2. Extract ffmpeg.exe + ffprobe.exe into bin/ ─────────────────
        // Signal extracting state so the frontend can update its label.
        {
            let mut progress = progress_map_clone.lock().await;
            if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                p.status = "extracting".to_string();
            }
        }

        // zip::ZipArchive holds a non-Send reader, so extraction runs on a
        // blocking thread; the extracted count/error are reported afterwards.
        let extract_res = {
            let bin_dir_extract = bin_dir_owned.clone();
            let zip_path_extract = zip_path.clone();
            tokio::task::spawn_blocking(move || extract_ffmpeg_binaries(&zip_path_extract, &bin_dir_extract))
                .await
        };
        let _ = std::fs::remove_file(&zip_path);

        let extracted = match extract_res {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "failed".to_string();
                    p.error = Some(e);
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }
            Err(e) => {
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
                    p.status = "failed".to_string();
                    p.error = Some(format!("Extraction task failed: {}", e));
                }
                let mut tokens = cancel_tokens_clone.lock().await;
                tokens.remove(FFMPEG_DOWNLOAD_ID);
                return;
            }
        };

        let mut progress = progress_map_clone.lock().await;
        if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
            p.files_completed = extracted;
        }
        drop(progress);

        // ── 3. Verify by executing ffmpeg -version ─────────────────────────
        let ffmpeg_path = bin_dir_owned.join("ffmpeg.exe");
        let verified = probe_ffmpeg_binary(&ffmpeg_path);
        let mut progress = progress_map_clone.lock().await;
        if let Some(p) = progress.get_mut(FFMPEG_DOWNLOAD_ID) {
            if verified {
                p.status = "completed".to_string();
                p.error = None;
            } else {
                p.status = "failed".to_string();
                p.error = Some(format!(
                    "FFmpeg extracted but failed verification ({}); try re-downloading",
                    ffmpeg_path.display()
                ));
            }
            p.bytes_per_second = 0;
        }
        drop(progress);

        let mut tokens = cancel_tokens_clone.lock().await;
        tokens.remove(FFMPEG_DOWNLOAD_ID);

        if verified {
            info!("FFmpeg download completed and verified at {:?}", ffmpeg_path);
        } else {
            error!("FFmpeg download completed but verification failed at {:?}", ffmpeg_path);
        }
    });

    Ok(FFmpegDownloadOutcome {
        started: true,
        message: format!("FFmpeg download started from {}", FFMPEG_DOWNLOAD_URL),
    })
}

/// Run `ffmpeg -version` and return whether it exited successfully.
fn probe_ffmpeg_binary(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Walk a downloaded FFmpeg archive and write `ffmpeg.exe`/`ffprobe.exe` (from
/// the build's `bin/` folder) into `bin_dir`. Runs on a blocking thread.
fn extract_ffmpeg_binaries(zip_path: &Path, bin_dir: &Path) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open downloaded archive: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Corrupt FFmpeg archive: {}", e))?;

    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let target = match name.rsplit('/').next() {
            Some(base) if base == "ffmpeg.exe" || base == "ffprobe.exe" => base.to_string(),
            _ => continue,
        };
        let dest_path = bin_dir.join(&target);
        let mut out = std::fs::File::create(&dest_path)
            .map_err(|e| format!("Failed to write {}: {}", target, e))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Failed to extract {}: {}", target, e))?;
        extracted += 1;
    }

    if extracted < 2 {
        return Err(format!(
            "Archive did not contain ffmpeg.exe/ffprobe.exe (found {} binary)", extracted
        ));
    }
    Ok(extracted)
}

/// Cancel an in-progress download.
pub async fn cancel_download(
    model_id: &str,
    progress_map: &DownloadProgressMap,
    cancel_tokens: &CancelTokens,
) -> Result<ModelActionOutcome> {
    let tokens = cancel_tokens.lock().await;
    if let Some(token) = tokens.get(model_id) {
        token.cancel();
    }

    let mut progress = progress_map.lock().await;
    if let Some(p) = progress.get_mut(model_id) {
        if p.status == "downloading" {
            p.status = "cancelled".to_string();
            return Ok(ModelActionOutcome {
                success: true,
                message: format!("Download cancelled for model '{}'", model_id),
            });
        }
    }

    Ok(ModelActionOutcome {
        success: false,
        message: format!("No active download for model '{}'", model_id),
    })
}

/// Remove model files from disk.
pub async fn remove_model(model_dir: &Path, model_id: &str) -> Result<ModelActionOutcome> {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = read_manifest(data_dir)?;

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Ok(ModelActionOutcome {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            });
        }
    };

    let mut removed = 0;
    for file in &entry.files {
        let path = model_dir.join(&file.dest);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                warn!("Failed to remove {:?}: {}", path, e);
            } else {
                removed += 1;
                info!("Removed {:?}", path);
            }
        }
    }

    // Remove model directory and all converted/quantized subdirectories if it exists
    let model_folder = model_dir.join(model_id);
    if model_folder.exists() {
        if let Err(e) = std::fs::remove_dir_all(&model_folder) {
            warn!("Failed to remove model directory {:?}: {}", model_folder, e);
        } else {
            info!("Removed model directory {:?}", model_folder);
        }
    }

    // Clean up empty parent directories
    for file in &entry.files {
        let path = model_dir.join(&file.dest);
        if let Some(parent) = path.parent() {
            if parent.exists() && parent != model_dir {
                let _ = std::fs::remove_dir(parent); // Ignore error if not empty
            }
        }
    }

    Ok(ModelActionOutcome {
        success: true,
        message: format!("Removed {} files for model '{}'", removed, model_id),
    })
}

/// Get progress for all active downloads.
pub async fn get_download_progress(progress_map: &DownloadProgressMap) -> Result<Vec<DownloadProgress>> {
    let progress = progress_map.lock().await;
    let downloads: Vec<DownloadProgress> = progress
        .values()
        .filter(|p| p.status == "downloading" || p.status == "quantizing")
        .cloned()
        .collect();

    Ok(downloads)
}

/// Quantize a downloaded model.
pub async fn quantize_model(
    model_dir: &Path,
    model_id: &str,
    format: &str,
) -> Result<ModelActionOutcome> {
    if format != "fp16" && format != "int8" {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!("Unsupported quantization format: {}", format),
        });
    }

    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = read_manifest(data_dir)?;

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Ok(ModelActionOutcome {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            });
        }
    };

    if entry.quantizable.is_empty() || !entry.quantizable.contains(&format.to_string()) {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!(
                "Model '{}' does not support quantization to {}",
                model_id, format
            ),
        });
    }

    // Find Python venv and quantization script
    let project_root = find_script_root("quantize-models.py", data_dir.to_path_buf());

    let venv_python = project_root.join("scripts/venv/Scripts/python.exe");
    let script = project_root.join("scripts/quantize-models.py");

    if !venv_python.exists() || !script.exists() {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!(
                "Quantization environment not set up. Run scripts/setup-python-env.ps1 first. (Checked: {:?} and {:?})",
                venv_python, script
            ),
        });
    }

    let mut onnx_paths = Vec::new();
    for file in &entry.files {
        if file.dest.ends_with(".onnx") {
            let input_path = model_dir.join(&file.dest);
            if input_path.exists() {
                onnx_paths.push(input_path);
            }
        }
    }
    if let Some(convert) = &entry.convert {
        for out in &convert.outputs {
            if out.path.ends_with(".onnx") {
                let input_path = model_dir.join(&out.path);
                if input_path.exists() {
                    onnx_paths.push(input_path);
                }
            }
        }
    }

    let mut quantized_count = 0;
    for input_path in onnx_paths {
        let file_name = input_path.file_name().unwrap().to_str().unwrap();
        let output_name = file_name.replace(".onnx", &format!("_{}.onnx", format));
        let output_path = input_path.parent().unwrap().join(output_name);

        let output = std::process::Command::new(&venv_python)
            .arg(script.to_str().unwrap())
            .args(["--input", input_path.to_str().unwrap()])
            .args(["--output", output_path.to_str().unwrap()])
            .args(["--format", format])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                quantized_count += 1;
                info!("Quantized {:?} -> {:?}", input_path, output_path);
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                return Ok(ModelActionOutcome {
                    success: false,
                    message: format!(
                        "Quantization failed for {}: exit code {:?}.\nStderr: {}\nStdout: {}",
                        input_path.display(), out.status.code(), stderr.trim(), stdout.trim()
                    ),
                });
            }
            Err(e) => {
                return Ok(ModelActionOutcome {
                    success: false,
                    message: format!("Failed to run quantization command for {}: {}", input_path.display(), e),
                });
            }
        }
    }

    Ok(ModelActionOutcome {
        success: true,
        message: format!(
            "Quantized {} files to {} for model '{}'",
            quantized_count, format, model_id
        ),
    })
}

pub static CONVERSION_RUNNING_MODEL: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
pub static CONVERSION_LOGS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();

/// In-app conversion of a downloaded Safetensors model to ONNX.
///
/// Driven entirely by the model manifest's `convert` spec: discovers the
/// declared conversion script and runs it with `--skip-download` (the manifest
/// already downloaded the source files into the model dir). Fails fast with
/// captured output on error.
pub async fn convert_model(model_dir: &Path, model_id: &str) -> Result<ModelActionOutcome> {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = read_manifest(data_dir)?;

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Ok(ModelActionOutcome {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            });
        }
    };

    let convert = match &entry.convert {
        Some(c) => c,
        None => {
            return Ok(ModelActionOutcome {
                success: false,
                message: format!(
                    "Model '{}' does not require conversion (no 'convert' spec in manifest)",
                    model_id
                ),
            });
        }
    };

    if convert.script.is_empty() {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!("Model '{}' manifest 'convert' spec has no script", model_id),
        });
    }

    let model_out = model_dir.join(model_id);
    let missing: Vec<String> = entry
        .files
        .iter()
        .filter(|f| !model_dir.join(&f.dest).exists())
        .map(|f| f.dest.clone())
        .collect();
    if !missing.is_empty() {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!(
                "Source files for '{}' not fully downloaded into {:?}. Missing: {}. Download the model first.",
                model_id,
                model_out,
                missing.join(", ")
            ),
        });
    }

    let project_root = find_script_root(&convert.script, model_dir.to_path_buf());
    let venv_python = project_root.join("scripts").join("venv").join("Scripts").join("python.exe");
    let script = project_root.join("scripts").join(&convert.script);

    if !venv_python.exists() || !script.exists() {
        return Ok(ModelActionOutcome {
            success: false,
            message: format!(
                "Conversion environment not set up. Run scripts/setup-python-env.ps1 first. (Checked: {:?} and {:?})",
                venv_python, script
            ),
        });
    }

    let running_mutex = CONVERSION_RUNNING_MODEL.get_or_init(|| std::sync::Mutex::new(None));
    {
        let mut active = running_mutex.lock().unwrap();
        if active.is_some() {
            return Ok(ModelActionOutcome {
                success: false,
                message: "Another conversion process is already running.".to_string(),
            });
        }
        *active = Some(model_id.to_string());
    }

    let out_dir_abs = model_out.to_path_buf();
    let logs_mutex = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    logs_mutex.lock().unwrap().insert(model_id.to_string(), "Starting conversion process...\n".to_string());

    let repo_arg = convert.repo.clone();

    let target_model_id = model_id.to_string();
    let mut cmd = tokio::process::Command::new(&venv_python);
    cmd.arg(script.to_str().unwrap())
        .args(["--repo", &repo_arg])
        .args(["--out-dir", out_dir_abs.to_str().unwrap()])
        .args(["--skip-download"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    match cmd.spawn() {
        Ok(mut child) => {
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let model_id_clone = target_model_id.clone();

            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                
                let mut stdout_reader = BufReader::new(stdout).lines();
                let mut stderr_reader = BufReader::new(stderr).lines();

                loop {
                    tokio::select! {
                        line_opt = stdout_reader.next_line() => {
                            if let Ok(Some(line)) = line_opt {
                                let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                                let mut map = logs_m.lock().unwrap();
                                let entry = map.entry(model_id_clone.clone()).or_default();
                                entry.push_str(&line);
                                entry.push('\n');
                            }
                        }
                        line_opt = stderr_reader.next_line() => {
                            if let Ok(Some(line)) = line_opt {
                                let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                                let mut map = logs_m.lock().unwrap();
                                let entry = map.entry(model_id_clone.clone()).or_default();
                                entry.push_str(&line);
                                entry.push('\n');
                            }
                        }
                        status = child.wait() => {
                            let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                            let mut map = logs_m.lock().unwrap();
                            let entry = map.entry(model_id_clone.clone()).or_default();
                            match status {
                                Ok(s) if s.success() => {
                                    entry.push_str("\nConversion finished successfully.\n");
                                    info!("Background conversion of {} succeeded.", model_id_clone);
                                }
                                Ok(s) => {
                                    entry.push_str(&format!("\nConversion failed with exit status: {:?}\n", s.code()));
                                    error!("Background conversion of {} failed with code: {:?}", model_id_clone, s.code());
                                }
                                Err(e) => {
                                    entry.push_str(&format!("\nError waiting for conversion child: {}\n", e));
                                    error!("Error waiting for background conversion child for {}: {}", model_id_clone, e);
                                }
                            }
                            break;
                        }
                    }
                }
                let running_m = CONVERSION_RUNNING_MODEL.get_or_init(|| std::sync::Mutex::new(None));
                let mut active = running_m.lock().unwrap();
                if active.as_deref() == Some(&model_id_clone) {
                    *active = None;
                }
            });
        }
        Err(e) => {
            let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
            let mut map = logs_m.lock().unwrap();
            let entry = map.entry(target_model_id.clone()).or_default();
            entry.push_str(&format!("Failed to spawn conversion command: {}\n", e));
            error!("Failed to spawn background conversion command for {}: {}", target_model_id, e);
            let running_m = CONVERSION_RUNNING_MODEL.get_or_init(|| std::sync::Mutex::new(None));
            let mut active = running_m.lock().unwrap();
            if active.as_deref() == Some(&target_model_id) {
                *active = None;
            }
        }
    }

    Ok(ModelActionOutcome {
        success: true,
        message: "Conversion started in background.".to_string(),
    })
}

pub async fn get_conversion_logs(_model_dir: &Path, model_id: &str) -> Result<ConversionLogs> {
    let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let logs = logs_m.lock().unwrap().get(model_id).cloned().unwrap_or_default();

    let running_m = CONVERSION_RUNNING_MODEL.get_or_init(|| std::sync::Mutex::new(None));
    let is_running = running_m.lock().unwrap().as_deref() == Some(model_id);

    Ok(ConversionLogs {
        logs,
        is_running,
    })
}
