use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
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
    /// Maps stringified index → tag name
    idx_to_tag: HashMap<String, String>,
    /// Maps tag name → category string
    tag_to_category: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single predicted tag with its category and confidence score.
#[derive(Debug, Clone)]
pub struct TagPrediction {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
}

/// Status of the tagger engine.
#[derive(Debug, Clone)]
pub struct TaggerStatus {
    pub loaded: bool,
    pub model_path: String,
    pub total_tags: usize,
}

// ---------------------------------------------------------------------------
// TaggerEngine
// ---------------------------------------------------------------------------

/// Lazy-loaded ONNX inference engine for Camie Tagger v2.
///
/// The 789 MB model is only loaded into memory on the first call to
/// [`tag_image`] or when [`load`] is called explicitly.  Nothing happens
/// at construction time.
pub struct TaggerEngine {
    model_path: PathBuf,
    metadata_path: PathBuf,
    /// Wrapped in Option so we can report "not loaded" state.
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
    /// Create a new engine pointing at the model directory.
    ///
    /// The model directory must contain:
    /// - `camie-tagger-v2.onnx`
    /// - `camie-tagger-v2-metadata.json`
    pub fn new(model_dir: impl AsRef<Path>) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        Self {
            model_path: dir.join("camie-tagger-v2.onnx"),
            metadata_path: dir.join("camie-tagger-v2-metadata.json"),
            inner: Mutex::new(None),
        }
    }

    /// Return true if the ONNX session is already loaded in memory.
    pub fn is_loaded(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    /// Status snapshot (does not trigger loading).
    pub fn status(&self) -> TaggerStatus {
        let guard = self.inner.lock().unwrap();
        TaggerStatus {
            loaded: guard.is_some(),
            model_path: self.model_path.display().to_string(),
            total_tags: guard.as_ref().map(|i| i.total_tags).unwrap_or(0),
        }
    }

    /// Explicitly load the model into memory.  Idempotent — safe to call
    /// multiple times.
    pub fn load(&self) -> Result<()> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(self.build_inner()?);
        Ok(())
    }

    /// Tag a single image file.  Lazily loads the model on first call.
    ///
    /// `threshold` is the minimum sigmoid confidence to include a tag.
    /// Recommended values:
    /// - 0.35  balanced (default)
    /// - 0.492 macro-optimised
    /// - 0.614 micro-optimised
    pub fn tag_image(
        &self,
        image_path: impl AsRef<Path>,
        threshold: f32,
    ) -> Result<Vec<TagPrediction>> {
        // Ensure loaded
        {
            let guard = self.inner.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }

        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().unwrap();

        // Pre-process image
        let tensor = preprocess_image(image_path.as_ref(), inner.img_size)
            .with_context(|| format!("Preprocessing {:?}", image_path.as_ref()))?;

        // Run inference
        debug!("Running Camie Tagger inference on {:?}", image_path.as_ref());
        
        let mut session_guard = inner.session.lock().unwrap();
        let outputs = session_guard
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("ONNX inference failed")?;

        // Model emits 3 outputs: [initial_preds, refined_preds, selected_candidates]
        // We use refined_preds (index 1) as the main output, matching the Python reference.
        // We retrieve the output tensor by key or order. Since Session::run output
        // is typically accessed via node name or index, let's look for "refined_predictions"
        // or check outputs.
        let output_tensor = outputs
            .get("refined_predictions")
            .or_else(|| outputs.get("output_1"))
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get refined predictions output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        let logits = output_ref.1;

        // logits shape: [1, N_tags]
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

        // Sort by category priority: character, copyright, meta, then the rest.
        // Within each category, sort by confidence score descending.
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

        info!("Loading Camie Tagger v2 ONNX model from {:?}", self.model_path);

        // Load metadata JSON
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

        // Build ONNX session — single-threaded to avoid contention with CLIP worker
        let session = Session::builder()
            .context("Failed to build tagger session")?
            .with_intra_threads(1)
            .context("Failed to set tagger threads")?
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
// Mirrors onnx_inference.py::preprocess_image() exactly:
//   1. Open + convert to RGB
//   2. Aspect-ratio-preserving resize (longest side → img_size)
//   3. Center-paste onto img_size×img_size canvas filled with ImageNet mean
//      color rgb(124, 116, 104)  [== 0.485*255, 0.456*255, 0.406*255 rounded]
//   4. Per-channel ImageNet normalization
//      mean=[0.485, 0.456, 0.406]  std=[0.229, 0.224, 0.225]
//   5. Return Array4<f32> shaped [1, 3, H, W] (NCHW)
// ---------------------------------------------------------------------------

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// ImageNet mean color used to fill padding areas, in 0–255 range.
const PAD_COLOR: [u8; 3] = [124, 116, 104];

fn preprocess_image(path: &Path, img_size: u32) -> Result<Array4<f32>> {
    let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
    let img = img.to_rgb8();

    let (orig_w, orig_h) = img.dimensions();
    let aspect = orig_w as f32 / orig_h as f32;

    // Compute new dimensions maintaining aspect ratio
    let (new_w, new_h) = if aspect > 1.0 {
        let nw = img_size;
        let nh = (img_size as f32 / aspect).round() as u32;
        (nw, nh)
    } else {
        let nh = img_size;
        let nw = (img_size as f32 * aspect).round() as u32;
        (nw, nh)
    };

    // Resize with Triangle (≈ Lanczos-lite, best available in the image crate without the lanczos feature)
    let resized = image::imageops::resize(
        &img,
        new_w,
        new_h,
        FilterType::Triangle,
    );

    // Create a blank canvas filled with ImageNet mean pad color
    let mut canvas = image::RgbImage::from_pixel(
        img_size,
        img_size,
        image::Rgb(PAD_COLOR),
    );

    // Center-paste resized image onto canvas
    let paste_x = (img_size - new_w) / 2;
    let paste_y = (img_size - new_h) / 2;
    image::imageops::overlay(&mut canvas, &resized, paste_x as i64, paste_y as i64);

    // Build [1, 3, H, W] f32 tensor with ImageNet normalization
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
