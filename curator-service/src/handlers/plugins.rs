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
use tracing::info;

use crate::AppSettings;

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
