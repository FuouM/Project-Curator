use anyhow::Result;
use image::RgbImage;
use ndarray::Array4;

/// ImageNet normalization mean values (used by tagger and benchmark).
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet normalization std values (used by tagger and benchmark).
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// CLIP vision normalization mean values (used by CCIP and CLIP embedder).
pub const CLIP_MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
/// CLIP vision normalization std values (used by CCIP and CLIP embedder).
pub const CLIP_STD: [f32; 3] = [0.26862954, 0.2613026, 0.275_777_1];
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
    for (c, &pad_val) in pad_vals.iter().enumerate() {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Legacy YOLO letterbox reference (mean=0/std=1, pad [114,114,114]).
    fn legacy_yolo_letterbox(data: &[u8], target: u32, new_w: u32, new_h: u32) -> Array4<f32> {
        let s = target as usize;
        let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
        let slice = tensor.as_slice_mut().unwrap();
        let pad_r = 114.0 / 255.0;
        let pad_g = 114.0 / 255.0;
        let pad_b = 114.0 / 255.0;
        let pad_x = ((target - new_w) / 2) as usize;
        let pad_y = ((target - new_h) / 2) as usize;
        for y in 0..s {
            for x in 0..s {
                slice[y * s + x] = pad_r;
                slice[s * s + y * s + x] = pad_g;
                slice[2 * s * s + y * s + x] = pad_b;
            }
        }
        for y in 0..new_h as usize {
            for x in 0..new_w as usize {
                let src_idx = (y * new_w as usize + x) * 3;
                let dst_y = pad_y + y;
                let dst_x = pad_x + x;
                slice[dst_y * s + dst_x] = data[src_idx] as f32 / 255.0;
                slice[s * s + dst_y * s + dst_x] = data[src_idx + 1] as f32 / 255.0;
                slice[2 * s * s + dst_y * s + dst_x] = data[src_idx + 2] as f32 / 255.0;
            }
        }
        tensor
    }

    /// Legacy CCIP reference (CLIP mean/std, square fit so no pad).
    fn legacy_ccip_normalize(data: &[u8], target: u32) -> Array4<f32> {
        let s = target as usize;
        let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
        let slice = tensor.as_slice_mut().unwrap();
        for y in 0..s {
            for x in 0..s {
                let si = (y * s + x) * 3;
                let pix_idx = y * s + x;
                for c in 0..3usize {
                    let val = data[si + c] as f32 / 255.0;
                    slice[c * s * s + pix_idx] = (val - CLIP_MEAN[c]) / CLIP_STD[c];
                }
            }
        }
        tensor
    }

    fn synthetic_rgb(new_w: u32, new_h: u32, checker: bool) -> Vec<u8> {
        let mut buf = vec![0u8; (new_w * new_h * 3) as usize];
        for y in 0..new_h {
            for x in 0..new_w {
                let i = ((y * new_w + x) * 3) as usize;
                if checker {
                    let v = ((x + y) % 2) as u8 * 200;
                    buf[i] = v;
                    buf[i + 1] = 255 - v;
                    buf[i + 2] = v / 2;
                }
            }
        }
        buf
    }

    #[test]
    fn build_tensor_yolo_matches_legacy_letterbox() {
        for &(target, nw, nh) in &[(640u32, 640u32, 640u32), (640, 512, 640), (640, 640, 320), (320, 224, 320), (320, 320, 224)] {
            for checker in [false, true] {
                let data = synthetic_rgb(nw, nh, checker);
                let legacy = legacy_yolo_letterbox(&data, target, nw, nh);
                let tensor = build_tensor(
                    &data,
                    target,
                    nw,
                    nh,
                    &[0.0f32; 3],
                    &[1.0f32; 3],
                    &[114, 114, 114],
                );
                assert_eq!(legacy.as_slice().unwrap(), tensor.as_slice().unwrap());
            }
        }
    }

    #[test]
    fn build_tensor_ccip_matches_legacy_normalize() {
        for &target in &[384u32, 224u32] {
            for checker in [false, true] {
                let data = synthetic_rgb(target, target, checker);
                let legacy = legacy_ccip_normalize(&data, target);
                let tensor = build_tensor(
                    &data,
                    target,
                    target,
                    target,
                    &CLIP_MEAN,
                    &CLIP_STD,
                    &[0u8; 3],
                );
                assert_eq!(legacy.as_slice().unwrap(), tensor.as_slice().unwrap());
            }
        }
    }
}

