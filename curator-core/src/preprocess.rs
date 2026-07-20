use ndarray::Array4;

/// ImageNet normalization mean values (used by tagger and benchmark).
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet normalization std values (used by tagger and benchmark).
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// Default padding color for letterboxed images.
pub const PAD_COLOR: [u8; 3] = [124, 116, 104];

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

    for c in 0..3usize {
        let m = mean[c];
        let sd = std[c];
        let pad_val = (pad_color[c] as f32 / 255.0 - m) / sd;
        let dst_base = c * s * s;

        // Fill entire channel with pad color
        for y in 0..s {
            let rs = dst_base + y * s;
            for x in 0..s {
                slice[rs + x] = pad_val;
            }
        }

        // Paste resized image data
        for y in 0..nh {
            let src_row = y * nw * 3 + c;
            let dst_row = dst_base + (paste_y + y) * s + paste_x;
            for x in 0..nw {
                let val = data[src_row + x * 3] as f32 / 255.0;
                slice[dst_row + x] = (val - m) / sd;
            }
        }
    }

    tensor
}
