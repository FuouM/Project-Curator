pub(crate) mod preprocess;
mod types;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use curator_proto::contracts::{DevicePreference, TaggerModel};
use crate::onnx::ManagedSession;
use anyhow::{Context, Result};

use ort::{inputs, value::TensorRef};
use tracing::{debug, info, warn};

pub use types::{
    CAMIE_SPEC, TagPrediction, TaggerModelSpec, TaggerStatus, TaggerStatusInfo, WD_EVA02_SPEC,
};
use types::{MetadataRoot, TaggerMetadata};

pub struct TaggerEngine {
    session: ManagedSession,
    spec: &'static TaggerModelSpec,
    metadata_path: PathBuf,
    metadata: Mutex<Option<Arc<TaggerMetadata>>>,
}

impl TaggerEngine {
    pub fn new(
        model_dir: impl AsRef<Path>,
        spec: &'static TaggerModelSpec,
        device: DevicePreference,
    ) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let model_path = dir.join(spec.dir).join(spec.onnx_filename);
        let metadata_path = dir.join(spec.dir).join(spec.metadata_file);
        Self {
            session: ManagedSession::new(spec.display_name, model_path, device, 1),
            spec,
            metadata_path,
            metadata: Mutex::new(None),
        }
    }

    pub fn spec(&self) -> &'static TaggerModelSpec {
        self.spec
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

    pub fn status_info(&self) -> TaggerStatusInfo {
        let status = self.status();
        TaggerStatusInfo {
            key: self.spec.key.to_string(),
            name: self.spec.display_name.to_string(),
            source_name: self.spec.source_name.to_string(),
            loaded: status.loaded,
            model_path: status.model_path,
            total_tags: status.total_tags,
            default_threshold: self.spec.default_threshold,
            input_size: self.spec.input_size,
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
                "{} metadata not found at {:?}",
                self.spec.display_name,
                self.metadata_path
            );
        }

        let meta_bytes = std::fs::read(&self.metadata_path).context("Failed to read metadata JSON")?;
        let meta: MetadataRoot = serde_json::from_slice(&meta_bytes).context("Failed to parse metadata JSON")?;

        let total_tags = meta.dataset_info.tag_mapping.idx_to_tag.len();

        // Pre-resolve (tag, category) pairs into a direct indexed Vec
        let mut tags_by_index = Vec::with_capacity(total_tags);
        for i in 0..total_tags {
            let idx_str = i.to_string();
            let tag = meta.dataset_info.tag_mapping.idx_to_tag.get(&idx_str).cloned()
                .unwrap_or_else(|| format!("unknown-{}", i));
            let category = meta.dataset_info.tag_mapping.tag_to_category.get(&tag).cloned()
                .unwrap_or_else(|| "general".to_string());
            tags_by_index.push((tag, category));
        }

        let tagger_meta = Arc::new(TaggerMetadata {
            img_size: meta.model_info.img_size,
            tags_by_index,
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
        let tensor = preprocess::preprocess_image(
            image_path,
            metadata.img_size,
            &self.spec.mean,
            &self.spec.std,
            &self.spec.pad_color,
            &mut resizer,
        )
        .with_context(|| format!("Preprocessing {:?}", image_path))?;
        let preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;

        // Run inference
        let t2 = Instant::now();
        debug!(
            "Running {} inference on {:?}",
            self.spec.display_name, image_path
        );

        let logits = self.session.with_session(|session| {
            let outputs = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("ONNX inference failed")?;
            let mut output_tensor = None;
            for name in self.spec.output_names {
                if let Some(t) = outputs.get(*name) {
                    output_tensor = Some(t);
                    break;
                }
            }
            let output_tensor = output_tensor
                .with_context(|| format!("Failed to get prediction output (tried {:?})", self.spec.output_names))?;

            let output_ref = output_tensor.try_extract_tensor::<f32>()?;
            Ok(output_ref.1.to_vec())
        })?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let probs_iter = logits.iter().map(|&x| preprocess::sigmoid(x));

        let mut predictions = Vec::new();
        for (idx, prob) in probs_iter.enumerate() {
            if prob >= threshold {
                let (tag, category) = if let Some(entry) = metadata.tags_by_index.get(idx) {
                    (entry.0.clone(), entry.1.clone())
                } else {
                    (format!("unknown-{}", idx), "general".to_string())
                };
                predictions.push(TagPrediction {
                    tag,
                    category,
                    confidence: prob,
                });
            }
        }

        predictions.sort_by(|a, b| {
            let p_a = tag_category_priority(&a.category);
            let p_b = tag_category_priority(&b.category);

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
            "{} timing: load={:.1}ms preprocess={:.1}ms inference={:.1}ms postprocess={:.1}ms total={:.1}ms | {} predictions for {:?}",
            self.spec.display_name,
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
                    "{} inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...",
                    self.spec.display_name, err
                );
                self.set_device(DevicePreference::Cpu);
                return self.tag_image_inner(path, threshold);
            }
        }
        res
    }
}

impl curator_proto::pipeline::SystemNode for TaggerEngine {
    fn info(&self) -> curator_proto::pipeline::NodeInfo {
        curator_proto::pipeline::NodeInfo {
            id: self.spec.key,
            label: self.spec.display_name,
            inputs: vec![
                curator_proto::pipeline::Port { name: "image", type_name: "Image" },
            ],
            outputs: vec![
                curator_proto::pipeline::Port { name: "tags", type_name: "Tags" },
            ],
        }
    }

    fn device(&self) -> DevicePreference {
        self.session.device()
    }

    fn set_device(&self, device: DevicePreference) {
        TaggerEngine::set_device(self, device);
    }

    fn unload_all(&self) {
        TaggerEngine::unload(self);
    }

    fn is_loaded(&self) -> bool {
        TaggerEngine::is_loaded(self)
    }
}

/// Holds both tagger engines and resolves the active one from the configured
/// preferred `TaggerModel`. Two engines coexist so their outputs remain fully
/// separate in `image_tags` (distinguished by `source_id`).
pub struct TaggerManager {
    pub camie: Arc<TaggerEngine>,
    pub wd: Arc<TaggerEngine>,
}

impl TaggerManager {
    pub fn new(
        model_dir: impl AsRef<Path>,
        camie_device: DevicePreference,
        wd_device: DevicePreference,
    ) -> Self {
        Self {
            camie: Arc::new(TaggerEngine::new(&model_dir, &CAMIE_SPEC, camie_device)),
            wd: Arc::new(TaggerEngine::new(&model_dir, &WD_EVA02_SPEC, wd_device)),
        }
    }

    /// The engine for the given model.
    pub fn engine(&self, model: &TaggerModel) -> &Arc<TaggerEngine> {
        match model {
            TaggerModel::Camie => &self.camie,
            TaggerModel::WdEva02 => &self.wd,
        }
    }

    /// All engines, in a stable order, for idle-unload / node registration.
    pub fn all(&self) -> Vec<Arc<TaggerEngine>> {
        vec![self.camie.clone(), self.wd.clone()]
    }

    pub fn statuses(&self) -> Vec<TaggerStatusInfo> {
        vec![self.camie.status_info(), self.wd.status_info()]
    }

    pub fn set_device_all(&self, device: DevicePreference) {
        self.camie.set_device(device.clone());
        self.wd.set_device(device);
    }
}

/// Deliberately character-first tag ordering for tagger predictions
/// (character 0, copyright 1, meta 2, user/other 3). This is a *different*
/// ordering from `curator_proto::util::tag_sort_priority` (user-first) and MUST NOT be
/// swapped for it - the tagger ranks characters first by design.
fn tag_category_priority(cat: &str) -> i32 {
    match cat {
        "character" => 0,
        "copyright" => 1,
        "meta" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagger_ordering_is_character_first() {
        let mut preds = [
            TagPrediction { tag: "user_tag".to_string(), category: "user".into(), confidence: 0.9 },
            TagPrediction { tag: "char".to_string(), category: "character".into(), confidence: 0.1 },
            TagPrediction { tag: "meta_tag".to_string(), category: "meta".into(), confidence: 0.8 },
            TagPrediction { tag: "copy".to_string(), category: "copyright".into(), confidence: 0.7 },
        ];
        preds.sort_by(|a, b| {
            let p_a = tag_category_priority(&a.category);
            let p_b = tag_category_priority(&b.category);
            if p_a != p_b {
                p_a.cmp(&p_b)
            } else {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        let cats: Vec<&str> = preds.iter().map(|p| p.category.as_str()).collect();
        assert_eq!(cats, vec!["character", "copyright", "meta", "user"]);
    }

    #[test]
    fn tagger_priority_locks_character_first() {
        assert_eq!(tag_category_priority("character"), 0);
        assert_eq!(tag_category_priority("copyright"), 1);
        assert_eq!(tag_category_priority("meta"), 2);
        assert_eq!(tag_category_priority("user"), 3);
        assert_eq!(tag_category_priority("general"), 3);
    }
}
