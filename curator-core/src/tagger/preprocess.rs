use std::path::Path;

use anyhow::{Context, Result};
use ndarray::Array4;

pub(crate) fn preprocess_image(
    path: &Path,
    img_size: u32,
    mean: &[f32; 3],
    std: &[f32; 3],
    pad_color: &[u8; 3],
    resizer: &mut fast_image_resize::Resizer,
) -> Result<Array4<f32>> {
    let (rgb_buf, orig_w, orig_h) = crate::image_decode::decode_rgb(path)?;
    preprocess_image_from_rgb(&rgb_buf, orig_w, orig_h, img_size, mean, std, pad_color, resizer)
}

pub(crate) fn preprocess_image_from_rgb(
    rgb_buf: &[u8],
    orig_w: u32,
    orig_h: u32,
    img_size: u32,
    mean: &[f32; 3],
    std: &[f32; 3],
    pad_color: &[u8; 3],
    resizer: &mut fast_image_resize::Resizer,
) -> Result<Array4<f32>> {
    let aspect = orig_w as f32 / orig_h as f32;

    let (new_w, new_h) = if aspect > 1.0 {
        let nw = img_size;
        let nh = (img_size as f32 / aspect).round() as u32;
        (nw, nh)
    } else {
        let nh = img_size;
        let nw = (img_size as f32 * aspect).round() as u32;
        (nw, nh)
    };

    let src = fast_image_resize::images::ImageRef::new(
        orig_w,
        orig_h,
        rgb_buf,
        fast_image_resize::PixelType::U8x3,
    )
    .context("Failed to create source image ref")?;
    let dst_buf = vec![0u8; (new_w * new_h * 3) as usize];
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        new_w,
        new_h,
        dst_buf,
        fast_image_resize::PixelType::U8x3,
    )
    .context("Failed to create destination image")?;
    let opts = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
    );
    resizer
        .resize(&src, &mut dst, Some(&opts))
        .context("Image resize failed")?;
    let data = dst.buffer();

    Ok(crate::preprocess::build_tensor(
        data,
        img_size,
        new_w,
        new_h,
        mean,
        std,
        pad_color,
    ))
}

#[inline]
pub(crate) fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
