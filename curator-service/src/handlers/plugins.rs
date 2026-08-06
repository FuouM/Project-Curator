use anyhow::Context;
use curator_core::image::{
    codecs::{avif::AvifEncoder, bmp::BmpEncoder, gif::GifEncoder, hdr::HdrEncoder, ico::IcoEncoder, jpeg::JpegEncoder, openexr::OpenExrEncoder, png::PngEncoder, pnm::PnmEncoder, qoi::QoiEncoder, tga::TgaEncoder, tiff::TiffEncoder, webp::WebPEncoder},
    DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder,
};
use curator_core::ipc::{ConvertedFileInfo, PluginInfo, Response};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{error, info};

use crate::AppSettings;

/// Shared state for active FFmpeg transcode jobs, keyed by `job_id`. Progress
/// is written by the spawned ffmpeg task and polled via `GetTranscodeProgress`
/// (the gRPC-over-pipe transport is unary request/response).
pub type TranscodeProgressMap =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, TranscodeJobState>>>;

#[derive(Clone)]
pub struct TranscodeJobState {
    pub running: bool,
    pub percent: f32,
    pub fps: f32,
    pub x_speed: f32,
    pub out_time_ms: i64,
    pub output_path: Option<String>,
    pub error: Option<String>,
    /// Full FFmpeg command line, exposed for verbose plugin logging.
    pub command: Option<String>,
    pub input_size_bytes: Option<u64>,
    pub output_size_bytes: Option<u64>,
    pub output_video_size_bytes: Option<u64>,
    pub output_audio_size_bytes: Option<u64>,
}

fn default_job_state(job_id: &str, output_path: String, input_size: Option<u64>) -> (String, TranscodeJobState) {
    (
        job_id.to_string(),
        TranscodeJobState {
            running: true,
            percent: 0.0,
            fps: 0.0,
            x_speed: 0.0,
            out_time_ms: 0,
            output_path: Some(output_path),
            error: None,
            command: None,
            input_size_bytes: input_size,
            output_size_bytes: None,
            output_video_size_bytes: None,
            output_audio_size_bytes: None,
        },
    )
}

/// Target formats accepted by `EphemeralConvertImages`, restricted to the
/// `image` crate's default-feature encode set. `avif` is encode-only here
/// (decoding would require the rejected native-dav1d `avif-native` feature).
const ENCODE_FORMATS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "qoi", "tga", "pnm", "hdr", "ico", "exr",
    "avif",
];

/// Resolve the workspace-root `plugins/` directory portably as
/// `data_dir.parent().join("plugins")`. Under the default resolution
/// (`data_dir` = `<workspace_root>/.curator`) the parent is the workspace root
/// that holds `curator-core/`, `curator-service/`, and the git-tracked
/// `plugins/`. Fails fast (no silent fallback) when `data_dir` has no parent,
/// e.g. a bare drive root.
fn plugin_root(data_dir: &Path) -> anyhow::Result<PathBuf> {
    let parent = data_dir.parent().context(format!(
        "data_dir {:?} has no parent; cannot resolve workspace-root plugins/ directory",
        data_dir
    ))?;
    Ok(parent.join("plugins"))
}

/// A plugin folder name must be a single path segment — no separators, no
/// `.`/`..`. Guards path traversal in the `plugins/` tree.
fn validate_plugin_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn parse_manifest(path: &Path, fallback_name: &str) -> PluginInfo {
    let manifest_path = path.to_string_lossy().into_owned();
    let empty = PluginInfo {
        name: fallback_name.to_string(),
        version: String::new(),
        description: String::new(),
        permissions: Vec::new(),
        ui: None,
        hooks: Vec::new(),
        loaded: false,
        enabled: true,
        manifest_path: manifest_path.clone(),
    };

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return empty,
    };
    let val: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return empty,
    };

    let get_str = |key: &str| {
        val.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let get_str_array = |key: &str| {
        val.get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    };

    let ui = val
        .get("components")
        .and_then(|c| c.get("ui"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    PluginInfo {
        name: get_str("name"),
        version: get_str("version"),
        description: get_str("description"),
        permissions: get_str_array("permissions"),
        ui,
        hooks: get_str_array("hooks"),
        loaded: true,
        enabled: true,
        manifest_path,
    }
}

pub async fn list_plugins(data_dir: &Path, settings: &Arc<tokio::sync::Mutex<AppSettings>>) -> Response {
    let root = match plugin_root(data_dir) {
        Ok(r) => r,
        Err(e) => return Response::Error { message: e.to_string() },
    };

    let enabled_map = { settings.lock().await.enabled_plugins.clone() };
    let mut plugins = Vec::new();

    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !validate_plugin_name(&name) {
                continue;
            }
            let mut info = parse_manifest(&dir.join("manifest.json"), &name);
            info.enabled = enabled_map.get(&name).copied().unwrap_or(true);
            plugins.push(info);
        }
    }

    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    Response::PluginsListResult { plugins }
}

pub async fn set_plugin_enabled(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
    plugin_name: &str,
    enabled: bool,
) -> Response {
    if !validate_plugin_name(plugin_name) {
        return Response::Error {
            message: format!("Invalid plugin name: {}", plugin_name),
        };
    }
    let root = match plugin_root(data_dir) {
        Ok(r) => r,
        Err(e) => return Response::Error { message: e.to_string() },
    };
    if !root.join(plugin_name).join("manifest.json").is_file() {
        return Response::Error {
            message: format!("Unknown plugin: {}", plugin_name),
        };
    }

    let mut s = settings.lock().await;
    s.enabled_plugins.insert(plugin_name.to_string(), enabled);
    let settings_to_save = s.clone();
    let data_dir_buf = data_dir.to_path_buf();
    drop(s);

    let save_res = tokio::task::spawn_blocking(move || crate::save_settings(&data_dir_buf, &settings_to_save))
        .await;
    match save_res {
        Ok(Ok(())) => {
            info!("Plugin enabled state persisted: {} -> {}", plugin_name, enabled);
            Response::Success
        }
        Ok(Err(e)) => Response::Error {
            message: format!("Failed to save settings: {:?}", e),
        },
        Err(e) => Response::Error {
            message: format!("Failed to save settings: {:?}", e),
        },
    }
}

pub async fn read_plugin_file(data_dir: &Path, plugin_name: &str, relative_path: &str) -> Response {
    if !validate_plugin_name(plugin_name) {
        return Response::Error {
            message: format!("Invalid plugin name: {}", plugin_name),
        };
    }

    // Reject traversal / absolute components before touching the filesystem.
    let rel = Path::new(relative_path);
    let has_traversal = rel.is_absolute()
        || relative_path.is_empty()
        || relative_path.split('/').any(|p| p == "..")
        || relative_path.split('\\').any(|p| p == "..");

    if has_traversal {
        return Response::Error {
            message: "relative_path must be a relative path inside the plugin folder".to_string(),
        };
    }

    let root = match plugin_root(data_dir) {
        Ok(r) => r,
        Err(e) => return Response::Error { message: e.to_string() },
    };
    let plugin_dir = root.join(plugin_name);

    // Canonicalize the plugin root and confirm the resolved file stays inside it
    // (path-traversal guard against symlinks / case tricks).
    let canonical_root = match plugin_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Response::Error {
                message: format!("Plugin folder not found: {}", plugin_name),
            }
        }
    };
    let file_path = plugin_dir.join(rel);
    let canonical_file = match file_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return Response::Error {
                message: format!("Failed to resolve plugin file: {:?}", e),
            }
        }
    };
    if !canonical_file.starts_with(&canonical_root) {
        return Response::Error {
            message: "Requested path escapes the plugin folder".to_string(),
        };
    }

    match fs::read_to_string(&canonical_file) {
        Ok(content) => Response::PluginFileResult { content },
        Err(e) => Response::Error {
            message: format!("Failed to read plugin file: {:?}", e),
        },
    }
}

pub async fn path_exists(path: &str) -> Response {
    let exists = Path::new(path).exists();
    Response::PathExistsResult { exists }
}

pub async fn convert_images(
    conversions: Vec<(String, String)>,
    quality: u8,
) -> Response {
    let mut converted = Vec::with_capacity(conversions.len());
    for (source, target) in conversions {
        converted.push(convert_one(&source, &target, quality).await);
    }
    Response::ConvertImagesResult { converted }
}

async fn convert_one(source: &str, target: &str, quality: u8) -> ConvertedFileInfo {
    let src = Path::new(source);
    let failure = |error: String| ConvertedFileInfo {
        source_path: source.to_string(),
        output_path: String::new(),
        error: Some(error),
    };

    if !src.is_file() {
        return failure(format!("Source file not found: {}", source));
    }

    let tgt = Path::new(target);
    let ext = match tgt.extension().and_then(|s| s.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return failure("Target path has no file extension".to_string()),
    };

    if !ENCODE_FORMATS.contains(&ext.as_str()) {
        return failure(format!(
            "Unsupported target format: '{}'. Supported: {}",
            ext,
            ENCODE_FORMATS.join(", ")
        ));
    }

    // Ensure output parent directory exists
    if let Some(parent) = tgt.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return failure(format!("Failed to create output directory: {:?}", e));
        }
    }

    let source_buf = source.to_string();
    let out_buf = target.to_string();
    let out_buf_for_task = out_buf.clone();
    let ext_buf = ext.clone();
    let quality = quality.clamp(1, 100);

    // Decode/encode is CPU- and disk-bound — off the reactor thread.
    let res = tokio::task::spawn_blocking(move || encode_image(&source_buf, &out_buf_for_task, &ext_buf, quality)).await;

    match res {
        Ok(Ok(())) => ConvertedFileInfo {
            source_path: source.to_string(),
            output_path: out_buf,
            error: None,
        },
        Ok(Err(e)) => failure(e),
        Err(e) => failure(format!("Task join panicked: {:?}", e)),
    }
}

fn encode_image(source: &str, output: &str, ext: &str, quality: u8) -> Result<(), String> {
    let img = curator_core::image::open(source)
        .map_err(|e| format!("Failed to open/decode source: {:?}", e))?;

    let bytes = encode_dynamic(&img, ext, quality)?;
    write_file(output, &bytes)
}

fn encode_dynamic(img: &DynamicImage, ext: &str, quality: u8) -> Result<Vec<u8>, String> {
    let (w, h) = img.dimensions();
    let mut buf = Vec::new();

    match ext {
        "png" => {
            let rgba = img.to_rgba8();
            PngEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("PNG encode failed: {:?}", e))?;
        }
        "jpg" | "jpeg" => {
            let rgb = img.to_rgb8();
            JpegEncoder::new_with_quality(&mut buf, quality)
                .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
                .map_err(|e| format!("JPEG encode failed: {:?}", e))?;
        }
        // The `image` crate's WebP encoder is lossless-only (VP8L); `quality`
        // does not apply.
        "webp" => {
            let rgb = img.to_rgb8();
            WebPEncoder::new_lossless(&mut buf)
                .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
                .map_err(|e| format!("WebP encode failed: {:?}", e))?;
        }
        "gif" => {
            let rgba = img.to_rgba8();
            GifEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("GIF encode failed: {:?}", e))?;
        }
        "bmp" => {
            let rgba = img.to_rgba8();
            BmpEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("BMP encode failed: {:?}", e))?;
        }
        "tiff" => {
            let rgba = img.to_rgba8();
            let mut cur = Cursor::new(&mut buf);
            TiffEncoder::new(&mut cur)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("TIFF encode failed: {:?}", e))?;
        }
        "qoi" => {
            let rgba = img.to_rgba8();
            QoiEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("QOI encode failed: {:?}", e))?;
        }
        "tga" => {
            let rgba = img.to_rgba8();
            TgaEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("TGA encode failed: {:?}", e))?;
        }
        "pnm" => {
            let rgb = img.to_rgb8();
            PnmEncoder::new(&mut buf)
                .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
                .map_err(|e| format!("PNM encode failed: {:?}", e))?;
        }
        "hdr" => {
            let rgb32f = img.to_rgb32f();
            let bytes = f32_bytes(rgb32f.as_raw());
            HdrEncoder::new(&mut buf)
                .write_image(&bytes, w, h, ExtendedColorType::Rgb32F)
                .map_err(|e| format!("HDR encode failed: {:?}", e))?;
        }
        "exr" => {
            let rgb32f = img.to_rgb32f();
            let bytes = f32_bytes(rgb32f.as_raw());
            let mut cur = Cursor::new(&mut buf);
            OpenExrEncoder::new(&mut cur)
                .write_image(&bytes, w, h, ExtendedColorType::Rgb32F)
                .map_err(|e| format!("EXR encode failed: {:?}", e))?;
        }
        "ico" => {
            let rgba = img.to_rgba8();
            IcoEncoder::new(&mut buf)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("ICO encode failed: {:?}", e))?;
        }
        "avif" => {
            let rgba = img.to_rgba8();
            AvifEncoder::new_with_speed_quality(&mut buf, 6, quality)
                .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
                .map_err(|e| format!("AVIF encode failed: {:?}", e))?;
        }
        other => return Err(format!("Unsupported target format: {}", other)),
    }

    Ok(buf)
}

fn write_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut f = fs::File::create(path).map_err(|e| format!("Failed to create output file: {:?}", e))?;
    f.write_all(bytes)
        .map_err(|e| format!("Failed to write output file: {:?}", e))?;
    Ok(())
}

/// Reinterpret a `f32` pixel buffer as native-endian bytes (the byte order
/// `HdrEncoder`/`OpenExrEncoder` `write_image` expects for `Rgb32F`).
fn f32_bytes(raw: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(raw.len() * 4);
    for v in raw {
        bytes.extend_from_slice(&v.to_ne_bytes());
    }
    bytes
}

// ── FFmpeg Transcode (polled async job) ────────────────────────────────────

/// Map a codec/format hint onto explicit FFmpeg args. Preset names follow the
/// `-preset` values of the target encoder. `crf` and `video_bitrate_kbps` are
/// mutually exclusive quality controls.
fn transcode_encoder_args(
    target_format: &str,
    vcodec: Option<&str>,
    crf: Option<u32>,
    video_bitrate_kbps: Option<u32>,
    preset: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let codec = vcodec.unwrap_or(match target_format {
        "mp4" => "libx264",
        "webm" => "libvpx-vp9",
        other => other,
    });
    args.push("-c:v".into());
    args.push(codec.to_string());
    if codec != "copy" {
        if let Some(crf) = crf {
            args.push("-crf".into());
            args.push(crf.to_string());
        }
        if let Some(bitrate) = video_bitrate_kbps {
            args.push("-b:v".into());
            args.push(format!("{}k", bitrate));
            args.push("-maxrate".into());
            args.push(format!("{}k", (bitrate as f64 * 1.15).round() as u32));
            args.push("-bufsize".into());
            args.push(format!("{}k", bitrate * 2));
        }
        if let Some(p) = preset {
            args.push("-preset".into());
            args.push(p.to_string());
        }
    }
    args
}

fn probe_bitrate_overshoot(input_path: &Path, ffmpeg_path: &Path, video_kbps: u32, fps: f64, target_format: &str, probe_frames: usize) -> f64 {
    let temp_dir = std::env::temp_dir();
    let unique_id = uuid::Uuid::new_v4().to_string();
    let temp_file_path = temp_dir.join(format!("overshoot_probe_{}.mp4", unique_id));
    
    let status = std::process::Command::new(ffmpeg_path)
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-vframes")
        .arg(probe_frames.to_string())
        .arg("-c:v")
        .arg("libx264")
        .arg("-b:v")
        .arg(format!("{}k", video_kbps))
        .arg("-an")
        .arg(&temp_file_path)
        .status();
        
    let size = if let Ok(s) = status {
        if s.success() {
            std::fs::metadata(&temp_file_path).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        }
    } else {
        0
    };
    
    let _ = std::fs::remove_file(&temp_file_path);
    
    if size == 0 {
        1.0
    } else {
        let header_overhead = match target_format {
            "webm" => 4096.0,
            _ => 16384.0,
        };
        let raw_stream_size = (size as f64 - header_overhead).max(1024.0);
        let target_bytes = (video_kbps as f64 * 1000.0 / 8.0) * (probe_frames as f64 / fps);
        if target_bytes > 0.0 {
            (raw_stream_size / target_bytes).max(1.0)
        } else {
            1.0
        }
    }
}

/// Tokenize a raw command string into arguments, respecting single and double
/// quotes. No shell is spawned, so quotes only group tokens that contain
/// spaces (e.g. filter chains); a backslash escapes a quote inside double
/// quotes, matching typical shell quoting for ffmpeg filter expressions.
fn tokenize_args(input: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' if in_double => {
                if let Some(&next) = chars.peek() {
                    current.push(next);
                    chars.next();
                } else {
                    current.push('\\');
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Build the argument list for a fully custom command. `{input}` and
/// `{output}` placeholders are required and substituted with the real paths;
/// the guided encoder/audio/quality controls are skipped entirely. Fails fast
/// when a required placeholder is missing rather than silently appending a
/// default input/output block.
fn build_custom_args(
    custom_args: &str,
    input_path: &str,
    output_path: &str,
) -> Result<Vec<String>, String> {
    let tokens = tokenize_args(custom_args);
    let mut expanded: Vec<String> = Vec::with_capacity(tokens.len());
    let mut has_input = false;
    let mut has_output = false;
    for token in tokens {
        match token.as_str() {
            "{input}" => {
                expanded.push(input_path.to_string());
                has_input = true;
            }
            "{output}" => {
                expanded.push(output_path.to_string());
                has_output = true;
            }
            other => expanded.push(other.to_string()),
        }
    }
    if !has_input {
        return Err("Custom command must contain the {input} placeholder for the source video".to_string());
    }
    if !has_output {
        return Err("Custom command must contain the {output} placeholder for the output file".to_string());
    }
    Ok(expanded)
}

/// Start an async FFmpeg transcode. Progress is streamed via `-progress
/// pipe:1` and recorded into `map` under `job_id`; callers poll it with
/// `get_transcode_progress`. Fails fast when the input file is missing.
pub async fn start_transcode(
    job_id: &str,
    input_path: &str,
    output_path: &str,
    target_format: &str,
    vcodec: Option<String>,
    acodec: Option<String>,
    crf: Option<u32>,
    video_bitrate: Option<u32>,
    preset: Option<String>,
    target_size_mb: Option<f64>,
    audio_bitrate: Option<u32>,
    mixdown: Option<String>,
    sample_rate: Option<u32>,
    custom_args: Option<String>,
    ffmpeg_path: &Path,
    map: &TranscodeProgressMap,
) -> anyhow::Result<()> {
    let input = Path::new(input_path);
    if !input.is_file() {
        anyhow::bail!("Input file not found: {}", input_path);
    }
    let output = Path::new(output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    // Read video metadata. Propagate the error if ffprobe fails or parsing fails.
    let metadata = curator_core::video::read_video_metadata(input, ffmpeg_path)?;
    let total_duration_ms = metadata.duration_ms.max(1);

    let input_size = std::fs::metadata(input).map(|m| m.len()).ok();

    {
        let mut guard = map.lock().await;
        let (key, state) = default_job_state(job_id, output_path.to_string(), input_size);
        guard.insert(key, state);
    }

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-y");
    if let Some(ca) = custom_args {
        if ca.trim().is_empty() {
            anyhow::bail!("Custom command is empty");
        }
        let expanded = build_custom_args(&ca, input_path, output_path)
            .map_err(anyhow::Error::msg)?;
        cmd.args(expanded);
    } else {
        let mut calculated_video_bitrate = video_bitrate;
        let mut calculated_audio_bitrate = audio_bitrate;

        if let Some(budget_mb) = target_size_mb {
            let duration_ms = metadata.duration_ms.max(1000);
            let duration_secs = duration_ms as f64 / 1000.0;
            
            let fps = metadata.fps;
            let fps = if fps <= 0.0 || fps.is_nan() { 30.0 } else { fps };

            let has_audio = if let Some(ref ac) = acodec {
                ac != "none" && metadata.audio_codec.is_some()
            } else {
                metadata.audio_codec.is_some()
            };

            let sample_rate = metadata.sample_rate.unwrap_or(44100) as f64;
            let audio_packets_per_sec = match acodec.as_deref().unwrap_or("") {
                "libopus" | "opus" => 50.0,
                "libvorbis" | "vorbis" => 45.0,
                _ => sample_rate / 1024.0, // standard AAC/MP3 sample frame size is 1024
            };

            // Estimate container overhead mathematically based on frame indexing and packet frequency
            let container_overhead_bytes = match target_format {
                "webm" => {
                    let video_overhead = duration_secs * fps * 8.0; // WebM EBML video blocks
                    let audio_overhead = if has_audio { duration_secs * audio_packets_per_sec * 6.0 } else { 0.0 }; // EBML audio blocks
                    let cluster_overhead = (duration_secs / 2.0).ceil() * 12.0; // 1 Cluster header (12 bytes) every 2 seconds
                    video_overhead + audio_overhead + cluster_overhead + 4096.0 // base global metadata
                }
                _ => { // mp4
                    let video_overhead = duration_secs * fps * 16.0; // stsz + stco index entries & chunk descriptors
                    let audio_overhead = if has_audio { duration_secs * audio_packets_per_sec * 16.0 } else { 0.0 };
                    video_overhead + audio_overhead + 16384.0 // base global moov atom / headers
                }
            };

            // Deduct exact calculated container overhead from total budget
            let budget_bytes = budget_mb * 1024.0 * 1024.0;
            // Strict 90% base payload safety margin
            let available_payload_bytes = (budget_bytes * 0.90 - container_overhead_bytes).max(1024.0);

            // Compute total available bitrate in kbps (1 kbps = 1000 bps for ffmpeg)
            let total_budget_bits = available_payload_bytes * 8.0;
            let total_bitrate_bps = total_budget_bits / duration_secs;
            let total_bitrate_kbps = (total_bitrate_bps / 1000.0) as u32;

            // Audio bitrate estimation
            let audio_kbps = if !has_audio {
                0
            } else if let Some(ab) = audio_bitrate {
                ab
            } else {
                let probed_bps = metadata.audio_bitrate.unwrap_or(0);
                if probed_bps > 0 {
                    (probed_bps / 1000) as u32
                } else {
                    128
                }
            };

            // Limit audio to a maximum of 30% of total budget on tight budgets, keeping it above 32 kbps
            let final_audio_kbps = if has_audio {
                if audio_kbps * 3 > total_bitrate_kbps {
                    (total_bitrate_kbps / 3).max(32)
                } else {
                    audio_kbps
                }
            } else {
                0
            };

            calculated_audio_bitrate = if has_audio { Some(final_audio_kbps) } else { None };

            // Calculate remaining raw video bitrate
            let raw_video_kbps = if total_bitrate_kbps > final_audio_kbps {
                total_bitrate_kbps - final_audio_kbps
            } else {
                50
            };

            // Calculate total frames and clamp probe window between 15 and 100 frames to allow VBV rate control stabilization
            let total_frames = (duration_secs * fps).round() as usize;
            let probe_frames = total_frames.min(100).max(15);

            // Probe target overshoot using a fast target-bitrate transcode
            let overshoot_factor = probe_bitrate_overshoot(input, ffmpeg_path, raw_video_kbps, fps, target_format, probe_frames);
            let final_video_kbps = (raw_video_kbps as f64 / overshoot_factor) as u32;

            calculated_video_bitrate = Some(final_video_kbps.max(50));
        }

        cmd.arg("-i")
            .arg(input_path)
            .args(transcode_encoder_args(
                target_format,
                vcodec.as_deref(),
                crf,
                calculated_video_bitrate,
                preset.as_deref(),
            ));

        let has_audio = if let Some(ref ac) = acodec {
            ac != "none"
        } else {
            true
        };

        if has_audio {
            if let Some(ref ac) = acodec {
                let mapped_ac = match ac.as_str() {
                    "vorbis" => "libvorbis",
                    other => other,
                };
                cmd.arg("-c:a").arg(mapped_ac);
            } else {
                cmd.arg("-c:a").arg(match target_format {
                    "webm" => "libopus",
                    _ => "aac",
                });
            }

            if acodec.as_deref() != Some("copy") {
                if let Some(ab) = calculated_audio_bitrate {
                    cmd.arg("-b:a").arg(format!("{}k", ab));
                }
            }

            if let Some(ref md) = mixdown {
                match md.as_str() {
                    "mono" => { cmd.arg("-ac").arg("1"); },
                    "stereo" => { cmd.arg("-ac").arg("2"); },
                    "5.1" => { cmd.arg("-ac").arg("6"); },
                    _ => {}
                }
            }

            if let Some(sr) = sample_rate {
                cmd.arg("-ar").arg(sr.to_string());
            }
        } else {
            cmd.arg("-an");
        }

        cmd.arg("-f").arg(target_format).arg(output_path);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Expose the full command line so plugins can log exactly what ran.
    let command_string = {
        let mut parts = vec![ffmpeg_path.display().to_string()];
        for arg in cmd.as_std().get_args() {
            parts.push(format!("{}", arg.to_string_lossy()));
        }
        parts.join(" ")
    };
    {
        let mut guard = map.lock().await;
        if let Some(state) = guard.get_mut(job_id) {
            state.command = Some(command_string);
        }
    }

    let mut child = cmd.spawn().context("Failed to spawn FFmpeg")?;
    let stdout = child.stdout.take().expect("ffmpeg stdout piped");
    let stderr = child.stderr.take().expect("ffmpeg stderr piped");
    let map_task = map.clone();
    let job_id_task = job_id.to_string();
    let total_task = total_duration_ms;

    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut fps: f32 = 0.0;
        let mut speed: f32 = 0.0;
        let mut out_time_us: u64 = 0;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("fps=") {
                fps = v.trim().parse().unwrap_or(fps);
            } else if let Some(v) = line.strip_prefix("speed=") {
                speed = v
                    .trim()
                    .trim_end_matches('x')
                    .parse()
                    .unwrap_or(speed);
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                out_time_us = v.trim().parse().unwrap_or(out_time_us);
            } else if line.starts_with("progress=") {
                let done = line.trim() == "progress=end";
                let mut guard = map_task.lock().await;
                if let Some(state) = guard.get_mut(&job_id_task) {
                    state.fps = fps;
                    state.x_speed = speed;
                    state.out_time_ms = (out_time_us / 1000) as i64;
                    state.percent = ((state.out_time_ms as f64 / total_task as f64) * 100.0)
                        .clamp(0.0, 100.0) as f32;
                    if done {
                        state.percent = 100.0;
                    }
                }
            }
        }
    });

    // Drain stderr so the FFmpeg process never blocks on a full pipe; keep the
    // tail of the output for the failure diagnostics reported to the UI.
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if tail.len() >= 20 {
                tail.remove(0);
            }
            tail.push(line);
        }
        tail.join("\n")
    });

    // Finalize job state once the process exits. Runs detached so the IPC
    // request returns immediately and callers poll via GetTranscodeProgress.
    let map_fin = map.clone();
    let job_id_fin = job_id.to_string();
    let output_fin = output_path.to_string();
    let ffmpeg_path_clone = ffmpeg_path.to_path_buf();
    tokio::spawn(async move {
        let status = child.wait().await.context("FFmpeg process wait failed");
        let stderr_tail = stderr_task.await.unwrap_or_default();
        let _ = reader_task.await;

        let mut guard = map_fin.lock().await;
        if let Some(state) = guard.get_mut(&job_id_fin) {
            state.running = false;
            match status {
                Ok(s) if s.success() => {
                    state.percent = 100.0;
                    let out_path = std::path::Path::new(&output_fin);
                    if out_path.is_file() {
                        state.output_size_bytes = std::fs::metadata(out_path).map(|m| m.len()).ok();
                        // Probe final output file size breakdown
                        if let Ok(out_meta) = curator_core::video::read_video_metadata(out_path, &ffmpeg_path_clone) {
                            let dur_secs = out_meta.duration_ms as f64 / 1000.0;
                            if dur_secs > 0.0 {
                                if let Some(v_bps) = out_meta.bitrate {
                                    state.output_video_size_bytes = Some((v_bps as f64 * dur_secs / 8.0) as u64);
                                }
                                if let Some(a_bps) = out_meta.audio_bitrate {
                                    state.output_audio_size_bytes = Some((a_bps as f64 * dur_secs / 8.0) as u64);
                                }
                            }
                        }
                    }
                }
                Ok(s) => {
                    state.error = Some(format!(
                        "FFmpeg exited with status: {}",
                        s
                    ));
                }
                Err(e) => {
                    state.error = Some(format!("{}", e));
                }
            }
            if state.error.is_some() && !stderr_tail.is_empty() {
                state.error = Some(format!("{}\n{}", state.error.clone().unwrap_or_default(), stderr_tail));
            }
            if state.error.is_some() {
                error!(
                    "Transcode job {} failed for {:?}: {:?}",
                    job_id_fin, output_fin, state.error
                );
            }
        }
    });

    info!("Transcode job {} started for {:?}", job_id, output_path);
    Ok(())
}

/// Poll the current state of a transcode job.
pub async fn get_transcode_progress(job_id: &str, map: &TranscodeProgressMap) -> Response {
    let guard = map.lock().await;
    match guard.get(job_id) {
        Some(state) => Response::TranscodeProgressResult {
            job_id: job_id.to_string(),
            running: state.running,
            percent: state.percent,
            fps: state.fps,
            x_speed: state.x_speed,
            out_time_ms: state.out_time_ms,
            output_path: state.output_path.clone(),
            error: state.error.clone(),
            command: state.command.clone(),
            input_size_bytes: state.input_size_bytes,
            output_size_bytes: state.output_size_bytes,
            output_video_size_bytes: state.output_video_size_bytes,
            output_audio_size_bytes: state.output_audio_size_bytes,
        },
        None => Response::TranscodeProgressResult {
            job_id: job_id.to_string(),
            running: false,
            percent: 0.0,
            fps: 0.0,
            x_speed: 0.0,
            out_time_ms: 0,
            output_path: None,
            error: Some("Unknown transcode job".to_string()),
            command: None,
            input_size_bytes: None,
            output_size_bytes: None,
            output_video_size_bytes: None,
            output_audio_size_bytes: None,
        },
    }
}
