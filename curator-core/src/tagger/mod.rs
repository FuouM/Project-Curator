mod preprocess;
mod types;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;
use anyhow::{Context, Result};

use ort::{inputs, session::Session, value::TensorRef};
use tracing::{debug, info, warn};

pub use types::{TagPrediction, TaggerStatus};
use types::{MetadataRoot, TaggerInner};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct TaggerEngine {
    model_path: PathBuf,
    metadata_path: PathBuf,
    device: Mutex<DevicePreference>,
    inner: Mutex<Option<TaggerInner>>,
    last_used: AtomicU64,
}

impl TaggerEngine {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        Self {
            model_path: dir.join("camie-tagger-v2.onnx"),
            metadata_path: dir.join("camie-tagger-v2-metadata.json"),
            device: Mutex::new(device),
            inner: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn is_loaded(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    /// Seconds since last inference.
    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    /// Unload the model from memory to free RAM.
    pub fn unload(&self) {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            info!("Camie Tagger: unloading model (idle {}s)", self.idle_secs());
            *guard = None;
        }
    }

    pub fn status(&self) -> TaggerStatus {
        let guard = self.inner.lock().unwrap();
        TaggerStatus {
            loaded: guard.is_some(),
            model_path: self.model_path.display().to_string(),
            total_tags: guard.as_ref().map(|i| i.total_tags).unwrap_or(0),
        }
    }

    pub fn set_device(&self, device: DevicePreference) {
        {
            let mut d = self.device.lock().unwrap();
            *d = device.clone();
        }
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            info!(
                "Camie Tagger: device changed to {:?} — unloading model for reload",
                device
            );
            *guard = None;
        }
    }

    pub fn load(&self) -> Result<()> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(self.build_inner()?);
        Ok(())
    }

    fn tag_image_inner(&self, image_path: &Path, threshold: f32) -> Result<Vec<TagPrediction>> {
        let t_total = Instant::now();

        // Ensure loaded
        let t0 = Instant::now();
        {
            let guard = self.inner.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

        self.last_used.store(now_secs(), Ordering::Relaxed);
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().unwrap();

        // Pre-process image
        let t1 = Instant::now();
        let mut resizer_guard = inner.resizer.lock().unwrap();
        let tensor = preprocess::preprocess_image(image_path, inner.img_size, &mut resizer_guard)
            .with_context(|| format!("Preprocessing {:?}", image_path))?;
        drop(resizer_guard);
        let preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;

        // Run inference
        let t2 = Instant::now();

        debug!("Running Camie Tagger inference on {:?}", image_path);

        let mut session_guard = inner.session.lock().unwrap();
        let outputs = session_guard
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("ONNX inference failed")?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let output_tensor = outputs
            .get("refined_predictions")
            .or_else(|| outputs.get("output_1"))
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get refined predictions output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        let logits = output_ref.1;

        let probs_iter = logits.iter().map(|&x| preprocess::sigmoid(x));

        let mut predictions = Vec::new();
        for (idx, prob) in probs_iter.enumerate() {
            if prob >= threshold {
                let idx_str = idx.to_string();
                let tag = inner
                    .idx_to_tag
                    .get(&idx_str)
                    .cloned()
                    .unwrap_or_else(|| format!("unknown-{}", idx));
                let category = inner
                    .tag_to_category
                    .get(&tag)
                    .cloned()
                    .unwrap_or_else(|| "general".to_string());
                predictions.push(TagPrediction {
                    tag,
                    category,
                    confidence: prob,
                });
            }
        }

        predictions.sort_by(|a, b| {
            let priority = |cat: &str| -> i32 {
                match cat {
                    "character" => 0,
                    "copyright" => 1,
                    "meta" => 2,
                    _ => 3,
                }
            };

            let p_a = priority(&a.category);
            let p_b = priority(&b.category);

            if p_a != p_b {
                p_a.cmp(&p_b)
            } else {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }
        });
        let postprocess_ms = t2.elapsed().as_secs_f64() * 1000.0 - inference_ms;

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        info!(
            "Camie Tagger timing: load={:.1}ms preprocess={:.1}ms inference={:.1}ms postprocess={:.1}ms total={:.1}ms | {} predictions for {:?}",
            load_ms,
            preprocess_ms,
            inference_ms,
            postprocess_ms,
            total_ms,
            predictions.len(),
            image_path
        );

        Ok(predictions)
    }

    pub fn tag_image(
        &self,
        image_path: impl AsRef<Path>,
        threshold: f32,
    ) -> Result<Vec<TagPrediction>> {
        let path = image_path.as_ref();
        let res = self.tag_image_inner(path, threshold);
        if let Err(ref err) = res {
            let is_gpu = {
                let d = self.device.lock().unwrap();
                *d != DevicePreference::Cpu
            };
            if is_gpu {
                warn!(
                    "Camie Tagger inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...",
                    err
                );
                self.set_device(DevicePreference::Cpu);
                return self.tag_image_inner(path, threshold);
            }
        }
        res
    }

    fn build_inner(&self) -> Result<TaggerInner> {
        if !self.model_path.exists() {
            anyhow::bail!(
                "Camie Tagger model not found at {:?}. \
                 Set --tagger-model-dir to the directory containing camie-tagger-v2.onnx",
                self.model_path
            );
        }
        if !self.metadata_path.exists() {
            anyhow::bail!(
                "Camie Tagger metadata not found at {:?}",
                self.metadata_path
            );
        }

        let device = self.device.lock().unwrap().clone();

        info!(
            "Loading Camie Tagger v2 ONNX model from {:?} (device: {:?})",
            self.model_path, device
        );

        let meta_bytes =
            std::fs::read(&self.metadata_path).context("Failed to read metadata JSON")?;
        let meta: MetadataRoot =
            serde_json::from_slice(&meta_bytes).context("Failed to parse metadata JSON")?;

        let img_size = meta.model_info.img_size;
        let idx_to_tag = meta.dataset_info.tag_mapping.idx_to_tag;
        let tag_to_category = meta.dataset_info.tag_mapping.tag_to_category;
        let total_tags = idx_to_tag.len();

        info!(
            "Camie Tagger metadata loaded: {} tags, img_size={}",
            total_tags, img_size
        );

        let mut builder = Session::builder()
            .context("Failed to build tagger session")?
            .with_intra_threads(1)
            .context("Failed to set tagger threads")?;

        apply_device_preference(&mut builder, &device, "Camie Tagger");

        let session = builder
            .commit_from_file(&self.model_path)
            .context("Failed to load Camie Tagger ONNX session")?;

        info!("Camie Tagger ONNX session ready");

        Ok(TaggerInner {
            session: Mutex::new(session),
            img_size,
            idx_to_tag,
            tag_to_category,
            total_tags,
            resizer: Mutex::new(fast_image_resize::Resizer::new()),
        })
    }
}
