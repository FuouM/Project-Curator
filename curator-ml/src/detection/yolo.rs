use crate::onnx::ManagedSession;
use anyhow::{Context, Result};
use curator_proto::contracts::DevicePreference;
use ndarray::Array4;
use ort::{inputs, value::TensorRef};
use std::path::Path;
use std::time::Instant;
use tracing::{debug, info};

use super::types::Detection;

const YOLO_INPUT_SIZE: u32 = 640;
const DEFAULT_CONFIDENCE: f32 = 0.3;
const NMS_IOU_THRESHOLD: f32 = 0.5;
const PAD_COLOR: [u8; 3] = [114, 114, 114];

pub struct YoloDetector {
    session: ManagedSession,
}

impl YoloDetector {
    pub fn new(
        model_dir: impl AsRef<Path>,
        device: DevicePreference,
        prefer_quantized: bool,
    ) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let mut model_path = dir.join("yolo-person").join("model.onnx");
        if prefer_quantized {
            let int8_path = dir.join("yolo-person").join("model_int8.onnx");
            if int8_path.exists() {
                model_path = int8_path;
            }
        }
        tracing::info!("YOLO Person: using model path {:?}", model_path);
        Self {
            session: ManagedSession::new("YOLO Person", model_path, device, 1),
        }
    }

    pub fn model_path(&self) -> &Path {
        self.session.model_path()
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

        let t0 = Instant::now();
        let preprocess_ms: f64;
        let (tensor, pad_info) = {
            let t1 = Instant::now();
            let res = preprocess_yolo(image, YOLO_INPUT_SIZE)?;
            preprocess_ms = t1.elapsed().as_secs_f64() * 1000.0;
            res
        };

        // Run inference
        let t2 = Instant::now();
        debug!(
            "Running YOLO inference ({}x{})",
            image.width(),
            image.height()
        );
        let data_vec = self.session.with_session(|session| {
            let outputs = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("YOLO ONNX inference failed")?;
            let output_tensor = outputs
                .get("output0")
                .context("Failed to get output0 from YOLO model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;
        let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

        // Post-process: extract detections
        let t3 = Instant::now();
        let detections = postprocess_yolo(
            &data_vec,
            data_vec.len(),
            image.width(),
            image.height(),
            &pad_info,
            confidence_threshold,
        )?;
        let postprocess_ms = t3.elapsed().as_secs_f64() * 1000.0;

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        let load_ms =
            t0.elapsed().as_secs_f64() * 1000.0 - preprocess_ms - inference_ms - postprocess_ms;
        info!(
            "YOLO timing: load_and_overhead={:.1}ms preprocess={:.1}ms inference={:.1}ms postprocess={:.1}ms total={:.1}ms | {} detections",
            load_ms.max(0.0),
            preprocess_ms,
            inference_ms,
            postprocess_ms,
            total_ms,
            detections.len()
        );

        Ok(detections)
    }

    pub fn benchmark_once(&self, image: &image::RgbImage) -> Result<f64> {
        let t0 = Instant::now();
        let (tensor, _) = preprocess_yolo(image, YOLO_INPUT_SIZE)?;
        self.session.with_session(|session| {
            let _ = session
                .run(inputs![TensorRef::from_array_view(&tensor)?])
                .context("YOLO benchmark inference failed")?;
            Ok(())
        })?;
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

    // Fit-to-640 bilinear resize (standard YOLO letterbox, not nearest-neighbour),
    // then copy into the padded tensor. fast_image_resize is ~24x faster than the
    // legacy image-crate Triangle filter and far more accurate than hand-rolled
    // source picking.
    let mut resizer = fast_image_resize::Resizer::new();
    let src = fast_image_resize::images::ImageRef::new(
        w,
        h,
        image.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )?;
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        new_w,
        new_h,
        vec![0u8; (new_w * new_h * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )?;
    let opts = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
    );
    resizer.resize(&src, &mut dst, Some(&opts))?;

    // Normalize with mean=0/std=1 (equivalent to a raw /255.0), letterbox fill
    // keeps YOLO's own PAD_COLOR [114,114,114]. Do NOT use
    // crate::preprocess::PAD_COLOR ([124,116,104]) here - it would change the
    // letterbox inputs and potentially alter detections.
    let tensor = crate::preprocess::build_tensor(
        dst.buffer(),
        target_size,
        new_w,
        new_h,
        &[0.0f32; 3],
        &[1.0f32; 3],
        &PAD_COLOR,
    );

    Ok((
        tensor,
        PadInfo {
            pad_x,
            pad_y,
            scale,
        },
    ))
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
        let cx = data[i];
        let cy = data[num_boxes + i];
        let w = data[2 * num_boxes + i];
        let h = data[3 * num_boxes + i];
        let conf = data[4 * num_boxes + i];

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
    let keep = super::nms::nms_indices(detections, iou_threshold, |d| {
        [d.x0 as f32, d.y0 as f32, d.x1 as f32, d.y1 as f32]
    });
    *detections = keep.into_iter().map(|i| detections[i].clone()).collect();
}

impl curator_proto::pipeline::SystemNode for YoloDetector {
    fn info(&self) -> curator_proto::pipeline::NodeInfo {
        curator_proto::pipeline::NodeInfo {
            id: "yolo-detector",
            label: "YOLO Person Detector",
            inputs: vec![curator_proto::pipeline::Port {
                name: "image",
                type_name: "Image",
            }],
            outputs: vec![curator_proto::pipeline::Port {
                name: "detections",
                type_name: "List[Detection]",
            }],
        }
    }

    fn device(&self) -> DevicePreference {
        self.session.device()
    }

    fn set_device(&self, device: DevicePreference) {
        YoloDetector::set_device(self, device);
    }

    fn unload_all(&self) {
        YoloDetector::unload(self);
    }

    fn is_loaded(&self) -> bool {
        YoloDetector::is_loaded(self)
    }
}
