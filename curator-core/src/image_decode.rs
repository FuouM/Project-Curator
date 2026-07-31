use anyhow::{Context, Result};
use std::path::Path;

/// Fast RGB decode: turbojpeg for JPEG, png crate for PNG, webp crate for WebP, image crate for others.
/// Returns `(rgb_pixels, width, height)`.
pub fn decode_rgb(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let data = std::fs::read(path).with_context(|| format!("Cannot read image {:?}", path))?;
    let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
    let is_png = data.len() >= 8 && data[0..8] == [137, 80, 78, 71, 13, 10, 26, 10];
    let is_webp = data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP";

    let (rgb_buf, width, height) = if is_jpeg {
        let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB)
            .with_context(|| format!("turbojpeg decode failed for {:?}", path))?;
        (image.pixels, image.width as u32, image.height as u32)
    } else if is_png {
        match decode_png_fast(&data, path) {
            Ok(res) => res,
            Err(_) => {
                let img = image::open(path).with_context(|| format!("Cannot open PNG image {:?}", path))?;
                let rgb = img.to_rgb8();
                let (w, h) = rgb.dimensions();
                (rgb.into_raw(), w, h)
            }
        }
    } else if is_webp {
        let decoder = webp::Decoder::new(&data);
        let webp_img = decoder.decode()
            .ok_or_else(|| anyhow::anyhow!("WebP decode failed for {:?}", path))?;
        let (w, h) = (webp_img.width(), webp_img.height());
        (webp_img.to_vec(), w, h)
    } else {
        let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        (rgb.into_raw(), w, h)
    };

    Ok((rgb_buf, width, height))
}

fn decode_png_fast(data: &[u8], path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()
        .with_context(|| format!("png decode header failed for {:?}", path))?;
    let w = reader.info().width;
    let h = reader.info().height;
    let buf_size = w as usize * h as usize * 4;
    let mut raw = vec![0u8; buf_size];
    let out_info = reader.next_frame(&mut raw)
        .with_context(|| format!("png decode failed for {:?}", path))?;
    let pixels = out_info.buffer_size();

    match out_info.color_type {
        png::ColorType::Rgb => {
            let expected_len = w as usize * h as usize * 3;
            if pixels < expected_len {
                anyhow::bail!("PNG RGB buffer too small: expected {}, got {}", expected_len, pixels);
            }
            let mut rgb = vec![0u8; expected_len];
            rgb.copy_from_slice(&raw[..expected_len]);
            Ok((rgb, w, h))
        }
        png::ColorType::Rgba => {
            let expected_pixels = w as usize * h as usize * 4;
            if pixels < expected_pixels {
                anyhow::bail!("PNG RGBA buffer too small: expected {}, got {}", expected_pixels, pixels);
            }
            let rgb: Vec<u8> = raw[..expected_pixels]
                .chunks_exact(4)
                .flat_map(|c| [c[0], c[1], c[2]])
                .collect();
            Ok((rgb, w, h))
        }
        png::ColorType::Grayscale => {
            let expected_pixels = w as usize * h as usize;
            if pixels < expected_pixels {
                anyhow::bail!("PNG Grayscale buffer too small: expected {}, got {}", expected_pixels, pixels);
            }
            let rgb: Vec<u8> = raw[..expected_pixels]
                .iter()
                .flat_map(|&g| [g, g, g])
                .collect();
            Ok((rgb, w, h))
        }
        png::ColorType::GrayscaleAlpha => {
            let expected_pixels = w as usize * h as usize * 2;
            if pixels < expected_pixels {
                anyhow::bail!("PNG GrayscaleAlpha buffer too small: expected {}, got {}", expected_pixels, pixels);
            }
            let rgb: Vec<u8> = raw[..expected_pixels]
                .chunks_exact(2)
                .flat_map(|c| [c[0], c[0], c[0]])
                .collect();
            Ok((rgb, w, h))
        }
        _ => {
            anyhow::bail!("Unsupported PNG color type {:?}", out_info.color_type);
        }
    }
}

/// Decode + center-crop to square + SIMD resize to target_size.
/// Used by `ModelManager::preprocess_image_batch` for batch preprocessing.
pub fn decode_and_resize_single_image(
    path: &Path,
    target_size: u32,
    resizer: &mut fast_image_resize::Resizer,
) -> Result<Vec<u8>> {
    let (rgb_buf, width, height) = decode_rgb(path)?;

    let crop_size = width.min(height);
    let cx = (width - crop_size) / 2;
    let cy = (height - crop_size) / 2;

    let src_image = fast_image_resize::images::ImageRef::new(
        width,
        height,
        &rgb_buf,
        fast_image_resize::PixelType::U8x3,
    )?;

    // Reuse destination buffer inside target size instead of allocating every time if possible.
    // fast_image_resize's Image type allocates a new vector when created via from_vec_u8.
    let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
        target_size,
        target_size,
        vec![0u8; (target_size * target_size * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )?;

    let opts = fast_image_resize::ResizeOptions::new()
        .crop(cx as f64, cy as f64, crop_size as f64, crop_size as f64)
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(
            fast_image_resize::FilterType::Bilinear,
        ));

    resizer.resize(&src_image, &mut dst_image, Some(&opts))?;
    Ok(dst_image.buffer().to_vec())
}

