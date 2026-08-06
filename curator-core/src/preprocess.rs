use anyhow::Result;
use image::RgbImage;
use ndarray::Array4;

/// ImageNet normalization mean values (used by tagger and benchmark).
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet normalization std values (used by tagger and benchmark).
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// Default padding color for letterboxed images.
pub const PAD_COLOR: [u8; 3] = [124, 116, 104];

/// Resize an RGB image to `width` x `height` with fast_image_resize Bilinear.
///
/// This is the project-standard resize path (also used by CLIP/tagger/thumbnail).
/// Benchmarked as ~14-24x faster than `image::imageops::resize(.., Triangle)` while
/// producing a pixel-identical result (maxΔ = 1 LSB), so detection preprocessors use
/// it instead of the legacy image-crate filter.
pub fn resize_rgb_bilinear(
    image: &RgbImage,
    width: u32,
    height: u32,
    resizer: &mut fast_image_resize::Resizer,
) -> Result<Vec<u8>> {
    let src = fast_image_resize::images::ImageRef::new(
        image.width(),
        image.height(),
        image.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )?;
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        width,
        height,
        vec![0u8; (width * height * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )?;
    let opts = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
    );
    resizer.resize(&src, &mut dst, Some(&opts))?;
    Ok(dst.buffer().to_vec())
}

/// Build a normalized NCHW tensor from resized RGB data.
///
/// The data is expected to be `new_w * new_h * 3` bytes of RGB pixels.
/// The tensor is centered inside a `(1, 3, target_size, target_size)` array,
/// with border pixels filled by the normalized `pad_color`.
pub fn build_tensor(
    data: &[u8],
    target_size: u32,
    new_w: u32,
    new_h: u32,
    mean: &[f32; 3],
    std: &[f32; 3],
    pad_color: &[u8; 3],
) -> Array4<f32> {
    let s = target_size as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
    let slice = tensor.as_slice_mut().unwrap();

    let paste_x = ((target_size - new_w) / 2) as usize;
    let paste_y = ((target_size - new_h) / 2) as usize;
    let nw = new_w as usize;
    let nh = new_h as usize;

    // Precompute pad values for each channel
    let pad_vals = [
        (pad_color[0] as f32 / 255.0 - mean[0]) / std[0],
        (pad_color[1] as f32 / 255.0 - mean[1]) / std[1],
        (pad_color[2] as f32 / 255.0 - mean[2]) / std[2],
    ];

    // Pre-fill each channel with its respective pad value directly
    for c in 0..3 {
        let pad_val = pad_vals[c];
        let dst_base = c * s * s;
        slice[dst_base..dst_base + s * s].fill(pad_val);
    }

    // Paste resized image data with optimized channel mapping
    for c in 0..3 {
        let m = mean[c];
        let sd = std[c];
        let dst_base = c * s * s;

        for y in 0..nh {
            let src_row = y * nw * 3 + c;
            let dst_row = dst_base + (paste_y + y) * s + paste_x;
            let src_slice = &data[src_row..];
            let dst_slice = &mut slice[dst_row..dst_row + nw];

            for x in 0..nw {
                let val = src_slice[x * 3] as f32 / 255.0;
                dst_slice[x] = (val - m) / sd;
            }
        }
    }

    tensor
}

