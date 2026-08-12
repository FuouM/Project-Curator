use std::path::Path;

use anyhow::{Context, Result};
use image::RgbImage;
use ndarray::Array4;
use ort::{inputs, value::TensorRef};

use curator_proto::contracts::DevicePreference;
use crate::onnx::ManagedSession;
use crate::preprocess::resize_rgb_bilinear;

// ============================================================================
// Manga Bubble Detector (YOLO26)
// ============================================================================

/// Detected text bubble region from YOLO26 manga bubble detector.
#[derive(Debug, Clone)]
pub struct BubbleDetection {
    /// Bounding box in original image coordinates: [x1, y1, x2, y2]
    pub bbox: [f32; 4],
    pub confidence: f32,
}

/// Lightweight YOLO26-based manga text bubble detector.
/// Input: 1280×1280, float32 [0,1], CHW
/// Output: (1, 300, 6) — [cx, cy, w, h, confidence, class]
/// Single class: Text. No NMS needed (end-to-end head).
pub struct MangaBubbleDetector {
    pub session: ManagedSession,
}

impl MangaBubbleDetector {
    pub fn new(model_dir: impl AsRef<Path>, device: DevicePreference, prefer_quantized: bool) -> Self {
        let dir = model_dir.as_ref().to_path_buf();
        let mut model_path = dir.join("manga-bubble-yolo").join("yolo26n.onnx");
        if prefer_quantized {
            let int8_path = dir.join("manga-bubble-yolo").join("yolo26n_int8.onnx");
            if int8_path.exists() {
                model_path = int8_path;
            }
        }
        tracing::info!("Manga Bubble YOLO: using model path {:?}", model_path);
        Self {
            session: ManagedSession::new("Manga Bubble YOLO", model_path, device, 1),
        }
    }

    pub fn is_available(&self) -> bool {
        self.session.model_path().exists()
    }

    pub fn unload(&self) {
        self.session.unload();
    }

    pub fn detect_bubbles(&self, image: &RgbImage, conf_threshold: f32) -> Result<Vec<BubbleDetection>> {
        let (orig_w, orig_h) = image.dimensions();
        let input_size = 1280usize;
        let pad_value: f32 = 114.0 / 255.0;

        // Letterbox resize (ultralytics standard): scale to fit, pad with gray 114
        let ratio = (input_size as f32 / orig_h as f32).min(input_size as f32 / orig_w as f32);
        let new_w = (orig_w as f32 * ratio).round() as usize;
        let new_h = (orig_h as f32 * ratio).round() as usize;
        let pad_x = ((input_size - new_w) as f32 / 2.0).round() as usize;
        let pad_y = ((input_size - new_h) as f32 / 2.0).round() as usize;

        let mut resizer = fast_image_resize::Resizer::new();
        let data = resize_rgb_bilinear(image, new_w as u32, new_h as u32, &mut resizer)?;

        // Build CHW tensor with letterbox padding
        let mut tensor = Array4::<f32>::zeros((1, 3, input_size, input_size));
        let slice = tensor.as_slice_mut().context("YOLO tensor slice mapping failed")?;
        let px_stride = input_size * input_size;

        // Fill padding with gray (114/255)
        for pix in slice.iter_mut() {
            *pix = pad_value;
        }

        // Copy resized image into padded tensor
        for y in 0..new_h {
            for x in 0..new_w {
                let src_base = (y * new_w + x) * 3;
                let r = data[src_base] as f32 / 255.0;
                let g = data[src_base + 1] as f32 / 255.0;
                let b = data[src_base + 2] as f32 / 255.0;
                let dst_y = y + pad_y;
                let dst_x = x + pad_x;
                let pix_idx = dst_y * input_size + dst_x;
                slice[pix_idx] = r;
                slice[1 * px_stride + pix_idx] = g;
                slice[2 * px_stride + pix_idx] = b;
            }
        }

        // Run inference
        let data_vec = self.session.with_session(|session| {
            let outputs = session.run(inputs![TensorRef::from_array_view(&tensor)?])?;
            let output = outputs.get("output0")
                .or_else(|| outputs.get("output_0"))
                .or_else(|| outputs.get("fetch_name_0"))
                .or_else(|| outputs.get("output"))
                .context("YOLO: output tensor not found (tried output0, output_0, fetch_name_0, output)")?;
            let (_, data) = output.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;

        // Output shape: (1, 300, 6) — [x1, y1, x2, y2, conf, class]
        // Coordinates are in input pixel space (with letterbox padding)
        let num_detections = 300;
        let mut bubbles = Vec::new();
        for i in 0..num_detections {
            let base = i * 6;
            let x1_raw = data_vec[base];
            let y1_raw = data_vec[base + 1];
            let x2_raw = data_vec[base + 2];
            let y2_raw = data_vec[base + 3];
            let conf = data_vec[base + 4];

            if conf < conf_threshold {
                continue;
            }

            // Reverse letterbox: subtract padding, divide by ratio
            let x1 = ((x1_raw - pad_x as f32) / ratio).max(0.0).min(orig_w as f32);
            let y1 = ((y1_raw - pad_y as f32) / ratio).max(0.0).min(orig_h as f32);
            let x2 = ((x2_raw - pad_x as f32) / ratio).max(0.0).min(orig_w as f32);
            let y2 = ((y2_raw - pad_y as f32) / ratio).max(0.0).min(orig_h as f32);

            if x2 > x1 && y2 > y1 {
                bubbles.push(BubbleDetection {
                    bbox: [x1, y1, x2, y2],
                    confidence: conf,
                });
            }
        }

        // Sort top-to-bottom, left-to-right
        bubbles.sort_by(|a, b| {
            a.bbox[1].partial_cmp(&b.bbox[1])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.bbox[0].partial_cmp(&b.bbox[0]).unwrap_or(std::cmp::Ordering::Equal))
        });

        // Non-Maximum Suppression (NMS) — filter overlapping boxes
        let iou_threshold = 0.5f32;
        bubbles = nms(bubbles, iou_threshold);

        tracing::debug!("YOLO detected {} bubbles (conf > {}, NMS iou={})", bubbles.len(), conf_threshold, iou_threshold);
        Ok(bubbles)
    }
}

/// Non-Maximum Suppression: remove overlapping bounding boxes, keeping highest confidence.
fn nms(mut detections: Vec<BubbleDetection>, iou_threshold: f32) -> Vec<BubbleDetection> {
    // Sort by confidence descending
    detections.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    let keep = super::nms::nms_indices(&detections, iou_threshold, |d| d.bbox);
    let mut kept: Vec<BubbleDetection> = keep.into_iter().map(|i| detections[i].clone()).collect();
    kept.sort_by(|a, b| {
        a.bbox[1].partial_cmp(&b.bbox[1])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.bbox[0].partial_cmp(&b.bbox[0]).unwrap_or(std::cmp::Ordering::Equal))
    });
    kept
}

/// Reorder DB text detections based on bubble regions.
/// DB boxes whose center falls inside a bubble are grouped with that bubble
/// and sorted in reading order within the bubble. Boxes outside any bubble
/// are appended at the end. Returns (reordered_boxes, is_from_bubble_flags).
pub fn reorder_by_bubbles(
    bubbles: &[BubbleDetection],
    db_quads: &[[[i32; 2]; 4]],
    padding: f32,
) -> (Vec<[[i32; 2]; 4]>, Vec<bool>) {
    if bubbles.is_empty() {
        let flags = vec![false; db_quads.len()];
        return (db_quads.to_vec(), flags);
    }

    // Classify each DB box: which bubble (if any) contains it
    // bubble_index[i] = Some(bubble_idx) if DB box i is inside that bubble
    let mut bubble_index: Vec<Option<usize>> = vec![None; db_quads.len()];

    for (bi, bubble) in bubbles.iter().enumerate() {
        let bx1 = bubble.bbox[0] - padding;
        let by1 = bubble.bbox[1] - padding;
        let bx2 = bubble.bbox[2] + padding;
        let by2 = bubble.bbox[3] + padding;

        for (j, db_box) in db_quads.iter().enumerate() {
            let cx = (db_box[0][0] + db_box[1][0] + db_box[2][0] + db_box[3][0]) as f32 / 4.0;
            let cy = (db_box[0][1] + db_box[1][1] + db_box[2][1] + db_box[3][1]) as f32 / 4.0;
            if cx >= bx1 && cx <= bx2 && cy >= by1 && cy <= by2 {
                bubble_index[j] = Some(bi);
            }
        }
    }

    // Group DB boxes by bubble, sort within each bubble (top-to-bottom, left-to-right)
    let mut bubble_groups: Vec<Vec<usize>> = vec![Vec::new(); bubbles.len()];
    let mut orphan_boxes: Vec<usize> = Vec::new();

    for (j, &bi) in bubble_index.iter().enumerate() {
        if let Some(bi) = bi {
            bubble_groups[bi].push(j);
        } else {
            orphan_boxes.push(j);
        }
    }

    // Sort within each bubble group
    for group in &mut bubble_groups {
        group.sort_by(|&a, &b| {
            let ay = (db_quads[a][0][1] + db_quads[a][2][1]) as i32;
            let ax = (db_quads[a][0][0] + db_quads[a][2][0]) as i32;
            let by = (db_quads[b][0][1] + db_quads[b][2][1]) as i32;
            let bx = (db_quads[b][0][0] + db_quads[b][2][0]) as i32;
            ay.cmp(&by).then(ax.cmp(&bx))
        });
    }

    // Build result: bubble groups in bubble order (top-to-bottom), then orphans
    let mut result = Vec::new();
    let mut flags = Vec::new();

    for (bi, group) in bubble_groups.iter().enumerate() {
        // Sort bubbles by their top edge for group ordering
        let _ = bi;
        for &idx in group {
            result.push(db_quads[idx]);
            flags.push(true);
        }
    }

    // Sort bubble groups by their topmost box y-coordinate
    // Re-build: sort groups by their first box's y, then interleave
    // Actually, we need to sort the groups themselves
    {
        let mut group_order: Vec<usize> = (0..bubble_groups.len()).collect();
        group_order.sort_by(|&a, &b| {
            let a_y = bubble_groups[a].first().map(|&idx| {
                (db_quads[idx][0][1] + db_quads[idx][2][1]) / 2
            }).unwrap_or(i32::MAX);
            let b_y = bubble_groups[b].first().map(|&idx| {
                (db_quads[idx][0][1] + db_quads[idx][2][1]) / 2
            }).unwrap_or(i32::MAX);
            a_y.cmp(&b_y)
        });

        result.clear();
        flags.clear();
        for &gi in &group_order {
            for &idx in &bubble_groups[gi] {
                result.push(db_quads[idx]);
                flags.push(true);
            }
        }
    }

    // Append orphan boxes (outside any bubble), sorted normally
    orphan_boxes.sort_by(|&a, &b| {
        let ay = (db_quads[a][0][1] + db_quads[a][2][1]) as i32;
        let ax = (db_quads[a][0][0] + db_quads[a][2][0]) as i32;
        let by = (db_quads[b][0][1] + db_quads[b][2][1]) as i32;
        let bx = (db_quads[b][0][0] + db_quads[b][2][0]) as i32;
        ay.cmp(&by).then(ax.cmp(&bx))
    });
    for &idx in &orphan_boxes {
        result.push(db_quads[idx]);
        flags.push(false);
    }

    let bubble_count = flags.iter().filter(|&&f| f).count();
    tracing::debug!("reorder_by_bubbles: {} boxes in bubbles, {} orphans", bubble_count, orphan_boxes.len());

    (result, flags)
}
