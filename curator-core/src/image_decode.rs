use anyhow::{Context, Result};
use std::path::Path;

/// Decode an image to flat RGB (U8x3) via the `image` crate.
/// Returns `(rgb_pixels, width, height)`.
///
/// The `image` crate was benchmarked as the fastest *and* accurate decoder across
/// every import format (JPEG/PNG/WebP/BMP/GIF/TIFF) in release builds, so it is the
/// single canonical decode path rather than a per-format dispatch of
/// turbojpeg/png/webp. Specialized decoders (e.g. turbojpeg, libwebp) are actually
/// slower in release than the image crate's internal engines.
pub fn decode_rgb(path: &Path) -> Result<(Vec<u8>, u32, u32)> {
    let start = std::time::Instant::now();
    let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
    let rgb = img.to_rgb8();
    let (width, height) = rgb.dimensions();
    let pixels = rgb.into_raw();
    tracing::trace!("decode_rgb({:?}) {:?}", path, start.elapsed());
    Ok((pixels, width, height))
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

