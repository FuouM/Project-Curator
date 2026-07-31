use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;
use anyhow::{Context, Result};
use ndarray::{Array4};
use ort::{inputs, session::Session, value::TensorRef};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tracing::{debug, info};

use super::types::Detection;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

const YOLO_INPUT_SIZE: u32 = 640;
const DEFAULT_CONFIDENCE: f32 = 0.3;
const NMS_IOU_THRESHOLD: f32 = 0.5;
const PAD_COLOR: [u8; 3] = [114, 114, 114];

pub struct YoloDetector {
    model_path: PathBuf,
    device: Mutex<DevicePreference>,
    session: Mutex<Option<Session>>,
    last_used: AtomicU64,
}

impl YoloDetector {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        Self {
            model_path: dir.join("person_detect_v1.1_s").join("model.onnx"),
            device: Mutex::new(device),
            session: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn is_loaded(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    pub fn unload(&self) {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            info!("YOLO: unloading model (idle {}s)", self.idle_secs());
            *guard = None;
        }
    }

    pub fn set_device(&self, device: DevicePreference) {
        {
            let mut d = self.device.lock().unwrap();
            *d = device.clone();
        }
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            info!(
                "YOLO: device changed to {:?} — unloading model for reload",
                device
            );
            *guard = None;
        }
    }

    fn load(&self) -> Result<()> {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        if !self.model_path.exists() {
            anyhow::bail!(
                "YOLO model not found at {:?}. Download person_detect_v1.1_s/model.onnx",
                self.model_path
            );
        }

        let device = self.device.lock().unwrap().clone();
        info!(
            "Loading YOLO person detection model from {:?} (device: {:?})",
            self.model_path, device
        );

        let mut builder = Session::builder()
            .context("Failed to build YOLO session")?
            .with_intra_threads(1)
            .context("Failed to set YOLO threads")?;

        apply_device_preference(&mut builder, &device, "YOLO Person");

        let session = builder
            .commit_from_file(&self.model_path)
            .context("Failed to load YOLO ONNX session")?;

        info!("YOLO ONNX session ready");
        *guard = Some(session);
        Ok(())
    }

    pub fn detect_persons(&self, image: &image::RgbImage) -> Result<Vec<Detection>> {
        self.detect_persons_inner(image, DEFAULT_CONFIDENCE)
    }

    pub fn detect_persons_with_threshold(
        &self,
        image: &image::RgbImage,
        confidence_threshold: f32,
    ) -> Result<Vec<Detection>> {
        self.detect_persons_inner(image, confidence_threshold)
    }

    fn detect_persons_inner(
        &self,
        image: &image::RgbImage,
        confidence_threshold: f32,
    ) -> Result<Vec<Detection>> {
        let t_total = Instant::now();

        // Ensure loaded
        let t0 = Instant::now();
        {
            let guard = self.session.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

        self.last_used.store(now_secs(), Ordering::Relaxed);
        let mut guard = self.session.lock().unwrap();
        let session = guard.as_mut().context("YOLO session not initialized")?;

        // Preprocess: letterbox resize to 640x640
        let t1 = Instant::now();
        let (tensor, pad_info) = preprocess_yolo(image, YOLO_INPUT_SIZE)?;
        let preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;

        // Run inference
        let t2 = Instant::now();
        debug!("Running YOLO inference ({}x{})", image.width(), image.height());
        let outputs = session
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("YOLO ONNX inference failed")?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        // Post-process: extract detections
        let t3 = Instant::now();
        let output_tensor = outputs
            .get("output0")
            .context("Failed to get output0 from YOLO model")?;
        let (shape, data) = output_tensor.try_extract_tensor::<f32>()?;

        let detections = postprocess_yolo(
            data,
            shape.num_elements(),
            image.width(),
            image.height(),
            &pad_info,
            confidence_threshold,
        )?;
        let postprocess_ms = t3.elapsed().as_secs_f64() * 1000.0;

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        info!(
            "YOLO timing: load={:.1}ms preprocess={:.1}ms inference={:.1}ms postprocess={:.1}ms total={:.1}ms | {} detections",
            load_ms, preprocess_ms, inference_ms, postprocess_ms, total_ms, detections.len()
        );

        Ok(detections)
    }

    pub fn benchmark_once(&self, image: &image::RgbImage) -> Result<f64> {
        let t0 = Instant::now();
        {
            let guard = self.session.lock().unwrap();
            if guard.is_none() {
                drop(guard);
                self.load()?;
            }
        }

        let mut guard = self.session.lock().unwrap();
        let session = guard.as_mut().context("YOLO session not initialized")?;

        let (tensor, _) = preprocess_yolo(image, YOLO_INPUT_SIZE)?;
        let _ = session
            .run(inputs![TensorRef::from_array_view(&tensor)?])
            .context("YOLO benchmark inference failed")?;

        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }
}

pub(crate) struct PadInfo {
    pad_x: u32,
    pad_y: u32,
    scale: f32,
}

pub(crate) fn preprocess_yolo(
    image: &image::RgbImage,
    target_size: u32,
) -> Result<(Array4<f32>, PadInfo)> {
    let (w, h) = image.dimensions();
    let scale = target_size as f32 / w.max(h) as f32;
    let new_w = (w as f32 * scale).round() as u32;
    let new_h = (h as f32 * scale).round() as u32;
    let pad_x = (target_size - new_w) / 2;
    let pad_y = (target_size - new_h) / 2;

    let s = target_size as usize;
    let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
    let slice = tensor.as_slice_mut().unwrap();

    let pad_r = PAD_COLOR[0] as f32 / 255.0;
    let pad_g = PAD_COLOR[1] as f32 / 255.0;
    let pad_b = PAD_COLOR[2] as f32 / 255.0;

    for y in 0..s {
        for x in 0..s {
            slice[0 * s * s + y * s + x] = pad_r;
            slice[1 * s * s + y * s + x] = pad_g;
            slice[2 * s * s + y * s + x] = pad_b;
        }
    }

    let raw = image.as_raw();
    for y in 0..new_h {
        let src_y = ((y as f32 / scale).round() as u32).min(h - 1);
        for x in 0..new_w {
            let src_x = ((x as f32 / scale).round() as u32).min(w - 1);
            let src_idx = ((src_y * w + src_x) * 3) as usize;
            let dst_y = (pad_y + y) as usize;
            let dst_x = (pad_x + x) as usize;

            slice[0 * s * s + dst_y * s + dst_x] = raw[src_idx] as f32 / 255.0;
            slice[1 * s * s + dst_y * s + dst_x] = raw[src_idx + 1] as f32 / 255.0;
            slice[2 * s * s + dst_y * s + dst_x] = raw[src_idx + 2] as f32 / 255.0;
        }
    }

    Ok((tensor, PadInfo { pad_x, pad_y, scale }))
}

fn postprocess_yolo(
    data: &[f32],
    num_elements: usize,
    orig_w: u32,
    orig_h: u32,
    pad_info: &PadInfo,
    confidence_threshold: f32,
) -> Result<Vec<Detection>> {
    // YOLOv8 output shape: [1, 4+num_classes, num_boxes]
    // For single-class person detection: [1, 5, N]
    let num_features = 5; // 4 box coords + 1 confidence
    let num_boxes = num_elements / num_features;

    let mut candidates: Vec<(f32, f32, f32, f32, f32)> = Vec::new();

    for i in 0..num_boxes {
        let cx = data[0 * num_features * num_boxes + 0 * num_boxes + i];
        let cy = data[0 * num_features * num_boxes + 1 * num_boxes + i];
        let w = data[0 * num_features * num_boxes + 2 * num_boxes + i];
        let h = data[0 * num_features * num_boxes + 3 * num_boxes + i];
        let conf = data[0 * num_features * num_boxes + 4 * num_boxes + i];

        if conf >= confidence_threshold {
            candidates.push((cx, cy, w, h, conf));
        }
    }

    // Convert xywh to xyxy
    let mut detections: Vec<Detection> = candidates
        .into_iter()
        .map(|(cx, cy, w, h, conf)| Detection {
            x0: (cx - w / 2.0) as i32,
            y0: (cy - h / 2.0) as i32,
            x1: (cx + w / 2.0) as i32,
            y1: (cy + h / 2.0) as i32,
            confidence: conf,
        })
        .collect();

    // NMS
    detections.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    apply_nms(&mut detections, NMS_IOU_THRESHOLD);

    // Scale back to original image coordinates
    let inv_scale = 1.0 / pad_info.scale;
    for det in &mut detections {
        det.x0 = ((det.x0 as f32 - pad_info.pad_x as f32) * inv_scale).round() as i32;
        det.y0 = ((det.y0 as f32 - pad_info.pad_y as f32) * inv_scale).round() as i32;
        det.x1 = ((det.x1 as f32 - pad_info.pad_x as f32) * inv_scale).round() as i32;
        det.y1 = ((det.y1 as f32 - pad_info.pad_y as f32) * inv_scale).round() as i32;

        det.x0 = det.x0.max(0).min(orig_w as i32);
        det.y0 = det.y0.max(0).min(orig_h as i32);
        det.x1 = det.x1.max(0).min(orig_w as i32);
        det.y1 = det.y1.max(0).min(orig_h as i32);
    }

    Ok(detections)
}

fn apply_nms(detections: &mut Vec<Detection>, iou_threshold: f32) {
    let mut keep = vec![true; detections.len()];
    for i in 0..detections.len() {
        if !keep[i] {
            continue;
        }
        for j in (i + 1)..detections.len() {
            if !keep[j] {
                continue;
            }
            let iou = compute_iou(&detections[i], &detections[j]);
            if iou > iou_threshold {
                keep[j] = false;
            }
        }
    }
    let mut idx = 0;
    keep.retain(|&k| {
        let keep_it = k;
        if !keep_it {
            detections.remove(idx);
        } else {
            idx += 1;
        }
        true
    });
}

fn compute_iou(a: &Detection, b: &Detection) -> f32 {
    let inter_x0 = a.x0.max(b.x0) as f32;
    let inter_y0 = a.y0.max(b.y0) as f32;
    let inter_x1 = a.x1.min(b.x1) as f32;
    let inter_y1 = a.y1.min(b.y1) as f32;

    let inter_area = (inter_x1 - inter_x0).max(0.0) * (inter_y1 - inter_y0).max(0.0);
    let a_area = (a.x1 - a.x0) as f32 * (a.y1 - a.y0) as f32;
    let b_area = (b.x1 - b.x0) as f32 * (b.y1 - b.y0) as f32;
    let union_area = a_area + b_area - inter_area;

    if union_area <= 0.0 {
        0.0
    } else {
        inter_area / union_area
    }
}
