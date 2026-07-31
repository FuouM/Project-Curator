use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use anyhow::{Context, Result};
use ndarray::Array4;
use ort::{inputs, session::Session, value::TensorRef};
use image::{ImageBuffer, RgbImage, Rgb};

use crate::ipc::DevicePreference;
use crate::vector::apply_device_preference;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone)]
pub struct OcrDetection {
    pub text: String,
    pub confidence: f32,
    pub polygon: [[i32; 2]; 4],
}

pub struct OcrDetector {
    det_model_path: PathBuf,
    rec_model_path: PathBuf,
    cls_model_path: Option<PathBuf>,
    device: Mutex<DevicePreference>,
    pub det_session: Mutex<Option<Session>>,
    pub rec_session: Mutex<Option<Session>>,
    pub cls_session: Mutex<Option<Session>>,
    pub rec_chars: Vec<String>,
    last_used: AtomicU64,
}

impl OcrDetector {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let det_model = dir.join("PP-OCRv6_medium_det_onnx").join("inference.onnx");
        let (rec_model, rec_dict) = {
            let model = dir.join("PP-OCRv6_medium_rec_onnx").join("inference.onnx");
            let dict  = dir.join("PP-OCRv6_medium_rec_onnx").join("inference.yml");
            (model, dict)
        };
        // Optional angle classifier (PP-LCNet textline_ori) — rotates 180° if detected
        let cls_model = dir.join("PP-LCNet_x1_0_textline_ori_onnx").join("inference.onnx");
        let cls_model = if cls_model.exists() { Some(cls_model) } else { None };

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
        // Format: block YAML sequence under `character_dict:`, entries as `  - char` or `  - 'char'`.
        // Index 0 is "blank" for CTC decoding (prepended by CTCLabelDecode.add_special_char).
        // PP-OCRv6 uses use_space_char=True, which appends " " as the final class (index 18709).
        let mut rec_chars = vec!["blank".to_string()];
        if rec_dict.exists() {
            if let Ok(content) = std::fs::read_to_string(&rec_dict) {
                let mut in_char_dict = false;
                for line in content.lines() {
                    let trimmed = line.trim_end_matches('\r');
                    let trimmed_stripped = trimmed.trim();

                    // Blank lines: skip but stay in dict section
                    if trimmed_stripped.is_empty() {
                        continue;
                    }

                    // Detect start of character_dict section
                    if trimmed_stripped == "character_dict:" {
                        in_char_dict = true;
                        continue;
                    }

                    if in_char_dict {
                        if let Some(rest) = trimmed_stripped.strip_prefix("- ") {
                            // Strip surrounding single or double quotes, then unescape
                            let ch = if rest.starts_with('\'') && rest.ends_with('\'') {
                                // YAML single-quoted scalar: '' inside means literal '
                                let inner = &rest[1..rest.len()-1];
                                inner.replace("''", "'")
                            } else if rest.starts_with('"') && rest.ends_with('"') {
                                rest[1..rest.len()-1].to_string()
                            } else {
                                rest.to_string()
                            };
                            rec_chars.push(ch);
                        } else if trimmed_stripped == "-" {
                            // Bare dash = empty string character
                            rec_chars.push(String::new());
                        } else {
                            // Non-list, non-blank line: end of section
                            in_char_dict = false;
                        }
                    }
                }
            }
        }
        // PP-OCRv6 rec model uses use_space_char=True: space is appended as the last class.
        // The YAML character_dict has 18708 entries; blank(1) + chars(18708) + space(1) = 18710
        // which matches num_classes=18710 in the ONNX model output.
        rec_chars.push(" ".to_string());

        Self {
            det_model_path: det_model,
            rec_model_path: rec_model,
            cls_model_path: cls_model,
            device: Mutex::new(device),
            det_session: Mutex::new(None),
            rec_session: Mutex::new(None),
            cls_session: Mutex::new(None),
            rec_chars,
            last_used: AtomicU64::new(now_secs()),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.det_session.lock().unwrap().is_some() && self.rec_session.lock().unwrap().is_some()
    }

    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    pub fn unload(&self) {
        let mut det = self.det_session.lock().unwrap();
        let mut rec = self.rec_session.lock().unwrap();
        let mut cls = self.cls_session.lock().unwrap();
        if det.is_some() || rec.is_some() || cls.is_some() {
            tracing::info!("OCR: unloading models");
            *det = None;
            *rec = None;
            *cls = None;
        }
    }

    pub fn set_device(&self, device: DevicePreference) {
        {
            let mut d = self.device.lock().unwrap();
            *d = device.clone();
        }
        self.unload();
    }

    fn load(&self) -> Result<()> {
        let mut det_guard = self.det_session.lock().unwrap();
        let mut rec_guard = self.rec_session.lock().unwrap();
        let mut cls_guard = self.cls_session.lock().unwrap();
        if det_guard.is_some() && rec_guard.is_some() {
            return Ok(());
        }

        if !self.det_model_path.exists() {
            anyhow::bail!("OCR Det model not found at {:?}", self.det_model_path);
        }
        if !self.rec_model_path.exists() {
            anyhow::bail!("OCR Rec model not found at {:?}", self.rec_model_path);
        }

        let device = self.device.lock().unwrap().clone();
        tracing::info!("Loading OCR detection model (device: {:?})", device);

        let mut det_builder = Session::builder()?.with_intra_threads(1)?;
        apply_device_preference(&mut det_builder, &device, "OCR Det");
        let det_sess = det_builder.commit_from_file(&self.det_model_path)?;

        tracing::info!("Loading OCR recognition model (device: {:?})", device);
        let mut rec_builder = Session::builder()?.with_intra_threads(1)?;
        apply_device_preference(&mut rec_builder, &device, "OCR Rec");
        let rec_sess = rec_builder.commit_from_file(&self.rec_model_path)?;

        *det_guard = Some(det_sess);
        *rec_guard = Some(rec_sess);

        // Load angle classifier if model file exists
        if let Some(ref cls_path) = self.cls_model_path {
            if cls_path.exists() && cls_guard.is_none() {
                tracing::info!("Loading OCR angle classifier (device: {:?})", device);
                let mut cls_builder = Session::builder()?.with_intra_threads(1)?;
                apply_device_preference(&mut cls_builder, &device, "OCR Cls");
                if let Ok(cls_sess) = cls_builder.commit_from_file(cls_path) {
                    *cls_guard = Some(cls_sess);
                }
            }
        }

        Ok(())
    }

    pub fn run_ocr(&self, image: &RgbImage) -> Result<Vec<OcrDetection>> {
        self.load()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);

        let mut det_guard = self.det_session.lock().unwrap();
        let mut rec_guard = self.rec_session.lock().unwrap();
        let mut cls_guard = self.cls_session.lock().unwrap();
        let det_session = det_guard.as_mut().unwrap();
        let rec_session = rec_guard.as_mut().unwrap();
        let cls_opt: &mut Option<Session> = &mut *cls_guard;

        let (ow, oh) = image.dimensions();
        let orig_w = ow as usize;
        let orig_h = oh as usize;

    // 1. Preprocess for detection: resize keeping aspect ratio, round to multiple of 32
    //    Reference: DetResizeForTest with limit_side_len=960, limit_type="max"
    let (det_tensor, _resize_w, _resize_h) = preprocess_det(image)?;

        // 2. Run detection model
        let outputs = det_session.run(inputs![TensorRef::from_array_view(&det_tensor)?])?;
        let output_tensor = outputs.get("fetch_name_0")
            .or_else(|| outputs.get("maps"))
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get detection maps output from OCR model")?;
        let (shape, pred_data) = output_tensor.try_extract_tensor::<f32>()?;

        // Shape is [1, 1, H, W] — pred_data is the raw sigmoid probability map
        let map_h = shape[2] as usize;
        let map_w = shape[3] as usize;

        // 3. Extract bounding box polygons from the probability map
        //    Matches: DBPostProcess(thresh=0.2, box_thresh=0.45, unclip_ratio=1.4)
        //    boxes_from_bitmap with scale back to original image coordinates
        let quads = extract_boxes_from_map(
            pred_data,
            map_w, map_h,
            0.3,   // det_db_thresh (reference default)
            0.6,   // det_db_box_thresh (reference default)
            1.5,   // det_db_unclip_ratio (reference default)
            orig_w, orig_h,
        )?;

        // Sort boxes top-to-bottom, left-to-right, then merge fragmented boxes
        let quads = sorted_boxes(quads);
        let quads = merge_fragmented(quads);

        // 4. Process each polygon: perspective crop, angle classify, and recognize
        let mut results = Vec::new();
        for poly in &quads {
            let mut cropped_line = match get_rotate_crop_image(image, poly) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Angle classification: rotate 180° if classifier detects upside-down text
            if let Some(cls_sess) = cls_opt {
                if let Ok(cls_tensor) = preprocess_cls(&cropped_line) {
                    if let Ok(cls_outputs) = cls_sess.run(inputs![TensorRef::from_array_view(&cls_tensor)?]) {
                        if let Some(cls_out) = cls_outputs.get("fetch_name_0")
                            .or_else(|| cls_outputs.get("output_0"))
                            .or_else(|| cls_outputs.get("output"))
                        {
                            if let Ok((cls_shape, cls_data)) = cls_out.try_extract_tensor::<f32>() {
                                // Binary classifier: [0°, 180°] — index 1 = 180°
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
                }
            }

            let rec_tensor = match preprocess_rec(&cropped_line) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let rec_outputs = match rec_session.run(inputs![TensorRef::from_array_view(&rec_tensor)?]) {
                Ok(o) => o,
                Err(_) => continue,
            };
            let rec_tensor_out = rec_outputs
                .get("fetch_name_0")
                .or_else(|| rec_outputs.get("output_0"))
                .or_else(|| rec_outputs.get("output"));
            if let Some(rec_tensor_out) = rec_tensor_out {
                if let Ok((rec_shape, rec_data)) = rec_tensor_out.try_extract_tensor::<f32>() {
                    let seq_len  = rec_shape[1] as usize;
                    let num_classes = rec_shape[2] as usize;
                    let (text, confidence) = decode_ctc(rec_data, seq_len, num_classes, &self.rec_chars);
                    if confidence > 0.5 && !text.trim().is_empty() {
                        results.push(OcrDetection {
                            text,
                            confidence,
                            polygon: *poly,
                        });
                    }
                }
            }
        }

        Ok(results)
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

    let resized = image::imageops::resize(image, resize_w as u32, resize_h as u32, image::imageops::FilterType::Triangle);
    let data = resized.as_raw();

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
            slice[0 * px_stride + pix_idx] = (b - mean_bgr[0]) / std_bgr[0]; // B channel
            slice[1 * px_stride + pix_idx] = (g - mean_bgr[1]) / std_bgr[1]; // G channel
            slice[2 * px_stride + pix_idx] = (r - mean_bgr[2]) / std_bgr[2]; // R channel
        }
    }

    Ok((tensor, resize_w, resize_h))
}

/// Preprocess a cropped text line image for the CTC recognition model.
///
/// Reference: resize_norm_img in predict_rec.py — dynamic width expansion via max_wh_ratio.
/// PaddleOCR computes `imgW = int(imgH * max_wh_ratio)` per batch with no hard cap.
/// The ONNX model supports dynamic width up to ~3200 (from TRT shapes).
pub fn preprocess_rec(image: &RgbImage) -> Result<Array4<f32>> {
    let target_h = 48usize;

    let (ow, oh) = image.dimensions();
    let ratio = ow as f32 / oh as f32;
    // Dynamic width: imgW = int(imgH * wh_ratio), matching PaddleOCR inference path.
    // No hard upper cap — the model accepts dynamic width up to ~3200.
    let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32);

    let resized = image::imageops::resize(image, target_w as u32, target_h as u32, image::imageops::FilterType::Triangle);
    let data = resized.as_raw();

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
            slice[0 * px_stride + pix_idx] = (b - 0.5) / 0.5;
            slice[1 * px_stride + pix_idx] = (g - 0.5) / 0.5;
            slice[2 * px_stride + pix_idx] = (r - 0.5) / 0.5;
        }
    }

    Ok(tensor)
}

/// Preprocess a cropped text line for the angle classifier model.
/// Reference: resize_norm_img in predict_cls.py — resize to 48x192, normalize to [-1, 1]
pub fn preprocess_cls(image: &RgbImage) -> Result<Array4<f32>> {
    let target_h = 48usize;
    let target_w = 192usize;

    let (ow, oh) = image.dimensions();
    let ratio = ow as f32 / oh as f32;
    let resized_w = ((target_h as f32 * ratio).ceil() as usize).min(target_w);

    let resized = image::imageops::resize(image, resized_w as u32, target_h as u32, image::imageops::FilterType::Triangle);
    let data = resized.as_raw();

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
            slice[0 * px_stride + pix_idx] = (b - 0.5) / 0.5;
            slice[1 * px_stride + pix_idx] = (g - 0.5) / 0.5;
            slice[2 * px_stride + pix_idx] = (r - 0.5) / 0.5;
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
fn extract_boxes_from_map(
    pred: &[f32],
    map_w: usize,
    map_h: usize,
    thresh: f32,
    box_thresh: f32,
    unclip_ratio: f32,
    orig_w: usize,
    orig_h: usize,
) -> Result<Vec<[[i32; 2]; 4]>> {
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

    fn box_extents(box_pts: &[[i32; 2]; 4]) -> (i32, i32, i32, i32) {
        let xs: Vec<i32> = box_pts.iter().map(|p| p[0]).collect();
        let ys: Vec<i32> = box_pts.iter().map(|p| p[1]).collect();
        (*xs.iter().min().unwrap(), *xs.iter().max().unwrap(),
         *ys.iter().min().unwrap(), *ys.iter().max().unwrap())
    }

    let mut merged: Vec<Vec<[i32; 2]>> = boxes.iter().map(|b| b.to_vec()).collect();
    let mut changed = true;

    while changed {
        changed = false;
        let mut visited = vec![false; merged.len()];
        let mut new_merged = Vec::new();

        for i in 0..merged.len() {
            if visited[i] { continue; }
            let mut current = merged[i].clone();
            visited[i] = true;

            for j in (i + 1)..merged.len() {
                if visited[j] { continue; }
                let (min_x1, max_x1, min_y1, max_y1) = box_extents(&current.clone().try_into().unwrap_or([[0; 2]; 4]));
                let (min_x2, max_x2, min_y2, max_y2) = box_extents(&merged[j].clone().try_into().unwrap_or([[0; 2]; 4]));

                if (min_y1 - min_y2).abs() <= y_threshold
                    && (max_y1 - max_y2).abs() <= y_threshold
                    && (max_x1 - min_x2).abs() <= x_threshold
                {
                    // Merge: take bounding box of both
                    let nx_min = min_x1.min(min_x2);
                    let nx_max = max_x1.max(max_x2);
                    let ny_min = min_y1.min(min_y2);
                    let ny_max = max_y1.max(max_y2);
                    current = vec![
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

    merged.into_iter()
        .filter_map(|b| b.try_into().ok())
        .collect()
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

    let h_mat = get_perspective_transform(dst, src)?;  // compute H(dst→src) for inverse warp

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

    // If the crop is taller than it is wide, rotate 90° (portrait → landscape)
    if h as f32 / w as f32 >= 1.5 {
        dest_buf = image::imageops::rotate90(&dest_buf);
    }

    Ok(dest_buf)
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Compute the 3×3 homography matrix mapping src to dst using Gaussian elimination.
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
            for k in i..n {
                a[j][k] -= factor * a[i][k];
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

        // Reference: preds_prob = preds.max(axis=2) — raw max value is the confidence
        let prob = max_val;

        // Skip blank (0) and duplicates — reference: is_remove_duplicate=True, ignored_tokens=[0]
        if max_idx != 0 && max_idx != prev_idx {
            if max_idx < dict.len() && dict[max_idx] != "blank" {
                text.push_str(&dict[max_idx]);
                total_prob += prob;
                count += 1;
            }
        }
        prev_idx = max_idx;
    }

    let confidence = if count > 0 { total_prob / count as f32 } else { 0.0 };
    (text, confidence)
}
