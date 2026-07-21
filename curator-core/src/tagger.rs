use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;

use ndarray::Array4;
use ort::{inputs, session::Session, value::TensorRef};
use serde::Deserialize;
use tracing::{debug, info, warn};

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

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
    last_used: AtomicU64,
}

struct TaggerInner {
    session: Mutex<Session>,
    img_size: u32,
    idx_to_tag: HashMap<String, String>,
    tag_to_category: HashMap<String, String>,
    total_tags: usize,
    resizer: Mutex<fast_image_resize::Resizer>,
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

    fn tag_image_inner(
        &self,
        image_path: &Path,
        threshold: f32,
    ) -> Result<Vec<TagPrediction>> {
        let t_total = Instant::now();

        // Ensure loaded
        let t0 = Instant::now();
        {            let guard = self.inner.lock().unwrap();
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
        let tensor = preprocess_image(image_path, inner.img_size, &mut resizer_guard)
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
        let postprocess_ms = t2.elapsed().as_secs_f64() * 1000.0 - inference_ms;

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        info!(
            "Camie Tagger timing: load={:.1}ms preprocess={:.1}ms inference={:.1}ms postprocess={:.1}ms total={:.1}ms | {} predictions for {:?}",
            load_ms, preprocess_ms, inference_ms, postprocess_ms, total_ms,
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
        if res.is_err() {
            let is_gpu = {
                let d = self.device.lock().unwrap();
                *d != DevicePreference::Cpu
            };
            if is_gpu {
                let err = res.unwrap_err();
                warn!("Camie Tagger inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...", err);
                self.set_device(DevicePreference::Cpu);
                return self.tag_image_inner(path, threshold);
            }
        }
        res
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
            resizer: Mutex::new(fast_image_resize::Resizer::new()),
        })
    }
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PAD_COLOR: [u8; 3] = [124, 116, 104];

fn preprocess_image(path: &Path, img_size: u32, resizer: &mut fast_image_resize::Resizer) -> Result<Array4<f32>> {
    // Fast decode: turbojpeg for JPEG, png+zlib-rs for PNG, image crate fallback
    let data = std::fs::read(path).with_context(|| format!("Cannot read image {:?}", path))?;
    let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
    let is_png = data.len() >= 8
        && data[0..8] == [137, 80, 78, 71, 13, 10, 26, 10];

    let (rgb_buf, orig_w, orig_h) = if is_jpeg {
        let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB)
            .with_context(|| format!("turbojpeg decode failed for {:?}", path))?;
        (image.pixels.to_vec(), image.width as u32, image.height as u32)
    } else if is_png {
        let decoder = png::Decoder::new(std::io::Cursor::new(&data));
        let mut reader = decoder.read_info()
            .with_context(|| format!("png decode header failed for {:?}", path))?;
        let w = reader.info().width;
        let h = reader.info().height;
        // Always allocate w*h*4 (max RGBA) — output_buffer_size() can underreport
        // for interlaced or palette-based PNGs, causing "Size of buffer is smaller
        // than required" on next_frame().
        let buf_size = w as usize * h as usize * 4;
        let mut raw = vec![0u8; buf_size];
        let out_info = reader.next_frame(&mut raw)
            .with_context(|| format!("png decode failed for {:?}", path))?;
        let pixels = out_info.buffer_size();
        let rgb: Vec<u8> = match out_info.color_type {
            png::ColorType::Rgb => raw[..pixels].to_vec(),
            png::ColorType::Rgba => raw[..pixels].chunks(4).flat_map(|c| [c[0], c[1], c[2]]).collect(),
            png::ColorType::Grayscale => raw[..pixels].iter().map(|&g| [g, g, g]).flatten().collect(),
            png::ColorType::GrayscaleAlpha => raw[..pixels].chunks(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
            png::ColorType::Indexed => {
                let palette = reader.info().palette.as_deref()
                    .context("Indexed PNG has no palette")?;
                raw[..pixels].iter()
                    .map(|&idx| {
                        let i = idx as usize * 3;
                        [palette[i], palette[i + 1], palette[i + 2]]
                    })
                    .flatten()
                    .collect()
            }
        };
        (rgb, w, h)
    } else {
        let img = image::open(path).with_context(|| format!("Cannot open image {:?}", path))?;
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        (rgb.into_raw(), w, h)
    };

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

    // SIMD-accelerated resize via fast_image_resize (resizer reused across calls)
    let src = fast_image_resize::images::ImageRef::new(
        orig_w, orig_h, &rgb_buf, fast_image_resize::PixelType::U8x3,
    )?;
    let dst_buf = vec![0u8; (new_w * new_h * 3) as usize];
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        new_w, new_h, dst_buf, fast_image_resize::PixelType::U8x3,
    )?;
    let opts = fast_image_resize::ResizeOptions::new()
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(
            fast_image_resize::FilterType::Bilinear,
        ));
    resizer.resize(&src, &mut dst, Some(&opts))?;
    let data = dst.buffer();

    let s = img_size as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
    let slice = tensor.as_slice_mut().unwrap();

    let paste_x = ((img_size - new_w) / 2) as usize;
    let paste_y = ((img_size - new_h) / 2) as usize;
    let nw = new_w as usize;
    let nh = new_h as usize;

    for c in 0..3usize {
        let mean = IMAGENET_MEAN[c];
        let std_dev = IMAGENET_STD[c];
        let pad_val = (PAD_COLOR[c] as f32 / 255.0 - mean) / std_dev;
        let dst_base = c * s * s;

        for y in 0..s {
            let rs = dst_base + y * s;
            for x in 0..s {
                slice[rs + x] = pad_val;
            }
        }

        for y in 0..nh {
            let src_row = y * nw * 3 + c;
            let dst_row = dst_base + (paste_y + y) * s + paste_x;
            for x in 0..nw {
                let val = data[src_row + x * 3] as f32 / 255.0;
                slice[dst_row + x] = (val - mean) / std_dev;
            }
        }
    }

    Ok(tensor)
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
