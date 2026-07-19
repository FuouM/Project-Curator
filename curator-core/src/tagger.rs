use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;
use image::{GenericImageView, imageops::FilterType};
use ndarray::Array4;
use ort::{inputs, session::Session, value::TensorRef};
use serde::Deserialize;
use tracing::{debug, info};

// ---------------------------------------------------------------------------
// Metadata structures (mirrors camie-tagger-v2-metadata.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct MetadataRoot {
    model_info: ModelInfo,
    dataset_info: DatasetInfo,
}

#[derive(Debug, Deserialize)]
struct ModelInfo {
    img_size: u32,
}

#[derive(Debug, Deserialize)]
struct DatasetInfo {
    tag_mapping: TagMapping,
}

#[derive(Debug, Deserialize)]
struct TagMapping {
    idx_to_tag: HashMap<String, String>,
    tag_to_category: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TagPrediction {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct TaggerStatus {
    pub loaded: bool,
    pub model_path: String,
    pub total_tags: usize,
}

// ---------------------------------------------------------------------------
// TaggerEngine
// ---------------------------------------------------------------------------

pub struct TaggerEngine {
    model_path: PathBuf,
    metadata_path: PathBuf,
    device: Mutex<DevicePreference>,
    inner: Mutex<Option<TaggerInner>>,
}

struct TaggerInner {
    session: Mutex<Session>,
    img_size: u32,
    idx_to_tag: HashMap<String, String>,
    tag_to_category: HashMap<String, String>,
    total_tags: usize,
}

impl TaggerEngine {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        Self {
            model_path: dir.join("camie-tagger-v2.onnx"),
            metadata_path: dir.join("camie-tagger-v2-metadata.json"),
            device: Mutex::new(device),
            inner: Mutex::new(None),
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn is_loaded(&self) -> bool {
        self.inner.lock().unwrap().is_some()
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
            info!("Camie Tagger: device changed to {:?} — unloading model for reload", device);
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

    pub fn tag_image(
        &self,
        image_path: impl AsRef<Path>,
        threshold: f32,
    ) -> Result<Vec<TagPrediction>> {
        {
            let guard = self.inner.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }

        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().unwrap();

        let tensor = preprocess_image(image_path.as_ref(), inner.img_size)
            .with_context(|| format!("Preprocessing {:?}", image_path.as_ref()))?;

        debug!("Running Camie Tagger inference on {:?}", image_path.as_ref());
        
        let mut session_guard = inner.session.lock().unwrap();
        let outputs = session_guard
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("ONNX inference failed")?;

        let output_tensor = outputs
            .get("refined_predictions")
            .or_else(|| outputs.get("output_1"))
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get refined predictions output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        let logits = output_ref.1;

        let probs_iter = logits.iter().map(|&x| sigmoid(x));

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
                b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal)
            }
        });

        info!(
            "Camie Tagger: {} predictions above threshold {:.3} for {:?}",
            predictions.len(),
            threshold,
            image_path.as_ref()
        );

        Ok(predictions)
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

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

        info!("Loading Camie Tagger v2 ONNX model from {:?} (device: {:?})", self.model_path, device);

        let meta_bytes = std::fs::read(&self.metadata_path)
            .context("Failed to read metadata JSON")?;
        let meta: MetadataRoot = serde_json::from_slice(&meta_bytes)
            .context("Failed to parse metadata JSON")?;

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
        })
    }
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PAD_COLOR: [u8; 3] = [124, 116, 104];

fn preprocess_image(path: &Path, img_size: u32) -> Result<Array4<f32>> {
    let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
    let img = img.to_rgb8();

    let (orig_w, orig_h) = img.dimensions();
    let aspect = orig_w as f32 / orig_h as f32;

    let (new_w, new_h) = if aspect > 1.0 {
        let nw = img_size;
        let nh = (img_size as f32 / aspect).round() as u32;
        (nw, nh)
    } else {
        let nh = img_size;
        let nw = (img_size as f32 * aspect).round() as u32;
        (nw, nh)
    };

    let resized = image::imageops::resize(
        &img,
        new_w,
        new_h,
        FilterType::Triangle,
    );

    let mut canvas = image::RgbImage::from_pixel(
        img_size,
        img_size,
        image::Rgb(PAD_COLOR),
    );

    let paste_x = (img_size - new_w) / 2;
    let paste_y = (img_size - new_h) / 2;
    image::imageops::overlay(&mut canvas, &resized, paste_x as i64, paste_y as i64);

    let s = img_size as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));

    for y in 0..s {
        for x in 0..s {
            let pixel = canvas.get_pixel(x as u32, y as u32);
            for c in 0..3usize {
                let val = pixel[c] as f32 / 255.0;
                tensor[[0, c, y, x]] = (val - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
            }
        }
    }

    Ok(tensor)
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
