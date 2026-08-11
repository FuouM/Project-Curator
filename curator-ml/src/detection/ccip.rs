use curator_proto::contracts::DevicePreference;
use crate::onnx::ManagedSession;
use crate::preprocess::{CLIP_MEAN, CLIP_STD};
use anyhow::{Context, Result};
use ndarray::{Array2, Array4};
use ort::{inputs, value::TensorRef};
use std::path::Path;
use std::time::Instant;
use tracing::{debug, info};

const CCIP_INPUT_SIZE: u32 = 384;
const CCIP_EMBEDDING_DIM: usize = 768;
pub const DEFAULT_MATCH_THRESHOLD: f32 = 0.178;

pub struct CCIPModel {
    feat_session: ManagedSession,
    metrics_session: ManagedSession,
}

impl CCIPModel {
    pub fn new(model_dir: impl AsRef<Path>, feat_device: DevicePreference, metrics_device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let ccip_dir = dir.join("ccip");
        Self {
            feat_session: ManagedSession::new(
                "CCIP Feature",
                ccip_dir.join("model_feat.onnx"),
                feat_device,
                1,
            ),
            metrics_session: ManagedSession::new(
                "CCIP Metrics",
                ccip_dir.join("model_metrics.onnx"),
                metrics_device,
                1,
            ),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.feat_session.is_loaded() && self.metrics_session.is_loaded()
    }

    pub fn idle_secs(&self) -> u64 {
        self.feat_session.idle_secs().max(self.metrics_session.idle_secs())
    }

    pub fn unload(&self) {
        self.feat_session.unload();
        self.metrics_session.unload();
    }

    pub fn set_feat_device(&self, device: DevicePreference) {
        self.feat_session.set_device(device);
    }

    pub fn set_metrics_device(&self, device: DevicePreference) {
        self.metrics_session.set_device(device);
    }

    pub fn load(&self) -> Result<()> {
        self.feat_session.load()?;
        self.metrics_session.load()?;
        Ok(())
    }

    /// Extract a 768-d embedding from an image crop.
    pub fn extract_embedding(&self, crop: &image::RgbImage) -> Result<Vec<f32>> {
        self.extract_embedding_inner(crop)
    }

    fn extract_embedding_inner(&self, crop: &image::RgbImage) -> Result<Vec<f32>> {
        let t0 = Instant::now();
        let preprocess_ms: f64;
        let tensor = {
            let t1 = Instant::now();
            let res = preprocess_ccip(crop, CCIP_INPUT_SIZE)?;
            preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;
            res
        };

        let t2 = Instant::now();
        debug!(
            "Running CCIP feature extraction ({}x{})",
            crop.width(),
            crop.height()
        );
        let embedding = self.feat_session.with_session(|session| {
            let outputs = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("CCIP feature inference failed")?;
            let output_tensor = outputs
                .get("output")
                .context("Failed to get output from CCIP feature model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let load_ms = total_ms - preprocess_ms - inference_ms;
        info!(
            "CCIP extract timing: load_and_overhead={:.1}ms preprocess={:.1}ms inference={:.1}ms total={:.1}ms | dim={}",
            load_ms.max(0.0), preprocess_ms, inference_ms, total_ms, embedding.len()
        );

        Ok(embedding)
    }

    /// Compare a detection embedding against a set of identity embeddings.
    /// Returns (is_match, mean_difference). Lower difference = more similar.
    pub fn compare_embeddings(
        &self,
        query: &[f32],
        references: &[Vec<f32>],
    ) -> Result<(bool, f32)> {
        if references.is_empty() {
            return Ok((false, f32::MAX));
        }

        let mean_diff = self.compute_mean_difference(query, references)?;
        let is_match = mean_diff <= DEFAULT_MATCH_THRESHOLD;
        Ok((is_match, mean_diff))
    }

    /// Batch compute the per-reference mean differences between a query embedding
    /// and a flat list of reference embeddings in a single metrics-model inference.
    /// Returns one difference per reference (same order as `references`).
    pub fn compute_mean_differences(
        &self,
        query: &[f32],
        references: &[Vec<f32>],
    ) -> Result<Vec<f32>> {
        if references.is_empty() {
            return Ok(Vec::new());
        }

        let n = 1 + references.len();
        let mut input_vec = Vec::with_capacity(n * CCIP_EMBEDDING_DIM);
        input_vec.extend_from_slice(query);
        for r in references {
            input_vec.extend_from_slice(r);
        }

        let input_array =
            Array2::from_shape_vec((n, CCIP_EMBEDDING_DIM), input_vec)
                .context("Failed to build CCIP metrics input")?;

        let diffs = self.metrics_session.with_session(|session| {
            let outputs = session
                .run(inputs![TensorRef::from_array_view(&input_array)?])
                .context("CCIP metrics inference failed")?;

            let output_tensor = outputs
                .get("output")
                .context("Failed to get output from CCIP metrics model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;

            // Output is [N, N] pairwise difference matrix. Row 0 is the query;
            // columns 1..N are the per-reference differences.
            let mut diffs = Vec::with_capacity(n - 1);
            for j in 1..n {
                diffs.push(data[j]);
            }
            Ok(diffs)
        })?;

        Ok(diffs)
    }

    /// Compute mean difference between a query embedding and reference embeddings
    /// using the metrics model. Thin wrapper over `compute_mean_differences`.
    pub fn compute_mean_difference(
        &self,
        query: &[f32],
        references: &[Vec<f32>],
    ) -> Result<f32> {
        let diffs = self.compute_mean_differences(query, references)?;
        if diffs.is_empty() {
            // Deterministic no-match sentinel, matching compare_embeddings'
            // early-return convention (guards the 0.0/0.0 NaN case).
            return Ok(f32::MAX);
        }
        Ok(diffs.iter().sum::<f32>() / diffs.len() as f32)
    }

    pub fn benchmark_once(&self, crop: &image::RgbImage) -> Result<f64> {
        let t0 = Instant::now();
        let tensor = preprocess_ccip(crop, CCIP_INPUT_SIZE)?;
        self.feat_session.with_session(|session| {
            let _ = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("CCIP benchmark inference failed")?;
            Ok(())
        })?;
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    pub fn benchmark_metrics_once(&self, n_embeddings: usize) -> Result<f64> {
        let mut input_vec = Vec::with_capacity(n_embeddings * CCIP_EMBEDDING_DIM);
        for _ in 0..n_embeddings {
            for _ in 0..CCIP_EMBEDDING_DIM {
                input_vec.push(0.5f32);
            }
        }

        let input_array =
            Array2::from_shape_vec((n_embeddings, CCIP_EMBEDDING_DIM), input_vec)
                .context("Failed to build CCIP metrics benchmark input")?;

        let t0 = Instant::now();
        self.metrics_session.with_session(|session| {
            let _ = session
                .run(inputs![TensorRef::from_array_view(&input_array)?])
                .context("CCIP metrics benchmark inference failed")?;
            Ok(())
        })?;

        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }
}

impl curator_proto::pipeline::SystemNode for CCIPModel {
    fn info(&self) -> curator_proto::pipeline::NodeInfo {
        curator_proto::pipeline::NodeInfo {
            id: "ccip-matcher",
            label: "CCIP Character Matcher",
            inputs: vec![
                curator_proto::pipeline::Port { name: "image", type_name: "Image" },
            ],
            outputs: vec![
                curator_proto::pipeline::Port { name: "embedding", type_name: "EmbeddingVector" },
            ],
        }
    }

    fn device(&self) -> DevicePreference {
        self.feat_session.device()
    }

    fn set_device(&self, device: DevicePreference) {
        CCIPModel::set_feat_device(self, device.clone());
        CCIPModel::set_metrics_device(self, device);
    }

    fn unload_all(&self) {
        CCIPModel::unload(self);
    }

    fn is_loaded(&self) -> bool {
        CCIPModel::is_loaded(self)
    }
}

pub(crate) fn preprocess_ccip(crop: &image::RgbImage, target_size: u32) -> Result<Array4<f32>> {
    let (w, h) = crop.dimensions();
    let s = target_size as usize;

    // Bilinear resize to the square CLIP input (standard, not nearest-neighbour).
    let mut resizer = fast_image_resize::Resizer::new();
    let src = fast_image_resize::images::ImageRef::new(
        w,
        h,
        crop.as_raw(),
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

    // Square fit => paste offsets are 0, so build_tensor writes exactly
    // (pixel/255 - CLIP_MEAN[c]) / CLIP_STD[c] per channel with no padding.
    let tensor = crate::preprocess::build_tensor(
        dst.buffer(),
        target_size,
        s as u32,
        s as u32,
        &CLIP_MEAN,
        &CLIP_STD,
        &[0u8; 3],
    );

    Ok(tensor)
}
