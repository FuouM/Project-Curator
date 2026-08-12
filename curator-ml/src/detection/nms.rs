/// Shared bounding-box geometry helpers used by detection post-processing.
///
/// Compute Intersection over Union (IoU) between two [x1, y1, x2, y2] boxes.
pub fn bbox_iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let ix1 = a[0].max(b[0]);
    let iy1 = a[1].max(b[1]);
    let ix2 = a[2].min(b[2]);
    let iy2 = a[3].min(b[3]);
    let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
    let area_a = (a[2] - a[0]) * (a[3] - a[1]);
    let area_b = (b[2] - b[0]) * (b[3] - b[1]);
    let union = area_a + area_b - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Non-Maximum Suppression over items already sorted by confidence descending.
///
/// Returns the indices to keep; higher-priority (earlier) boxes suppress any
/// later box whose IoU exceeds `iou_threshold`. `bbox` extracts the
/// [x1, y1, x2, y2] box from `T`.
pub fn nms_indices<T>(
    items: &[T],
    iou_threshold: f32,
    bbox: impl Fn(&T) -> [f32; 4],
) -> Vec<usize> {
    let mut keep = Vec::new();
    let mut suppressed = vec![false; items.len()];

    for i in 0..items.len() {
        if suppressed[i] {
            continue;
        }
        keep.push(i);
        let bbox_i = bbox(&items[i]);
        for j in (i + 1)..items.len() {
            if suppressed[j] {
                continue;
            }
            if bbox_iou(&bbox_i, &bbox(&items[j])) > iou_threshold {
                suppressed[j] = true;
            }
        }
    }

    keep
}
