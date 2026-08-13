use anyhow::{Context, Result};
use curator_proto::contracts::DevicePreference;
use image::RgbImage;
use ndarray::Array4;
use ort::tensor::TensorElementType;
use ort::value::ValueType;
use ort::{inputs, value::TensorRef};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::onnx::ManagedSession;

pub const SAFETY_MODEL_ID: &str = "nsfw-detection-2-mini";
pub const SAFETY_MODEL_FILENAME_FP32: &str = "nsfw-detection-2-mini.onnx";
pub const SAFETY_MODEL_FILENAME_FP16: &str = "nsfw-detection-2-mini-fp16.onnx";
pub const MINI_INPUT_SIZE: u32 = 380;

/// Mean and Std for nsfw-detection-2-mini preprocessing.
const MINI_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const MINI_STD: [f32; 3] = [0.47853944, 0.4732864, 0.47434163];

/// 5-class probabilities, `softmax`-reduced in `[0,1]` per class (always sum to 1.0).
/// Per-class only — no aggregates, no `is_nsfw` flag. The browser derives NSFW state.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct SafetyClassification {
    pub safe_score: f32,    // class 0
    pub hentai_score: f32,  // class 1
    pub porn_score: f32,    // class 2
    pub sexy_score: f32,    // class 3
    pub drawing_score: f32, // class 4
}

impl SafetyClassification {
    /// Convenience aggregates (used by tests/benchmarks) — **never** persisted.
    pub fn nsfw_score(&self) -> f32 {
        self.hentai_score + self.porn_score + self.sexy_score
    }
    pub fn sfw_score(&self) -> f32 {
        self.safe_score + self.drawing_score
    }
}

pub struct SafetyClassifier {
    session: ManagedSession,
}

impl SafetyClassifier {
    /// Canonical model resolution order under a data dir:
    ///   <data_dir>/models/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini-fp16.onnx
    ///   <data_dir>/models/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini.onnx
    ///   <workspace>/reference/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini-fp16.onnx (dev fallback)
    /// Returns the preferred path even when no file exists yet — callers treat a missing
    /// file as "not classified" (a no-op), never as a silent inference fallback.
    pub fn resolve_model_path(data_dir: &Path) -> PathBuf {
        let base = data_dir.join("models").join(SAFETY_MODEL_ID).join("onnx");

        let fp16 = base.join(SAFETY_MODEL_FILENAME_FP16);
        if fp16.exists() {
            return fp16;
        }
        let fp32 = base.join(SAFETY_MODEL_FILENAME_FP32);
        if fp32.exists() {
            return fp32;
        }

        // Dev fallback into the workspace reference staging tree (repo checkout only).
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."));
        let dev_fp16 = workspace
            .join("reference")
            .join(SAFETY_MODEL_ID)
            .join("onnx")
            .join(SAFETY_MODEL_FILENAME_FP16);
        if dev_fp16.exists() {
            return dev_fp16;
        }
        let dev_fp32 = workspace
            .join("reference")
            .join(SAFETY_MODEL_ID)
            .join("onnx")
            .join(SAFETY_MODEL_FILENAME_FP32);
        if dev_fp32.exists() {
            return dev_fp32;
        }

        fp16
    }

    pub fn new(model_path: impl Into<PathBuf>, device: DevicePreference) -> Self {
        let path = model_path.into();
        Self {
            session: ManagedSession::new("Safety Classifier", path, device, 1),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.session.is_loaded()
    }

    pub fn idle_secs(&self) -> u64 {
        self.session.idle_secs()
    }

    pub fn unload(&self) {
        self.session.unload();
    }

    pub fn set_device(&self, device: DevicePreference) {
        self.session.set_device(device);
    }

    pub fn load(&self) -> Result<()> {
        self.session.load()
    }

    /// Single image, NCHW [1,3,380,380] (ImageNet mean/std) -> output `probabilities` (len 5).
    pub fn classify_image(&self, img: &RgbImage) -> Result<SafetyClassification> {
        let tensor = preprocess_mini_image(img)?;
        let results = self.run_tensor(&tensor)?;
        results.into_iter().next().context("Safety classifier returned no result")
    }

    /// Batched: builds [N,3,380,380], runs one ONNX call, maps outputs back per-image.
    pub fn classify_images_batch(&self, imgs: &[RgbImage]) -> Vec<Result<SafetyClassification>> {
        if imgs.is_empty() {
            return Vec::new();
        }
        let n = imgs.len();
        let s = MINI_INPUT_SIZE as usize;
        let mut tensors = Array4::<f32>::zeros((n, 3, s, s));

        for (i, img) in imgs.iter().enumerate() {
            if let Err(e) = preprocess_row_for_tensor(img, &mut tensors, i) {
                return err_results(format!("{e:#}"), n);
            }
        }

        match self.run_tensor(&tensors) {
            Ok(results) if results.len() == n => results.into_iter().map(Ok).collect(),
            Ok(results) => {
                let mut out: Vec<Result<SafetyClassification>> =
                    results.into_iter().map(Ok).collect();
                while out.len() < n {
                    out.push(Err(anyhow::anyhow!(
                        "Safety batch returned fewer rows than requested"
                    )));
                }
                out
            }
            Err(e) => err_results(format!("{e:#}"), n),
        }
    }

    fn run_tensor(&self, tensor: &Array4<f32>) -> Result<Vec<SafetyClassification>> {
        self.session.with_session(|session| {
            let uses_f16 = {
                let inputs = session.inputs();
                let dtype = inputs
                    .first()
                    .context("Safety classifier session has no inputs")?
                    .dtype();
                matches!(
                    dtype,
                    ValueType::Tensor {
                        ty: TensorElementType::Float16,
                        ..
                    }
                )
            };

            let outputs = if uses_f16 {
                let f16_tensor = tensor.mapv(half::f16::from_f32);
                session
                    .run(inputs!["image" => TensorRef::from_array_view(&f16_tensor)?])
                    .context("Safety classifier inference failed")?
            } else {
                session
                    .run(inputs!["image" => TensorRef::from_array_view(tensor)?])
                    .context("Safety classifier inference failed")?
            };

            let output_tensor = outputs
                .get("probabilities")
                .or_else(|| outputs.get("logits"))
                .or_else(|| outputs.get("output"))
                .context("Failed to get probabilities/logits output tensor")?;

            let (shape, flat) = match output_tensor.try_extract_tensor::<f32>() {
                Ok((shape, data)) => (shape, data.iter().copied().collect::<Vec<f32>>()),
                Err(_) => {
                    let (shape, data) = output_tensor
                        .try_extract_tensor::<half::f16>()
                        .context("Failed to extract safety output as f32 or f16 tensor")?;
                    let flat: Vec<f32> = data.iter().map(|v| half::f16::to_f32(*v)).collect();
                    (shape, flat)
                }
            };
            let n = shape.first().copied().unwrap_or(0) as usize;

            let mut results = Vec::with_capacity(n);
            for i in 0..n {
                let row_start = i * 5;
                if row_start + 5 > flat.len() {
                    anyhow::bail!(
                        "Safety output has {} values, expected {} classes per row",
                        flat.len(),
                        5
                    );
                }
                let probs = softmax(&flat[row_start..row_start + 5]);
                results.push(SafetyClassification {
                    safe_score: probs[0],
                    hentai_score: probs[1],
                    porn_score: probs[2],
                    sexy_score: probs[3],
                    drawing_score: probs[4],
                });
            }
            Ok(results)
        })
    }
}

fn err_results(msg: String, n: usize) -> Vec<Result<SafetyClassification>> {
    (0..n).map(|_| Err(anyhow::anyhow!("{msg}"))).collect()
}

fn softmax(logits: &[f32]) -> Vec<f32> {
    if logits.is_empty() {
        return Vec::new();
    }
    let max_val = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|&x| (x - max_val).exp()).collect();
    let sum_exps: f32 = exps.iter().sum();
    if sum_exps == 0.0 {
        return vec![0.0; logits.len()];
    }
    exps.iter().map(|&x| x / sum_exps).collect()
}

/// Fill one `[1,3,380,380]`-shaped row of a batch tensor (ImageNet mean/std normalized) for
/// `nsfw-detection-2-mini` from an RGB image.
fn preprocess_row_for_tensor(img: &RgbImage, out: &mut Array4<f32>, row: usize) -> Result<()> {
    let (w, h) = img.dimensions();
    let s = MINI_INPUT_SIZE as usize;

    let mut resizer = fast_image_resize::Resizer::new();
    let src = fast_image_resize::images::ImageRef::new(
        w,
        h,
        img.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )?;
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        s as u32,
        s as u32,
        vec![0u8; s * s * 3],
        fast_image_resize::PixelType::U8x3,
    )?;
    let opts = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
    );
    resizer.resize(&src, &mut dst, Some(&opts))?;

    let data = dst.buffer();
    let s2 = s * s;
    let slice = out
        .slice_mut(ndarray::s![row, .., .., ..])
        .into_slice()
        .context("Batch tensor not contiguous")?;

    for y in 0..s {
        for x in 0..s {
            let src_idx = (y * s + x) * 3;
            let dst_idx = y * s + x;
            let r = data[src_idx] as f32 / 255.0;
            let g = data[src_idx + 1] as f32 / 255.0;
            let b = data[src_idx + 2] as f32 / 255.0;

            slice[dst_idx] = (r - MINI_MEAN[0]) / MINI_STD[0];
            slice[s2 + dst_idx] = (g - MINI_MEAN[1]) / MINI_STD[1];
            slice[2 * s2 + dst_idx] = (b - MINI_MEAN[2]) / MINI_STD[2];
        }
    }

    Ok(())
}

/// Preprocess a single image into a `[1,3,380,380]` tensor.
pub fn preprocess_mini_image(img: &RgbImage) -> Result<Array4<f32>> {
    let s = MINI_INPUT_SIZE as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
    preprocess_row_for_tensor(img, &mut tensor, 0)?;
    Ok(tensor)
}