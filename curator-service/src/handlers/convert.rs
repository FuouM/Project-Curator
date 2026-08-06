use curator_core::image::{
    codecs::{avif::AvifEncoder, bmp::BmpEncoder, gif::GifEncoder, hdr::HdrEncoder, ico::IcoEncoder, jpeg::JpegEncoder, openexr::OpenExrEncoder, png::PngEncoder, pnm::PnmEncoder, qoi::QoiEncoder, tga::TgaEncoder, tiff::TiffEncoder, webp::WebPEncoder},
    DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder,
};
use curator_core::ipc::{ConvertedFileInfo, Response};
use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;

/// Target formats accepted by `EphemeralConvertImages`, restricted to the
/// `image` crate's default-feature encode set. `avif` is encode-only here
/// (decoding would require the rejected native-dav1d `avif-native` feature).
const ENCODE_FORMATS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "qoi", "tga", "pnm", "hdr", "ico", "exr",
    "avif",
];

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
