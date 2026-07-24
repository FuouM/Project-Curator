use anyhow::{Error, Result};
use std::path::Path;

/// Compute a 64-bit Average Perceptual Hash (aHash) for an image.
pub fn compute_ahash<P: AsRef<Path>>(image_path: P) -> Result<String, Error> {
    let img = image::open(image_path.as_ref())?;
    let resized = img
        .resize_exact(8, 8, image::imageops::FilterType::Nearest)
        .to_luma8();
    let pixels = resized.as_raw();
    let sum: u64 = pixels.iter().map(|&p| p as u64).sum();
    let avg = (sum / 64) as u8;
    let mut hash: u64 = 0;
    for (i, &p) in pixels.iter().enumerate() {
        if p >= avg {
            hash |= 1 << i;
        }
    }
    Ok(format!("{:016x}", hash))
}
