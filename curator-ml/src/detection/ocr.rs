use std::path::Path;
use anyhow::{Context, Result};
use ndarray::Array4;
use ort::{inputs, value::TensorRef};
use image::{ImageBuffer, RgbImage, Rgb};

use super::bubbles::{BubbleDetection, MangaBubbleDetector, reorder_by_bubbles};
use curator_proto::contracts::DevicePreference;
use crate::preprocess::resize_rgb_bilinear;

#[derive(Debug, Clone)]
pub struct OcrDetection {
    pub text: String,
    pub confidence: f32,
    pub polygon: [[i32; 2]; 4],
    pub is_from_bubble: bool,
}

use crate::onnx::ManagedSession;

pub struct OcrDetector {
    pub det_session: ManagedSession,
    pub rec_session: ManagedSession,
    pub cls_session: Option<ManagedSession>,
    pub rec_chars: Vec<String>,
    pub bubble_detector: MangaBubbleDetector,
}

impl OcrDetector {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference, prefer_quantized_ocr: bool, prefer_quantized_bubble: bool) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let mut det_model = dir.join("pp-ocrv6-medium").join("det").join("inference.onnx");
        if prefer_quantized_ocr {
            let int8_path = dir.join("pp-ocrv6-medium").join("det").join("inference_int8.onnx");
            if int8_path.exists() {
                det_model = int8_path;
            }
        }
        let (rec_model, rec_dict) = {
            let mut model = dir.join("pp-ocrv6-medium").join("rec").join("inference.onnx");
            if prefer_quantized_ocr {
                let int8_path = dir.join("pp-ocrv6-medium").join("rec").join("inference_int8.onnx");
                if int8_path.exists() {
                    model = int8_path;
                }
            }
            let dict  = dir.join("pp-ocrv6-medium").join("rec").join("inference.yml");
            (model, dict)
        };
        tracing::info!("OCR Det: using model path {:?}", det_model);
        tracing::info!("OCR Rec: using model path {:?}", rec_model);
        let cls_model = dir.join("pp-lcnet-cls").join("inference.onnx");
        let cls_session = if cls_model.exists() {
            Some(ManagedSession::new("OCR Cls", cls_model, device.clone(), 1))
        } else {
            None
        };

        // Search upwards for onnxruntime.dll starting from current executable path
        if let Ok(exe_path) = std::env::current_exe() {
            let mut current_dir = exe_path.parent();
            let mut found = false;
            for _ in 0..5 {
                if let Some(d) = current_dir {
                    let candidate = d.join("onnxruntime.dll");
                    if candidate.exists() {
                        tracing::info!("OCR: Setting ORT_DYLIB_PATH to {:?}", candidate);
                        unsafe {
                            std::env::set_var("ORT_DYLIB_PATH", &candidate);
                        }
                        found = true;
                        break;
                    }
                    current_dir = d.parent();
                } else {
                    break;
                }
            }
            if !found {
                let workspace_candidate = std::path::Path::new("onnxruntime.dll");
                if workspace_candidate.exists() {
                    tracing::info!("OCR: Setting ORT_DYLIB_PATH to workspace path {:?}", workspace_candidate);
                    unsafe {
                        std::env::set_var("ORT_DYLIB_PATH", workspace_candidate);
                    }
                }
            }
        }

        // Load character dictionary from inference.yml PostProcess.character_dict entries.
        let mut rec_chars = vec!["blank".to_string()];
        if rec_dict.exists() {
            if let Ok(content) = std::fs::read_to_string(&rec_dict) {
                let mut in_char_dict = false;
                for line in content.lines() {
                    let trimmed = line.trim_end_matches('\r');
                    let trimmed_stripped = trimmed.trim();

                    if trimmed_stripped.is_empty() {
                        continue;
                    }

                    if trimmed_stripped == "character_dict:" {
                        in_char_dict = true;
                        continue;
                    }

                    if in_char_dict {
                        if let Some(rest) = trimmed_stripped.strip_prefix("- ") {
                            let ch = if rest.starts_with('\'') && rest.ends_with('\'') {
                                let inner = &rest[1..rest.len()-1];
                                inner.replace("''", "'")
                            } else if rest.starts_with('"') && rest.ends_with('"') {
                                rest[1..rest.len()-1].to_string()
                            } else {
                                rest.to_string()
                            };
                            rec_chars.push(ch);
                        } else if trimmed_stripped == "-" {
                            rec_chars.push(String::new());
                        } else {
                            in_char_dict = false;
                        }
                    }
                }
            }
        }
        rec_chars.push(" ".to_string());

        Self {
            det_session: ManagedSession::new("OCR Det", det_model, device.clone(), 1),
            rec_session: ManagedSession::new("OCR Rec", rec_model, device.clone(), 1),
            cls_session,
            rec_chars,
            bubble_detector: MangaBubbleDetector::new(model_dir.as_ref(), device, prefer_quantized_bubble),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.det_session.is_loaded() && self.rec_session.is_loaded()
    }

    pub fn idle_secs(&self) -> u64 {
        let mut max_idle = self.det_session.idle_secs().max(self.rec_session.idle_secs());
        if let Some(ref cls) = self.cls_session {
            max_idle = max_idle.max(cls.idle_secs());
        }
        max_idle = max_idle.max(self.bubble_detector.session.idle_secs());
        max_idle
    }

    pub fn unload(&self) {
        self.det_session.unload();
        self.rec_session.unload();
        if let Some(ref cls) = self.cls_session {
            cls.unload();
        }
        self.bubble_detector.unload();
    }

    pub fn set_device(&self, device: DevicePreference) {
        self.det_session.set_device(device.clone());
        self.rec_session.set_device(device.clone());
        if let Some(ref cls) = self.cls_session {
            cls.set_device(device.clone());
        }
        self.bubble_detector.session.set_device(device);
    }

    pub fn load(&self) -> Result<()> {
        self.det_session.load()?;
        self.rec_session.load()?;
        if let Some(ref cls) = self.cls_session {
            let _ = cls.load();
        }
        if self.bubble_detector.is_available() {
            let _ = self.bubble_detector.session.load();
        }
        Ok(())
    }

    pub fn run_ocr(&self, image: &RgbImage) -> Result<(Vec<OcrDetection>, Vec<BubbleDetection>)> {
        let (ow, oh) = image.dimensions();
        let orig_w = ow as usize;
        let orig_h = oh as usize;

        // 1. Preprocess for detection
        let (det_tensor, _resize_w, _resize_h) = preprocess_det(image)?;

        // 2. Run detection model
        let (shape, pred_data) = self.det_session.with_session(|session| {
            let outputs = session.run(inputs![TensorRef::from_array_view(&det_tensor)?])?;
            let output_tensor = outputs.get("fetch_name_0")
                .or_else(|| outputs.get("maps"))
                .or_else(|| outputs.get("output_0"))
                .context("Failed to get detection maps output from OCR model")?;
            let (shape, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok((shape.to_owned(), data.to_vec()))
        })?;

        let map_h = shape[2] as usize;
        let map_w = shape[3] as usize;

        // 3. Extract bounding box polygons from the probability map
        let quads = extract_boxes_from_map(
            &pred_data,
            (map_w, map_h),
            (orig_w, orig_h),
            DbPostProcessParams::default(),
        )?;

        // Sort boxes top-to-bottom, left-to-right, then merge fragmented boxes
        let quads = sorted_boxes(quads);
        let mut quads = merge_fragmented(quads);

        // 3b. Run manga bubble detector and reorder DB boxes by bubble
        let mut detected_bubbles = Vec::new();
        let bubble_flags = if self.bubble_detector.is_available() {
            tracing::debug!("Running manga bubble detection...");
            match self.bubble_detector.detect_bubbles(image, 0.5) {
                Ok(bubbles) => {
                    detected_bubbles = bubbles.clone();
                    if !bubbles.is_empty() {
                        let (reordered, flags) = reorder_by_bubbles(&bubbles, &quads, 20.0);
                        quads = reordered;
                        flags
                    } else {
                        vec![false; quads.len()]
                    }
                }
                Err(e) => {
                    tracing::warn!("Manga bubble detection failed: {}", e);
                    vec![false; quads.len()]
                }
            }
        } else {
            vec![false; quads.len()]
        };

        // 4. Process each polygon: perspective crop, angle classify, and recognize
        let mut results = Vec::new();
        for (idx, poly) in quads.iter().enumerate() {
            let mut cropped_line = match get_rotate_crop_image(image, poly) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Angle classification: rotate 180Â° if classifier detects upside-down text
            if let Some(ref cls) = self.cls_session {
                if let Ok(cls_tensor) = preprocess_cls(&cropped_line) {
                    let cls_res = cls.with_session(|cls_sess| {
                        let cls_outputs = cls_sess.run(inputs![TensorRef::from_array_view(&cls_tensor)?])?;
                        let cls_out = cls_outputs.get("fetch_name_0")
                            .or_else(|| cls_outputs.get("output_0"))
                            .or_else(|| cls_outputs.get("output"))
                            .context("Failed to get cls output")?;
                        let (cls_shape, cls_data) = cls_out.try_extract_tensor::<f32>()?;
                        Ok((cls_shape.to_owned(), cls_data.to_vec()))
                    });
                    if let Ok((cls_shape, cls_data)) = cls_res {
                        let num_classes = cls_shape[cls_shape.len() - 1] as usize;
                        if num_classes >= 2 {
                            let score_0 = cls_data[0];
                            let score_180 = cls_data[1];
                            if score_180 > score_0 && score_180 > 0.9 {
                                cropped_line = image::imageops::rotate180(&cropped_line);
                            }
                        }
                    }
                }
            }

            let rec_tensor = match preprocess_rec(&cropped_line) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let rec_res = self.rec_session.with_session(|rec_sess| {
                let rec_outputs = rec_sess.run(inputs![TensorRef::from_array_view(&rec_tensor)?])?;
                let rec_tensor_out = rec_outputs
                    .get("fetch_name_0")
                    .or_else(|| rec_outputs.get("output_0"))
                    .or_else(|| rec_outputs.get("output"))
                    .context("Failed to get rec output")?;
                let (rec_shape, rec_data) = rec_tensor_out.try_extract_tensor::<f32>()?;
                Ok((rec_shape.to_owned(), rec_data.to_vec()))
            });
            let (rec_shape, rec_data) = match rec_res {
                Ok(res) => res,
                Err(_) => continue,
            };

            let seq_len  = rec_shape[1] as usize;
            let num_classes = rec_shape[2] as usize;
            let (text, confidence) = decode_ctc(&rec_data, seq_len, num_classes, &self.rec_chars);
            if confidence > 0.5 && !text.trim().is_empty() {
                results.push(OcrDetection {
                    text,
                    confidence,
                    polygon: *poly,
                    is_from_bubble: bubble_flags.get(idx).copied().unwrap_or(false),
                });
            }
        }

        Ok((results, detected_bubbles))
    }
}

impl curator_proto::pipeline::SystemNode for OcrDetector {
    fn info(&self) -> curator_proto::pipeline::NodeInfo {
        curator_proto::pipeline::NodeInfo {
            id: "pp-ocr",
            label: "PP-OCR Text Detector",
            inputs: vec![
                curator_proto::pipeline::Port { name: "image", type_name: "Image" },
            ],
            outputs: vec![
                curator_proto::pipeline::Port { name: "text", type_name: "TextMetadata" },
            ],
        }
    }

    fn device(&self) -> DevicePreference {
        self.det_session.device()
    }

    fn set_device(&self, device: DevicePreference) {
        OcrDetector::set_device(self, device);
    }

    fn unload_all(&self) {
        OcrDetector::unload(self);
    }

    fn is_loaded(&self) -> bool {
        OcrDetector::is_loaded(self)
    }
}

/// Preprocess image for the DB text detection model.
/// 
/// Reference: DetResizeForTest with limit_side_len=960, limit_type="max"
/// then NormalizeImage(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225], scale=1/255)
/// applied to BGR order, then ToCHWImage.
///
/// The image is read as RGB (from our pipeline), so we swap B and R channels to get BGR
/// before applying the reference normalization.
pub fn preprocess_det(image: &RgbImage) -> Result<(Array4<f32>, usize, usize)> {
    let (ow, oh) = image.dimensions();
    let orig_w = ow as usize;
    let orig_h = oh as usize;

    // Compute resize dimensions: scale so max side <= 960, multiple of 32
    // limit_type="max": only downscale if max side > limit
    let limit = 960usize;
    let ratio = if orig_h.max(orig_w) > limit {
        if orig_h > orig_w {
            limit as f32 / orig_h as f32
        } else {
            limit as f32 / orig_w as f32
        }
    } else {
        1.0f32
    };

    let resize_h_raw = (orig_h as f32 * ratio) as usize;
    let resize_w_raw = (orig_w as f32 * ratio) as usize;

    // Round to nearest multiple of 32 (min 32)
    let resize_h = ((resize_h_raw as f32 / 32.0).round() as usize * 32).max(32);
    let resize_w = ((resize_w_raw as f32 / 32.0).round() as usize * 32).max(32);

    let mut resizer = fast_image_resize::Resizer::new();
    let data = resize_rgb_bilinear(image, resize_w as u32, resize_h as u32, &mut resizer)?;

    // NormalizeImage on BGR: (bgr_val/255.0 - mean) / std
    // The YAML mean=[0.485,0.456,0.406] is applied to BGR channels in order:
    // BGR index 0=B gets mean[0]=0.485, index 1=G gets mean[1]=0.456, index 2=R gets mean[2]=0.406
    // Since our input is RGB: RGB[r]=BGR[2], RGB[g]=BGR[1], RGB[b]=BGR[0]
    // CHW output: channel 0=B(idx 2 in RGB), channel 1=G(idx 1), channel 2=R(idx 0)
    let mean_bgr = [0.485f32, 0.456, 0.406]; // applied to B, G, R channels in BGR order
    let std_bgr  = [0.229f32, 0.224, 0.225];

    let mut tensor = Array4::<f32>::zeros((1, 3, resize_h, resize_w));
    let slice = tensor.as_slice_mut().context("Tensor slice mapping failed")?;

    let px_stride = resize_h * resize_w;
    for y in 0..resize_h {
        for x in 0..resize_w {
            let src_base = (y * resize_w + x) * 3; // RGB layout: [R,G,B]
            let r = data[src_base]     as f32 / 255.0;
            let g = data[src_base + 1] as f32 / 255.0;
            let b = data[src_base + 2] as f32 / 255.0;

            // CHW channel 0 = B (BGR index 0), channel 1 = G, channel 2 = R
            let pix_idx = y * resize_w + x;
            slice[pix_idx] = (b - mean_bgr[0]) / std_bgr[0]; // B channel
            slice[px_stride + pix_idx] = (g - mean_bgr[1]) / std_bgr[1]; // G channel
            slice[2 * px_stride + pix_idx] = (r - mean_bgr[2]) / std_bgr[2]; // R channel
        }
    }

    Ok((tensor, resize_w, resize_h))
}

/// Preprocess a cropped text line image for the CTC recognition model.
///
/// Reference: resize_norm_img in predict_rec.py â€” dynamic width expansion via max_wh_ratio.
/// PaddleOCR computes `imgW = int(imgH * max_wh_ratio)` per batch with no hard cap.
/// The ONNX model supports dynamic width up to ~3200 (from TRT shapes).
pub fn preprocess_rec(image: &RgbImage) -> Result<Array4<f32>> {
    let target_h = 48usize;

    let (ow, oh) = image.dimensions();
    let ratio = ow as f32 / oh as f32;
    // Dynamic width: imgW = int(imgH * wh_ratio), matching PaddleOCR inference path.
    // No hard upper cap â€” the model accepts dynamic width up to ~3200.
    let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32);

    let mut resizer = fast_image_resize::Resizer::new();
    let data = resize_rgb_bilinear(image, target_w as u32, target_h as u32, &mut resizer)?;

    let mut tensor = Array4::<f32>::zeros((1, 3, target_h, target_w));
    let slice = tensor.as_slice_mut().context("Tensor slice mapping failed")?;

    let px_stride = target_h * target_w;

    // Fill the resized content; remaining pixels in width stay 0.0 (padding)
    // Note: The reference uses BGR image but normalize formula (val/255 - 0.5)/0.5
    // is channel-agnostic, so we don't need channel swap here.
    for y in 0..target_h {
        for x in 0..target_w {
            let src_base = (y * target_w + x) * 3;
            let r = data[src_base]     as f32 / 255.0;
            let g = data[src_base + 1] as f32 / 255.0;
            let b = data[src_base + 2] as f32 / 255.0;

            let pix_idx = y * target_w + x;
            // CHW: channel 0=B(BGR order), channel 1=G, channel 2=R
            slice[pix_idx] = (b - 0.5) / 0.5;
            slice[px_stride + pix_idx] = (g - 0.5) / 0.5;
            slice[2 * px_stride + pix_idx] = (r - 0.5) / 0.5;
        }
    }

    Ok(tensor)
}

/// Preprocess a cropped text line for the angle classifier model.
/// Reference: inference.yml for PP-LCNet_x1_0_textline_ori_onnx
/// - ResizeImage: [160, 80] (width, height)
/// - NormalizeImage: BGR order, mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225], scale=1/255
/// - ToCHWImage
pub fn preprocess_cls(image: &RgbImage) -> Result<Array4<f32>> {
    let target_h = 80usize;
    let target_w = 160usize;

    let (ow, oh) = image.dimensions();
    let ratio = ow as f32 / oh as f32;
    let resized_w = ((target_h as f32 * ratio).ceil() as usize).min(target_w);

    let mut resizer = fast_image_resize::Resizer::new();
    let data = resize_rgb_bilinear(image, resized_w as u32, target_h as u32, &mut resizer)?;

    let mut tensor = Array4::<f32>::zeros((1, 3, target_h, target_w));
    let slice = tensor.as_slice_mut().context("Tensor slice mapping failed")?;

    let px_stride = target_h * target_w;
    for y in 0..target_h {
        for x in 0..resized_w {
            let src_base = (y * resized_w + x) * 3;
            let r = data[src_base]     as f32 / 255.0;
            let g = data[src_base + 1] as f32 / 255.0;
            let b = data[src_base + 2] as f32 / 255.0;

            let pix_idx = y * target_w + x;
            // BGR order: channel 0=B, 1=G, 2=R
            slice[pix_idx] = (b - 0.485) / 0.229;
            slice[px_stride + pix_idx] = (g - 0.456) / 0.224;
            slice[2 * px_stride + pix_idx] = (r - 0.406) / 0.225;
        }
    }

    Ok(tensor)
}

/// Extract axis-aligned bounding boxes from a DB probability map.
///
/// Faithful port of DBPostProcess.boxes_from_bitmap with score_mode="fast".
///
/// Steps:
/// 1. Threshold map at `thresh` to get binary bitmap
/// 2. Find connected components via BFS (equivalent to cv2.findContours)
/// 3. For each component, compute min-area bounding box
/// 4. Score the box against the float probability map
/// 5. Apply unclip expansion
/// 6. Scale coordinates back to original image dimensions
#[derive(Debug, Clone, Copy)]
pub struct DbPostProcessParams {
    pub thresh: f32,
    pub box_thresh: f32,
    pub unclip_ratio: f32,
}

impl Default for DbPostProcessParams {
    fn default() -> Self {
        Self {
            thresh: 0.3,
            box_thresh: 0.6,
            unclip_ratio: 1.5,
        }
    }
}

fn extract_boxes_from_map(
    pred: &[f32],
    (map_w, map_h): (usize, usize),
    (orig_w, orig_h): (usize, usize),
    params: DbPostProcessParams,
) -> Result<Vec<[[i32; 2]; 4]>> {
    let thresh = params.thresh;
    let box_thresh = params.box_thresh;
    let unclip_ratio = params.unclip_ratio;

    // 1. Threshold to binary
    let mut binary = vec![false; map_w * map_h];
    for i in 0..(map_w * map_h) {
        binary[i] = pred[i] > thresh;
    }

    // 2. Find connected components via BFS
    let mut visited = vec![false; map_w * map_h];
    let mut boxes = Vec::new();

    let max_candidates = 3000usize;
    let min_size = 3i32;

    for sy in 0..map_h {
        for sx in 0..map_w {
            let idx = sy * map_w + sx;
            if !binary[idx] || visited[idx] {
                continue;
            }
            if boxes.len() >= max_candidates {
                break;
            }

            // BFS to collect component pixels and accumulate probability sum
            let mut queue = std::collections::VecDeque::new();
            queue.push_back((sx, sy));
            visited[idx] = true;

            let mut min_x = sx;
            let mut max_x = sx;
            let mut min_y = sy;
            let mut max_y = sy;
            let mut prob_sum = 0.0f32;
            let mut pixel_count = 0usize;

            while let Some((cx, cy)) = queue.pop_front() {
                prob_sum += pred[cy * map_w + cx];
                pixel_count += 1;
                if cx < min_x { min_x = cx; }
                if cx > max_x { max_x = cx; }
                if cy < min_y { min_y = cy; }
                if cy > max_y { max_y = cy; }

                for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1i32), (0, 1)] {
                    let nx = cx as i32 + dx;
                    let ny = cy as i32 + dy;
                    if nx >= 0 && nx < map_w as i32 && ny >= 0 && ny < map_h as i32 {
                        let nidx = ny as usize * map_w + nx as usize;
                        if binary[nidx] && !visited[nidx] {
                            visited[nidx] = true;
                            queue.push_back((nx as usize, ny as usize));
                        }
                    }
                }
            }

            if pixel_count == 0 {
                continue;
            }

            // Get axis-aligned bounding box of component
            let min_x = min_x as i32;
            let max_x = max_x as i32;
            let min_y = min_y as i32;
            let max_y = max_y as i32;
            let box_w = max_x - min_x;
            let box_h = max_y - min_y;

            // Discard tiny boxes (equivalent to min_size check in reference)
            if box_w < min_size || box_h < min_size {
                continue;
            }

            // Score: mean probability of actual component pixels
            let score = prob_sum / pixel_count as f32;
            if score < box_thresh {
                continue;
            }

            // Unclip: expand box by unclip_ratio (reference: area * ratio / perimeter)
            let bw = box_w as f32;
            let bh = box_h as f32;
            let area = bw * bh;
            let perimeter = 2.0 * (bw + bh);
            let expand = area * unclip_ratio / perimeter;

            let ex0 = (min_x as f32 - expand).round().max(0.0) as i32;
            let ey0 = (min_y as f32 - expand).round().max(0.0) as i32;
            let ex1 = (max_x as f32 + expand).round().min(map_w as f32 - 1.0) as i32;
            let ey1 = (max_y as f32 + expand).round().min(map_h as f32 - 1.0) as i32;

            let exp_w = ex1 - ex0;
            let exp_h = ey1 - ey0;
            if exp_w < min_size + 2 || exp_h < min_size + 2 {
                continue;
            }

            // Scale back to original image coordinates
            let scale_x = orig_w as f32 / map_w as f32;
            let scale_y = orig_h as f32 / map_h as f32;

            let ox0 = ((ex0 as f32 * scale_x).round() as i32).clamp(0, orig_w as i32);
            let oy0 = ((ey0 as f32 * scale_y).round() as i32).clamp(0, orig_h as i32);
            let ox1 = ((ex1 as f32 * scale_x).round() as i32).clamp(0, orig_w as i32);
            let oy1 = ((ey1 as f32 * scale_y).round() as i32).clamp(0, orig_h as i32);

            boxes.push([
                [ox0, oy0],
                [ox1, oy0],
                [ox1, oy1],
                [ox0, oy1],
            ]);
        }
    }

    Ok(boxes)
}

/// Sort text boxes top-to-bottom, left-to-right.
/// Reference: sorted_boxes() in PaddleOCR predict_system.py
/// Primary sort by top-left Y, secondary by top-left X.
/// Boxes within 10px vertically are considered same-line and sorted left-to-right.
fn sorted_boxes(mut boxes: Vec<[[i32; 2]; 4]>) -> Vec<[[i32; 2]; 4]> {
    // Primary sort: top-left Y, then top-left X
    boxes.sort_by(|a, b| {
        a[0][1].cmp(&b[0][1])
            .then(a[0][0].cmp(&b[0][0]))
    });

    // Bubble-sort pass: if two adjacent boxes are within 10px vertically
    // but the later one has smaller X, swap them (left-to-right within same line)
    let n = boxes.len();
    for i in 0..n {
        let mut j = i;
        while j + 1 < n {
            let y_diff = (boxes[j + 1][0][1] - boxes[j][0][1]).abs();
            if y_diff < 10 && boxes[j + 1][0][0] < boxes[j][0][0] {
                boxes.swap(j, j + 1);
                j += 1;
            } else {
                break;
            }
        }
    }

    boxes
}

/// Merge fragmented text boxes that are close together.
/// Reference: merge_fragmented() in PaddleOCR utility.py
/// Merges boxes within x_threshold (10px) and y_threshold (10px).
fn merge_fragmented(boxes: Vec<[[i32; 2]; 4]>) -> Vec<[[i32; 2]; 4]> {
    if boxes.len() <= 1 {
        return boxes;
    }

    let x_threshold = 10i32;
    let y_threshold = 10i32;

    fn box_extents(box_pts: &[[i32; 2]]) -> (i32, i32, i32, i32) {
        if box_pts.is_empty() {
            return (0, 0, 0, 0);
        }
        let mut min_x = box_pts[0][0];
        let mut max_x = box_pts[0][0];
        let mut min_y = box_pts[0][1];
        let mut max_y = box_pts[0][1];
        for pt in &box_pts[1..] {
            min_x = min_x.min(pt[0]);
            max_x = max_x.max(pt[0]);
            min_y = min_y.min(pt[1]);
            max_y = max_y.max(pt[1]);
        }
        (min_x, max_x, min_y, max_y)
    }

    let mut merged: Vec<[[i32; 2]; 4]> = boxes;
    let mut changed = true;

    while changed {
        changed = false;
        let mut visited = vec![false; merged.len()];
        let mut new_merged = Vec::with_capacity(merged.len());

        for i in 0..merged.len() {
            if visited[i] { continue; }
            let mut current = merged[i];
            visited[i] = true;

            for j in (i + 1)..merged.len() {
                if visited[j] { continue; }
                let (min_x1, max_x1, min_y1, max_y1) = box_extents(&current);
                let (min_x2, max_x2, min_y2, max_y2) = box_extents(&merged[j]);

                if (min_y1 - min_y2).abs() <= y_threshold
                    && (max_y1 - max_y2).abs() <= y_threshold
                    && (max_x1 - min_x2).abs() <= x_threshold
                {
                    // Merge: take bounding box of both
                    let nx_min = min_x1.min(min_x2);
                    let nx_max = max_x1.max(max_x2);
                    let ny_min = min_y1.min(min_y2);
                    let ny_max = max_y1.max(max_y2);
                    current = [
                        [nx_min, ny_min], [nx_max, ny_min],
                        [nx_max, ny_max], [nx_min, ny_max],
                    ];
                    visited[j] = true;
                    changed = true;
                }
            }
            new_merged.push(current);
        }
        merged = new_merged;
    }

    merged
}


/// Perspective warp to crop and flatten a rotated text line box.
/// Reference: get_rotate_crop_image from PaddleOCR utils.
fn get_rotate_crop_image(img: &RgbImage, points: &[[i32; 2]; 4]) -> Result<RgbImage> {
    let p0 = [points[0][0] as f32, points[0][1] as f32];
    let p1 = [points[1][0] as f32, points[1][1] as f32];
    let p2 = [points[2][0] as f32, points[2][1] as f32];
    let p3 = [points[3][0] as f32, points[3][1] as f32];

    let w = (dist(p0, p1).max(dist(p2, p3))).round() as u32;
    let h = (dist(p0, p3).max(dist(p1, p2))).round() as u32;

    if w == 0 || h == 0 {
        anyhow::bail!("Invalid crop dimensions");
    }

    let src = [p0, p1, p2, p3];
    let dst = [
        [0.0f32, 0.0],
        [w as f32, 0.0],
        [w as f32, h as f32],
        [0.0, h as f32],
    ];

    let h_mat = get_perspective_transform(dst, src)?;  // compute H(dstâ†’src) for inverse warp

    let mut dest_buf: RgbImage = ImageBuffer::new(w, h);
    let (ow, oh) = img.dimensions();

    for py in 0..h {
        for px in 0..w {
            let pfx = px as f32;
            let pfy = py as f32;
            let den = h_mat[6] * pfx + h_mat[7] * pfy + h_mat[8];
            if den.abs() > 1e-5 {
                let sx = (h_mat[0] * pfx + h_mat[1] * pfy + h_mat[2]) / den;
                let sy = (h_mat[3] * pfx + h_mat[4] * pfy + h_mat[5]) / den;

                if sx >= 0.0 && sx < (ow - 1) as f32 && sy >= 0.0 && sy < (oh - 1) as f32 {
                    let x_floor = sx.floor() as u32;
                    let y_floor = sy.floor() as u32;
                    let x_ceil = x_floor + 1;
                    let y_ceil = y_floor + 1;

                    let tx = sx - x_floor as f32;
                    let ty = sy - y_floor as f32;

                    let p00 = img.get_pixel(x_floor, y_floor);
                    let p10 = img.get_pixel(x_ceil, y_floor);
                    let p01 = img.get_pixel(x_floor, y_ceil);
                    let p11 = img.get_pixel(x_ceil, y_ceil);

                    let mut rgb = [0u8; 3];
                    for c in 0..3 {
                        let val = (1.0 - tx) * (1.0 - ty) * p00[c] as f32
                            + tx * (1.0 - ty) * p10[c] as f32
                            + (1.0 - tx) * ty * p01[c] as f32
                            + tx * ty * p11[c] as f32;
                        rgb[c] = val.round().clamp(0.0, 255.0) as u8;
                    }
                    dest_buf.put_pixel(px, py, Rgb(rgb));
                } else {
                    dest_buf.put_pixel(px, py, Rgb([127, 127, 127]));
                }
            }
        }
    }

    // If the crop is taller than it is wide, rotate 90Â° (portrait â†’ landscape)
    if h as f32 / w as f32 >= 1.5 {
        dest_buf = image::imageops::rotate90(&dest_buf);
    }

    Ok(dest_buf)
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Compute the 3Ã—3 homography matrix mapping src to dst using Gaussian elimination.
fn get_perspective_transform(src: [[f32; 2]; 4], dst: [[f32; 2]; 4]) -> Result<[f32; 9]> {
    let mut a = [[0.0f32; 8]; 8];
    let mut b = [0.0f32; 8];

    for i in 0..4 {
        let sx = src[i][0];
        let sy = src[i][1];
        let dx = dst[i][0];
        let dy = dst[i][1];

        a[i * 2][0] = sx;
        a[i * 2][1] = sy;
        a[i * 2][2] = 1.0;
        a[i * 2][6] = -sx * dx;
        a[i * 2][7] = -sy * dx;
        b[i * 2] = dx;

        a[i * 2 + 1][3] = sx;
        a[i * 2 + 1][4] = sy;
        a[i * 2 + 1][5] = 1.0;
        a[i * 2 + 1][6] = -sx * dy;
        a[i * 2 + 1][7] = -sy * dy;
        b[i * 2 + 1] = dy;
    }

    let h = solve_linear_system(a, b)?;
    Ok([
        h[0], h[1], h[2],
        h[3], h[4], h[5],
        h[6], h[7], 1.0,
    ])
}

fn solve_linear_system(mut a: [[f32; 8]; 8], mut b: [f32; 8]) -> Result<[f32; 8]> {
    let n = 8;
    for i in 0..n {
        let mut max_row = i;
        for j in (i + 1)..n {
            if a[j][i].abs() > a[max_row][i].abs() {
                max_row = j;
            }
        }

        if a[max_row][i].abs() < 1e-7 {
            anyhow::bail!("Singular matrix in homography calculation");
        }

        a.swap(i, max_row);
        b.swap(i, max_row);

        for j in (i + 1)..n {
            let factor = a[j][i] / a[i][i];
            b[j] -= factor * b[i];
            let (row_i, row_j) = if i < j {
                let (left, right) = a.split_at_mut(j);
                (&left[i], &mut right[0])
            } else {
                let (left, right) = a.split_at_mut(i);
                (&right[0], &mut left[j])
            };
            for (aj_val, &ai_val) in row_j[i..n].iter_mut().zip(&row_i[i..n]) {
                *aj_val -= factor * ai_val;
            }
        }
    }

    let mut x = [0.0f32; 8];
    for i in (0..n).rev() {
        let mut sum = 0.0;
        for j in (i + 1)..n {
            sum += a[i][j] * x[j];
        }
        x[i] = (b[i] - sum) / a[i][i];
    }

    Ok(x)
}

/// Greedy CTC decode: argmax per timestep, remove duplicates, skip blank (index 0).
/// Reference: CTCLabelDecode in rec_postprocess.py
/// Greedy CTC decode matching PaddleOCR CTCLabelDecode exactly:
///   preds_idx = preds.argmax(axis=2)
///   preds_prob = preds.max(axis=2)
/// Then decode: skip blank (0), remove consecutive duplicates, accumulate raw probs.
fn decode_ctc(data: &[f32], seq_len: usize, num_classes: usize, dict: &[String]) -> (String, f32) {
    let mut prev_idx = usize::MAX;
    let mut text = String::new();
    let mut total_prob = 0.0f32;
    let mut count = 0usize;

    for t in 0..seq_len {
        let offset = t * num_classes;
        let mut max_idx = 0usize;
        let mut max_val = data[offset];
        for c in 1..num_classes {
            let v = data[offset + c];
            if v > max_val {
                max_val = v;
                max_idx = c;
            }
        }

        // Reference: preds_prob = preds.max(axis=2) â€” raw max value is the confidence
        let prob = max_val;

        // Skip blank (0) and duplicates — reference: is_remove_duplicate=True, ignored_tokens=[0]
        if max_idx != 0 && max_idx != prev_idx && max_idx < dict.len() && dict[max_idx] != "blank" {
            text.push_str(&dict[max_idx]);
            total_prob += prob;
            count += 1;
        }
        prev_idx = max_idx;
    }

    let confidence = if count > 0 { total_prob / count as f32 } else { 0.0 };
    (text, confidence)
}
