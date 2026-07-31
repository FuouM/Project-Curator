pub(crate) mod preprocess;
mod types;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::ipc::DevicePreference;
use crate::onnx::ManagedSession;
use anyhow::{Context, Result};

use ort::{inputs, value::TensorRef};
use tracing::{debug, info, warn};

pub use types::{TagPrediction, TaggerStatus};
use types::{MetadataRoot, TaggerMetadata};

pub struct TaggerEngine {
    session: ManagedSession,
    metadata_path: PathBuf,
    metadata: Mutex<Option<Arc<TaggerMetadata>>>,
}

impl TaggerEngine {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let model_path = dir.join("camie-tagger-v2.onnx");
        let metadata_path = dir.join("camie-tagger-v2-metadata.json");
        Self {
            session: ManagedSession::new("Camie Tagger", model_path, device, 1),
            metadata_path,
            metadata: Mutex::new(None),
        }
    }

    pub fn model_path(&self) -> &Path {
        self.session.model_path()
    }

    pub fn is_loaded(&self) -> bool {
        self.session.is_loaded()
    }

    /// Seconds since last inference.
    pub fn idle_secs(&self) -> u64 {
        self.session.idle_secs()
    }

    /// Unload the model from memory to free RAM.
    pub fn unload(&self) {
        self.session.unload();
    }

    pub fn status(&self) -> TaggerStatus {
        let guard = self.metadata.lock().unwrap();
        TaggerStatus {
            loaded: self.session.is_loaded(),
            model_path: self.session.model_path().display().to_string(),
            total_tags: guard.as_ref().map(|m| m.total_tags).unwrap_or(0),
        }
    }

    pub fn set_device(&self, device: DevicePreference) {
        self.session.set_device(device);
    }

    pub fn load(&self) -> Result<()> {
        let _ = self.ensure_metadata_loaded()?;
        self.session.load()?;
        Ok(())
    }

    fn ensure_metadata_loaded(&self) -> Result<Arc<TaggerMetadata>> {
        let mut guard = self.metadata.lock().unwrap();
        if let Some(ref meta) = *guard {
            return Ok(meta.clone());
        }

        if !self.metadata_path.exists() {
            anyhow::bail!(
                "Camie Tagger metadata not found at {:?}",
                self.metadata_path
            );
        }

        let meta_bytes = std::fs::read(&self.metadata_path).context("Failed to read metadata JSON")?;
        let meta: MetadataRoot = serde_json::from_slice(&meta_bytes).context("Failed to parse metadata JSON")?;

        let total_tags = meta.dataset_info.tag_mapping.idx_to_tag.len();
        let tagger_meta = Arc::new(TaggerMetadata {
            img_size: meta.model_info.img_size,
            idx_to_tag: meta.dataset_info.tag_mapping.idx_to_tag,
            tag_to_category: meta.dataset_info.tag_mapping.tag_to_category,
            total_tags,
        });

        *guard = Some(tagger_meta.clone());
        Ok(tagger_meta)
    }

    fn tag_image_inner(&self, image_path: &Path, threshold: f32) -> Result<Vec<TagPrediction>> {
        let t_total = Instant::now();

        // Ensure loaded and metadata ready
        let t0 = Instant::now();
        let metadata = self.ensure_metadata_loaded()?;
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // Pre-process image
        let t1 = Instant::now();
        let mut resizer = fast_image_resize::Resizer::new();
        let tensor = preprocess::preprocess_image(image_path, metadata.img_size, &mut resizer)
            .with_context(|| format!("Preprocessing {:?}", image_path))?;
        let preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;

        // Run inference
        let t2 = Instant::now();
        debug!("Running Camie Tagger inference on {:?}", image_path);

        let logits = self.session.with_session(|session| {
            let outputs = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("ONNX inference failed")?;
            let output_tensor = outputs
                .get("refined_predictions")
                .or_else(|| outputs.get("output_1"))
                .or_else(|| outputs.get("output_0"))
                .context("Failed to get refined predictions output from model")?;

            let output_ref = output_tensor.try_extract_tensor::<f32>()?;
            Ok(output_ref.1.to_vec())
        })?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let probs_iter = logits.iter().map(|&x| preprocess::sigmoid(x));

        let mut predictions = Vec::new();
        for (idx, prob) in probs_iter.enumerate() {
            if prob >= threshold {
                let idx_str = idx.to_string();
                let tag = metadata
                    .idx_to_tag
                    .get(&idx_str)
                    .cloned()
                    .unwrap_or_else(|| format!("unknown-{}", idx));
                let category = metadata
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
            let is_gpu = self.session.device() != DevicePreference::Cpu;
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
}
