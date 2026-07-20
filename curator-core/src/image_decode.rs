use anyhow::{Context, Result};
use std::path::Path;

/// Fast RGB decode: turbojpeg for JPEG, png crate for PNG, image crate for others.
/// Returns `(rgb_pixels, width, height)`.
pub fn decode_rgb(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let data = std::fs::read(path).with_context(|| format!("Cannot read image {:?}", path))?;
    let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
    let is_png = data.len() >= 8 && data[0..8] == [137, 80, 78, 71, 13, 10, 26, 10];

    let (rgb_buf, width, height) = if is_jpeg {
        let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB)
            .with_context(|| format!("turbojpeg decode failed for {:?}", path))?;
        (image.pixels.to_vec(), image.width as u32, image.height as u32)
    } else if is_png {
        decode_png_fast(&data, path)?
    } else {
        let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        (rgb.into_raw(), w, h)
    };

    Ok((rgb_buf, width, height))
}

fn decode_png_fast(data: &[u8], path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(std::io::Cursor::new(data));
    let mut reader = decoder.read_info()
        .with_context(|| format!("png decode header failed for {:?}", path))?;
    let w = reader.info().width;
    let h = reader.info().height;
    // Always allocate w*h*4 (max RGBA) — output_buffer_size() can underreport
    // for interlaced or palette-based PNGs, causing "Size of buffer is smaller
    // than required" on next_frame().
    let buf_size = w as usize * h as usize * 4;
    let mut raw = vec![0u8; buf_size];
    let out_info = reader.next_frame(&mut raw)
        .with_context(|| format!("png decode failed for {:?}", path))?;
    let pixels = out_info.buffer_size();

    match out_info.color_type {
        png::ColorType::Rgb => {
            Ok((raw[..pixels].to_vec(), w, h))
        }
        png::ColorType::Rgba => {
            let rgb: Vec<u8> = raw[..pixels].chunks(4).flat_map(|c| [c[0], c[1], c[2]]).collect();
            Ok((rgb, w, h))
        }
        png::ColorType::Grayscale => {
            let rgb: Vec<u8> = raw[..pixels].iter().map(|&g| [g, g, g]).flatten().collect();
            Ok((rgb, w, h))
        }
        png::ColorType::GrayscaleAlpha => {
            let rgb: Vec<u8> = raw[..pixels].chunks(2).flat_map(|c| [c[0], c[0], c[0]]).collect();
            Ok((rgb, w, h))
        }
        // Indexed (palette) and any other color types: fall back to the image crate
        // which handles all conversions correctly via .to_rgb8()
        _ => {
            let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
            let rgb = img.to_rgb8();
            let (fw, fh) = rgb.dimensions();
            Ok((rgb.into_raw(), fw, fh))
        }
    }
}
