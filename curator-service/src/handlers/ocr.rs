use anyhow::{bail, Result};
use curator_core::image as core_image;
use curator_core::ipc::{BubbleBoxResult, EphemeralOcrDetection, OcrResult};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tracing::info;

type RgbImage = core_image::ImageBuffer<core_image::Rgb<u8>, Vec<u8>>;

fn decode_rgb_image(filepath: &Path) -> Result<RgbImage> {
    let (rgb_buf, width, height) =
        tokio::task::block_in_place(|| curator_core::image_decode::decode_rgb(filepath))
            .map_err(|e| anyhow::anyhow!("Image decode failed: {:?}", e))?;
    RgbImage::from_raw(width, height, rgb_buf)
        .ok_or_else(|| anyhow::anyhow!("Invalid image buffer"))
}

pub async fn run_ocr_logic(
    image_id: i64,
    db: &SqlitePool,
    ocr: &Arc<curator_core::OcrDetector>,
) -> Result<(i64, Vec<OcrResult>, Vec<BubbleBoxResult>)> {
    let row: Option<(String, Option<String>)> =
        match sqlx::query_as("SELECT current_filepath, video_frame_path FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(db)
            .await
        {
            Ok(r) => r,
            Err(e) => bail!("DB Error: {:?}", e),
        };

    let (current_filepath, video_frame_path) = match row {
        Some(r) => r,
        None => bail!("Image {} not found", image_id),
    };
    let filepath = curator_core::video::decode_path(&current_filepath, video_frame_path.as_deref())
        .to_string_lossy()
        .into_owned();

    let filepath_path = Path::new(&filepath);
    if !filepath_path.exists() {
        bail!("File not found: {:?}", filepath);
    }

    let img = decode_rgb_image(filepath_path)?;

    let ocr_clone = Arc::clone(ocr);
    let detections_res = tokio::task::spawn_blocking(move || ocr_clone.run_ocr(&img)).await;
    let (detections, bubbles) = match detections_res {
        Ok(Ok(dets)) => dets,
        Ok(Err(e)) => bail!("OCR execution failed: {:?}", e),
        Err(e) => bail!("Task join panicked: {:?}", e),
    };

    let mut tx = db.begin().await.map_err(|e| anyhow::anyhow!("Failed to begin OCR transaction: {:?}", e))?;

    sqlx::query("DELETE FROM image_ocr_detections WHERE image_id = ?")
        .bind(image_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to clear old OCR data: {:?}", e))?;

    for det in &detections {
        let p = &det.polygon;
        sqlx::query(
            "INSERT INTO image_ocr_detections (image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(image_id)
        .bind(&det.text)
        .bind(det.confidence)
        .bind(p[0][0])
        .bind(p[0][1])
        .bind(p[1][0])
        .bind(p[1][1])
        .bind(p[2][0])
        .bind(p[2][1])
        .bind(p[3][0])
        .bind(p[3][1])
        .bind(det.is_from_bubble)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to insert OCR detection: {:?}", e))?;
    }

    sqlx::query("DELETE FROM image_ocr_bubble_boxes WHERE image_id = ?")
        .bind(image_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to clear old OCR bubbles: {:?}", e))?;
    for b in &bubbles {
        sqlx::query(
            "INSERT INTO image_ocr_bubble_boxes (image_id, x1, y1, x2, y2, confidence) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(image_id)
        .bind(b.bbox[0])
        .bind(b.bbox[1])
        .bind(b.bbox[2])
        .bind(b.bbox[3])
        .bind(b.confidence)
        .execute(&mut *tx)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to insert OCR bubble box: {:?}", e))?;
    }

    tx.commit()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to commit OCR transaction: {:?}", e))?;

    let results: Vec<OcrResult> = sqlx::query_as(
        "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble FROM image_ocr_detections WHERE image_id = ?",
    )
    .bind(image_id)
    .fetch_all(db)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to retrieve OCR results: {:?}", e))?;

    let bubble_box_results: Vec<BubbleBoxResult> = bubbles
        .iter()
        .map(|b| BubbleBoxResult {
            x1: b.bbox[0],
            y1: b.bbox[1],
            x2: b.bbox[2],
            y2: b.bbox[3],
            confidence: b.confidence,
        })
        .collect();

    Ok((image_id, results, bubble_box_results))
}

pub async fn get_ocr_detections_logic(
    image_id: i64,
    db: &SqlitePool,
) -> Result<(i64, Vec<OcrResult>, Vec<BubbleBoxResult>)> {
    let results: Vec<OcrResult> = sqlx::query_as(
        "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble FROM image_ocr_detections WHERE image_id = ?",
    )
    .bind(image_id)
    .fetch_all(db)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to query OCR detections: {:?}", e))?;

    let bubble_boxes: Vec<BubbleBoxResult> = sqlx::query_as(
        "SELECT x1, y1, x2, y2, confidence FROM image_ocr_bubble_boxes WHERE image_id = ?",
    )
    .bind(image_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    Ok((image_id, results, bubble_boxes))
}

pub async fn ephemeral_run_ocr_logic(
    path: String,
    ocr: &Arc<curator_core::OcrDetector>,
) -> Result<(String, Vec<EphemeralOcrDetection>, Vec<BubbleBoxResult>)> {
    let path_path = Path::new(&path);
    if !path_path.exists() {
        bail!("File not found: {:?}", path);
    }

    let img = decode_rgb_image(path_path)?;

    let ocr_clone = Arc::clone(ocr);
    let detections_res = tokio::task::spawn_blocking(move || ocr_clone.run_ocr(&img)).await;
    let (detections, bubbles) = match detections_res {
        Ok(Ok(dets)) => dets,
        Ok(Err(e)) => bail!("OCR execution failed: {:?}", e),
        Err(e) => bail!("Task join panicked: {:?}", e),
    };

    let det_results: Vec<EphemeralOcrDetection> = detections
        .iter()
        .map(|det| {
            let p = &det.polygon;
            EphemeralOcrDetection {
                text: det.text.clone(),
                confidence: det.confidence,
                x0: p[0][0],
                y0: p[0][1],
                x1: p[1][0],
                y1: p[1][1],
                x2: p[2][0],
                y2: p[2][1],
                x3: p[3][0],
                y3: p[3][1],
                is_from_bubble: det.is_from_bubble,
            }
        })
        .collect();

    let bubble_results: Vec<BubbleBoxResult> = bubbles
        .iter()
        .map(|b| BubbleBoxResult {
            x1: b.bbox[0],
            y1: b.bbox[1],
            x2: b.bbox[2],
            y2: b.bbox[3],
            confidence: b.confidence,
        })
        .collect();

    info!(
        "EphemeralRunOcr {:?}: {} text detections, {} bubbles",
        path,
        det_results.len(),
        bubble_results.len()
    );

    Ok((path, det_results, bubble_results))
}
