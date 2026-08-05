use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use curator_core::ipc::{
    DownloadProgress, ManifestFileInfo, ModelStatusInfo, Response,
};
use sha2::{Sha256, Digest};
use tokio::sync::Mutex;
use tracing::{info, warn, error};

/// Shared state for tracking active downloads.
pub type DownloadProgressMap = Arc<Mutex<HashMap<String, DownloadProgress>>>;

/// Cancellation tokens for active downloads.
pub type CancelTokens = Arc<Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>;

/// Read the model manifest from disk.
fn read_manifest(data_dir: &Path) -> Result<Vec<ModelManifestEntry>, String> {
    let manifest_path = data_dir.join("model_manifest.json");
    if !manifest_path.exists() {
        return Err(format!("Model manifest not found at {:?}", manifest_path));
    }
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: ModelManifest =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse manifest: {}", e))?;
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
}

#[derive(serde::Deserialize)]
struct ManifestFileEntry {
    url: String,
    dest: String,
    sha256: String,
}

/// Get download status for all models.
pub async fn get_model_status(
    model_dir: &Path,
    progress_map: &DownloadProgressMap,
) -> Response {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = match read_manifest(data_dir) {
        Ok(e) => e,
        Err(e) => {
            return Response::Error { message: e };
        }
    };

    let _progress = progress_map.lock().await;
    let mut models = Vec::new();

    for entry in &entries {
        let mut downloaded_files = Vec::new();
        let mut total_size: u64 = 0;
        let mut downloaded_size: u64 = 0;

        for file in &entry.files {
            let dest_path = model_dir.join(&file.dest);
            if dest_path.exists() {
                downloaded_files.push(file.dest.clone());
                if let Ok(meta) = std::fs::metadata(&dest_path) {
                    downloaded_size += meta.len();
                }
            }
            // Estimate total size from file size if available, otherwise 0
            total_size += 0; // Will be set during download from Content-Length
        }

        // Check for quantized variants
        let mut quantized_variants = Vec::new();
        for format in &entry.quantizable {
            let mut all_exist = true;
            let mut has_any = false;
            for file in &entry.files {
                if file.dest.ends_with(".onnx") {
                    has_any = true;
                    let input_path = model_dir.join(&file.dest);
                    if let Some(file_name) = input_path.file_name().and_then(|f| f.to_str()) {
                        let output_name = file_name.replace(".onnx", &format!("_{}.onnx", format));
                        let output_path = input_path.parent().unwrap().join(output_name);
                        if !output_path.exists() {
                            all_exist = false;
                            break;
                        }
                    } else {
                        all_exist = false;
                    }
                }
            }
            if has_any && all_exist {
                quantized_variants.push(format.clone());
            }
        }

        if entry.id == "wd-eva02-tagger-2026-canary" {
            let onnx_path = model_dir.join("wd-eva02-tagger-2026-canary").join("wd-eva02-tagger-2026-canary.onnx");
            if onnx_path.exists() {
                quantized_variants.push("onnx".to_string());
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

    Response::ModelStatusResult { models }
}

/// Start downloading a model.
pub async fn download_model(
    model_dir: &Path,
    model_id: &str,
    progress_map: &DownloadProgressMap,
    cancel_tokens: &CancelTokens,
) -> Response {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = match read_manifest(data_dir) {
        Ok(e) => e,
        Err(e) => {
            return Response::Error { message: e };
        }
    };

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Response::ModelActionResult {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            };
        }
    };

    // Check if already downloading
    {
        let progress = progress_map.lock().await;
        if let Some(p) = progress.get(model_id) {
            if p.status == "downloading" {
                return Response::ModelActionResult {
                    success: false,
                    message: format!("Model '{}' is already being downloaded", model_id),
                };
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

        for (_i, (url, dest, expected_sha)) in files.iter().enumerate() {
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
            let agent = ureq::Agent::new_with_defaults();
            let mut response = match agent.get(url).call() {
                Ok(r) => r,
                Err(e) => {
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(format!("Download failed: {}", e));
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
                    let _ = std::fs::remove_file(&temp_path);
                    let mut progress = progress_map_clone.lock().await;
                    if let Some(p) = progress.get_mut(&model_id_owned) {
                        p.status = "failed".to_string();
                        p.error = Some(format!(
                            "Checksum mismatch: expected {}, got {}",
                            expected_sha, hash
                        ));
                    }
                    return;
                }
            }

            // Move temp file to final destination
            if let Err(e) = std::fs::rename(&temp_path, &dest_path) {
                let _ = std::fs::remove_file(&temp_path);
                let mut progress = progress_map_clone.lock().await;
                if let Some(p) = progress.get_mut(&model_id_owned) {
                    p.status = "failed".to_string();
                    p.error = Some(format!("Failed to move file: {}", e));
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

    Response::ModelActionResult {
        success: true,
        message: format!("Download started for model '{}'", model_id),
    }
}

/// Cancel an in-progress download.
pub async fn cancel_download(
    model_id: &str,
    progress_map: &DownloadProgressMap,
    cancel_tokens: &CancelTokens,
) -> Response {
    let tokens = cancel_tokens.lock().await;
    if let Some(token) = tokens.get(model_id) {
        token.cancel();
    }

    let mut progress = progress_map.lock().await;
    if let Some(p) = progress.get_mut(model_id) {
        if p.status == "downloading" {
            p.status = "cancelled".to_string();
            return Response::ModelActionResult {
                success: true,
                message: format!("Download cancelled for model '{}'", model_id),
            };
        }
    }

    Response::ModelActionResult {
        success: false,
        message: format!("No active download for model '{}'", model_id),
    }
}

/// Remove model files from disk.
pub async fn remove_model(model_dir: &Path, model_id: &str) -> Response {
    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = match read_manifest(data_dir) {
        Ok(e) => e,
        Err(e) => {
            return Response::Error { message: e };
        }
    };

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Response::ModelActionResult {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            };
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

    // Remove quantized variants if they exist
    let quant_dir = model_dir.join(model_id).join("quantized");
    if quant_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&quant_dir) {
            warn!("Failed to remove quantized dir {:?}: {}", quant_dir, e);
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

    Response::ModelActionResult {
        success: true,
        message: format!("Removed {} files for model '{}'", removed, model_id),
    }
}

/// Get progress for all active downloads.
pub async fn get_download_progress(progress_map: &DownloadProgressMap) -> Response {
    let progress = progress_map.lock().await;
    let downloads: Vec<DownloadProgress> = progress
        .values()
        .filter(|p| p.status == "downloading" || p.status == "quantizing")
        .cloned()
        .collect();

    Response::DownloadProgressResult { downloads }
}

/// Quantize a downloaded model.
pub async fn quantize_model(model_dir: &Path, model_id: &str, format: &str) -> Response {
    if format != "fp16" && format != "int8" {
        return Response::ModelActionResult {
            success: false,
            message: format!("Unsupported quantization format: {}", format),
        };
    }

    let data_dir = model_dir.parent().unwrap_or(model_dir);
    let entries = match read_manifest(data_dir) {
        Ok(e) => e,
        Err(e) => {
            return Response::Error { message: e };
        }
    };

    let entry = match entries.iter().find(|e| e.id == model_id) {
        Some(e) => e,
        None => {
            return Response::ModelActionResult {
                success: false,
                message: format!("Model '{}' not found in manifest", model_id),
            };
        }
    };

    if entry.quantizable.is_empty() || !entry.quantizable.contains(&format.to_string()) {
        return Response::ModelActionResult {
            success: false,
            message: format!(
                "Model '{}' does not support quantization to {}",
                model_id, format
            ),
        };
    }

    // Find Python venv and quantization script
    let mut project_root = std::env::current_dir().unwrap_or_else(|_| data_dir.to_path_buf());
    let found = project_root.join("scripts/venv/Scripts/python.exe").exists()
        && project_root.join("scripts/quantize-models.py").exists();
    
    // If not found in CWD, walk up from the current executable path
    if !found {
        if let Ok(exe_path) = std::env::current_exe() {
            let mut p = exe_path.as_path();
            for _ in 0..5 {
                if let Some(parent) = p.parent() {
                    if parent.join("scripts/venv/Scripts/python.exe").exists()
                        && parent.join("scripts/quantize-models.py").exists()
                    {
                        project_root = parent.to_path_buf();
                        break;
                    }
                    p = parent;
                }
            }
        }
    }

    let venv_python = project_root.join("scripts/venv/Scripts/python.exe");
    let script = project_root.join("scripts/quantize-models.py");

    if !venv_python.exists() || !script.exists() {
        return Response::ModelActionResult {
            success: false,
            message: format!(
                "Quantization environment not set up. Run scripts/setup-python-env.ps1 first. (Checked: {:?} and {:?})",
                venv_python, script
            ),
        };
    }

    let mut quantized_count = 0;
    for file in &entry.files {
        if !file.dest.ends_with(".onnx") {
            continue;
        }
        let input_path = model_dir.join(&file.dest);
        if !input_path.exists() {
            continue;
        }

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
                return Response::ModelActionResult {
                    success: false,
                    message: format!(
                        "Quantization failed for {}: exit code {:?}.\nStderr: {}\nStdout: {}",
                        file.dest, out.status.code(), stderr.trim(), stdout.trim()
                    ),
                };
            }
            Err(e) => {
                return Response::ModelActionResult {
                    success: false,
                    message: format!("Failed to run quantization command for {}: {}", file.dest, e),
                };
            }
        }
    }

    Response::ModelActionResult {
        success: true,
        message: format!(
            "Quantized {} files to {} for model '{}'",
            quantized_count, format, model_id
        ),
    }
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub static CONVERSION_RUNNING: AtomicBool = AtomicBool::new(false);
pub static CONVERSION_LOGS: OnceLock<std::sync::Mutex<String>> = OnceLock::new();

/// In-app conversion of a downloaded Safetensors tagger to ONNX.
///
/// Mirrors `quantize_model`: discovers scripts/venv and runs
/// `convert_to_onnx.py --skip-download` (the manifest already downloaded the
/// source files into the model dir). Fails fast with captured output on error.
pub async fn convert_model(model_dir: &Path, model_id: &str) -> Response {
    // Only the WD tagger is Safetensors-distributed and needs conversion.
    if model_id != "wd-eva02-tagger-2026-canary" {
        return Response::ModelActionResult {
            success: false,
            message: format!(
                "Model '{}' does not require conversion (only wd-eva02-tagger-2026-canary does)",
                model_id
            ),
        };
    }

    let model_out = model_dir.join("wd-eva02-tagger-2026-canary");
    let source_files_ok = ["model.safetensors", "selected_tags.csv", "config.json"]
        .iter()
        .all(|f| model_out.join(f).exists());
    if !source_files_ok {
        return Response::ModelActionResult {
            success: false,
            message: format!(
                "Source files for '{}' not fully downloaded into {:?}. Download the model first.",
                model_id, model_out
            ),
        };
    }

    let mut project_root = std::env::current_dir().unwrap_or_else(|_| {
        model_dir.parent().unwrap_or(model_dir).to_path_buf()
    });
    let found = project_root.join("scripts/venv/Scripts/python.exe").exists()
        && project_root.join("scripts/convert_to_onnx.py").exists();
    if !found {
        if let Ok(exe_path) = std::env::current_exe() {
            let mut p = exe_path.as_path();
            for _ in 0..5 {
                if let Some(parent) = p.parent() {
                    if parent.join("scripts/venv/Scripts/python.exe").exists()
                        && parent.join("scripts/convert_to_onnx.py").exists()
                    {
                        project_root = parent.to_path_buf();
                        break;
                    }
                    p = parent;
                }
            }
        }
    }

    let venv_python = project_root.join("scripts/venv/Scripts/python.exe");
    let script = project_root.join("scripts/convert_to_onnx.py");

    if !venv_python.exists() || !script.exists() {
        return Response::ModelActionResult {
            success: false,
            message: format!(
                "Conversion environment not set up. Run scripts/setup-python-env.ps1 first. (Checked: {:?} and {:?})",
                venv_python, script
            ),
        };
    }

    if CONVERSION_RUNNING.load(Ordering::SeqCst) {
        return Response::ModelActionResult {
            success: false,
            message: "Another conversion process is already running.".to_string(),
        };
    }

    let out_dir_abs = model_out.to_path_buf();
    CONVERSION_RUNNING.store(true, Ordering::SeqCst);
    let logs_mutex = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
    *logs_mutex.lock().unwrap() = "Starting conversion process...\n".to_string();

    let mut cmd = tokio::process::Command::new(&venv_python);
    cmd.arg(script.to_str().unwrap())
        .args(["--repo", "ashen-sensored/wd-eva02-tagger-2026-canary"])
        .args(["--out-dir", out_dir_abs.to_str().unwrap()])
        .args(["--skip-download"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    match cmd.spawn() {
        Ok(mut child) => {
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();

            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                
                let mut stdout_reader = BufReader::new(stdout).lines();
                let mut stderr_reader = BufReader::new(stderr).lines();

                loop {
                    tokio::select! {
                        line_opt = stdout_reader.next_line() => {
                            match line_opt {
                                Ok(Some(line)) => {
                                    let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
                                    let mut logs = logs_m.lock().unwrap();
                                    logs.push_str(&line);
                                    logs.push('\n');
                                }
                                _ => {}
                            }
                        }
                        line_opt = stderr_reader.next_line() => {
                            match line_opt {
                                Ok(Some(line)) => {
                                    let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
                                    let mut logs = logs_m.lock().unwrap();
                                    logs.push_str(&line);
                                    logs.push('\n');
                                }
                                _ => {}
                            }
                        }
                        status = child.wait() => {
                            let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
                            let mut logs = logs_m.lock().unwrap();
                            match status {
                                Ok(s) if s.success() => {
                                    logs.push_str("\nConversion finished successfully.\n");
                                    info!("Background conversion of wd-eva02-tagger-2026-canary succeeded.");
                                }
                                Ok(s) => {
                                    logs.push_str(&format!("\nConversion failed with exit status: {:?}\n", s.code()));
                                    error!("Background conversion of wd-eva02-tagger-2026-canary failed with code: {:?}", s.code());
                                }
                                Err(e) => {
                                    logs.push_str(&format!("\nError waiting for conversion child: {}\n", e));
                                    error!("Error waiting for background conversion child: {}", e);
                                }
                            }
                            break;
                        }
                    }
                }
                CONVERSION_RUNNING.store(false, Ordering::SeqCst);
            });
        }
        Err(e) => {
            let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
            let mut logs = logs_m.lock().unwrap();
            logs.push_str(&format!("Failed to spawn conversion command: {}\n", e));
            error!("Failed to spawn background conversion command: {}", e);
            CONVERSION_RUNNING.store(false, Ordering::SeqCst);
        }
    }

    Response::ModelActionResult {
        success: true,
        message: "Conversion started in background.".to_string(),
    }
}

pub async fn get_conversion_logs(_model_dir: &Path, _model_id: &str) -> Response {
    let logs_m = CONVERSION_LOGS.get_or_init(|| std::sync::Mutex::new(String::new()));
    let logs = logs_m.lock().unwrap().clone();
    Response::ConversionLogsResult {
        logs,
        is_running: CONVERSION_RUNNING.load(Ordering::SeqCst),
    }
}
