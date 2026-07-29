use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;
use anyhow::{Context, Result};
use ndarray::{Array2, Array4};
use ort::{inputs, session::Session, value::TensorRef};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tracing::{debug, info};

const CCIP_INPUT_SIZE: u32 = 384;
const CCIP_EMBEDDING_DIM: usize = 768;
const DEFAULT_MATCH_THRESHOLD: f32 = 0.178;

const CLIP_MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD: [f32; 3] = [0.26862954, 0.2613026, 0.27577711];

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct CCIPModel {
    feat_model_path: PathBuf,
    metrics_model_path: PathBuf,
    feat_device: Mutex<DevicePreference>,
    metrics_device: Mutex<DevicePreference>,
    feat_session: Mutex<Option<Session>>,
    metrics_session: Mutex<Option<Session>>,
    last_used: AtomicU64,
}

impl CCIPModel {
    pub fn new(model_dir: impl AsRef<Path>, feat_device: DevicePreference, metrics_device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let ccip_dir = dir.join("ccip-caformer-24-randaug-pruned");
        Self {
            feat_model_path: ccip_dir.join("model_feat.onnx"),
            metrics_model_path: ccip_dir.join("model_metrics.onnx"),
            feat_device: Mutex::new(feat_device),
            metrics_device: Mutex::new(metrics_device),
            feat_session: Mutex::new(None),
            metrics_session: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.feat_session.lock().unwrap().is_some()
            && self.metrics_session.lock().unwrap().is_some()
    }

    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    pub fn unload(&self) {
        let mut fs = self.feat_session.lock().unwrap();
        let mut ms = self.metrics_session.lock().unwrap();
        if fs.is_some() || ms.is_some() {
            info!("CCIP: unloading models (idle {}s)", self.idle_secs());
            *fs = None;
            *ms = None;
        }
    }

    pub fn set_feat_device(&self, device: DevicePreference) {
        {
            let mut d = self.feat_device.lock().unwrap();
            *d = device.clone();
        }
        let mut fs = self.feat_session.lock().unwrap();
        if fs.is_some() {
            info!(
                "CCIP feat: device changed to {:?} — unloading for reload",
                device
            );
            *fs = None;
        }
    }

    pub fn set_metrics_device(&self, device: DevicePreference) {
        {
            let mut d = self.metrics_device.lock().unwrap();
            *d = device.clone();
        }
        let mut ms = self.metrics_session.lock().unwrap();
        if ms.is_some() {
            info!(
                "CCIP metrics: device changed to {:?} — unloading for reload",
                device
            );
            *ms = None;
        }
    }

    fn load(&self) -> Result<()> {
        {
            let fs = self.feat_session.lock().unwrap();
            let ms = self.metrics_session.lock().unwrap();
            if fs.is_some() && ms.is_some() {
                return Ok(());
            }
        }

        if !self.feat_model_path.exists() {
            anyhow::bail!(
                "CCIP feature model not found at {:?}",
                self.feat_model_path
            );
        }
        if !self.metrics_model_path.exists() {
            anyhow::bail!(
                "CCIP metrics model not found at {:?}",
                self.metrics_model_path
            );
        }

        let feat_device = self.feat_device.lock().unwrap().clone();
        let metrics_device = self.metrics_device.lock().unwrap().clone();
        info!("Loading CCIP models (feat device: {:?}, metrics device: {:?})", feat_device, metrics_device);

        {
            let mut builder = Session::builder()
                .context("Failed to build CCIP feat session")?
                .with_intra_threads(1)
                .context("Failed to set CCIP feat threads")?;
            apply_device_preference(&mut builder, &feat_device, "CCIP Feature");
            let session = builder
                .commit_from_file(&self.feat_model_path)
                .context("Failed to load CCIP feature ONNX session")?;
            let mut guard = self.feat_session.lock().unwrap();
            *guard = Some(session);
        }

        {
            let mut builder = Session::builder()
                .context("Failed to build CCIP metrics session")?
                .with_intra_threads(1)
                .context("Failed to set CCIP metrics threads")?;
            apply_device_preference(&mut builder, &metrics_device, "CCIP Metrics");
            let session = builder
                .commit_from_file(&self.metrics_model_path)
                .context("Failed to load CCIP metrics ONNX session")?;
            let mut guard = self.metrics_session.lock().unwrap();
            *guard = Some(session);
        }

        info!("CCIP ONNX sessions ready");
        Ok(())
    }

    /// Extract a 768-d embedding from an image crop.
    pub fn extract_embedding(&self, crop: &image::RgbImage) -> Result<Vec<f32>> {
        self.extract_embedding_inner(crop)
    }

    fn extract_embedding_inner(&self, crop: &image::RgbImage) -> Result<Vec<f32>> {
        let t0 = Instant::now();
        {
            let guard = self.feat_session.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

        self.last_used.store(now_secs(), Ordering::Relaxed);
        let mut guard = self.feat_session.lock().unwrap();
        let session = guard.as_mut().context("CCIP feat session not initialized")?;

        let t1 = Instant::now();
        let tensor = preprocess_ccip(crop, CCIP_INPUT_SIZE)?;
        let preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        debug!(
            "Running CCIP feature extraction ({}x{})",
            crop.width(),
            crop.height()
        );
        let outputs = session
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("CCIP feature inference failed")?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let output_tensor = outputs
            .get("output")
            .context("Failed to get output from CCIP feature model")?;
        let (_shape, data) = output_tensor.try_extract_tensor::<f32>()?;
        let embedding: Vec<f32> = data.iter().copied().collect();

        let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
        info!(
            "CCIP extract timing: load={:.1}ms preprocess={:.1}ms inference={:.1}ms total={:.1}ms | dim={}",
            load_ms, preprocess_ms, inference_ms, total_ms, embedding.len()
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

    /// Compute mean difference between a query embedding and reference embeddings
    /// using the metrics model.
    pub fn compute_mean_difference(
        &self,
        query: &[f32],
        references: &[Vec<f32>],
    ) -> Result<f32> {
        self.ensure_metrics_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);

        let mut guard = self.metrics_session.lock().unwrap();
        let session = guard
            .as_mut()
            .context("CCIP metrics session not initialized")?;

        let n = 1 + references.len();
        let mut input_vec = Vec::with_capacity(n * CCIP_EMBEDDING_DIM);
        input_vec.extend_from_slice(query);
        for r in references {
            input_vec.extend_from_slice(r);
        }

        let input_array =
            Array2::from_shape_vec((n, CCIP_EMBEDDING_DIM), input_vec)
                .context("Failed to build CCIP metrics input")?;

        let outputs = session
            .run(inputs![TensorRef::from_array_view(&input_array)?])
            .context("CCIP metrics inference failed")?;

        let output_tensor = outputs
            .get("output")
            .context("Failed to get output from CCIP metrics model")?;
        let (_shape, data) = output_tensor.try_extract_tensor::<f32>()?;

        // Output is [N, N] pairwise difference matrix
        // We want the mean of differences between query (row 0) and all references (rows 1..N)
        let mut total_diff = 0.0f32;
        for j in 1..n {
            total_diff += data[0 * n + j];
        }
        let mean_diff = total_diff / (n - 1) as f32;

        Ok(mean_diff)
    }

    fn ensure_metrics_loaded(&self) -> Result<()> {
        let guard = self.metrics_session.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        drop(guard);
        self.load()
    }

    pub fn benchmark_once(&self, crop: &image::RgbImage) -> Result<f64> {
        let t0 = Instant::now();
        {
            let guard = self.feat_session.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }

        let mut guard = self.feat_session.lock().unwrap();
        let session = guard.as_mut().context("CCIP feat session not initialized")?;

        let tensor = preprocess_ccip(crop, CCIP_INPUT_SIZE)?;
        let _ = session
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("CCIP benchmark inference failed")?;

        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    pub fn benchmark_metrics_once(&self, n_embeddings: usize) -> Result<f64> {
        self.ensure_metrics_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);

        let mut guard = self.metrics_session.lock().unwrap();
        let session = guard
            .as_mut()
            .context("CCIP metrics session not initialized")?;

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
        let _ = session
            .run(inputs![TensorRef::from_array_view(&input_array)?])
            .context("CCIP metrics benchmark inference failed")?;

        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }
}

fn preprocess_ccip(crop: &image::RgbImage, target_size: u32) -> Result<Array4<f32>> {
    let (w, h) = crop.dimensions();
    let s = target_size as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
    let slice = tensor.as_slice_mut().unwrap();

    let raw = crop.as_raw();
    for y in 0..s {
        let src_y = (y as f32 * h as f32 / target_size as f32).min(h as f32 - 1.0);
        for x in 0..s {
            let src_x = (x as f32 * w as f32 / target_size as f32).min(w as f32 - 1.0);
            let src_idx = ((src_y as u32 * w + src_x as u32) * 3) as usize;

            for c in 0..3usize {
                let val = raw[src_idx + c] as f32 / 255.0;
                let normalized = (val - CLIP_MEAN[c]) / CLIP_STD[c];
                slice[c * s * s + y * s + x] = normalized;
            }
        }
    }

    Ok(tensor)
}
