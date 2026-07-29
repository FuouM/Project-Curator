use crate::db::models::Image;
use crate::detection::ccip::CCIPModel;
use crate::detection::types::*;
use crate::detection::yolo::YoloDetector;
use crate::image_decode;
use anyhow::{Context, Result};
use image::RgbImage;
use sqlx::sqlite::SqlitePool;
use tracing::{info, warn};

const CROP_THUMB_SIZE: u32 = 128;
const WEBP_QUALITY: f32 = 80.0;

pub struct DetectionPipeline {
    pub yolo: YoloDetector,
    pub ccip: CCIPModel,
    pub db: SqlitePool,
}

impl DetectionPipeline {
    pub fn new(yolo: YoloDetector, ccip: CCIPModel, db: SqlitePool) -> Self {
        Self { yolo, ccip, db }
    }

    /// Detect persons in an image, extract CCIP embeddings, match against known identities,
    /// and store results in the database.
    pub async fn detect_image(&self, image_id: i64) -> Result<DetectionResult> {
        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(&self.db)
            .await?
            .context(format!("Image {} not found", image_id))?;

        let filepath = std::path::Path::new(&image.current_filepath);
        if !filepath.exists() {
            anyhow::bail!("Image file not found: {:?}", filepath);
        }

        let (rgb_buf, width, height) = image_decode::decode_rgb(filepath)?;
        let img = RgbImage::from_raw(width, height, rgb_buf)
            .context("Failed to create RgbImage from decoded buffer")?;

        let detections = self.yolo.detect_persons(&img)?;
        let mut identities = self.load_identities().await?;

        let mut stored = Vec::new();
        for det in &detections {
            let crop = extract_crop(&img, det)?;
            let embedding = self.ccip.extract_embedding(&crop)?;

            let mut matched_identity: Option<i64> = None;
            for identity in &identities {
                let refs = self.load_identity_embeddings(identity.id).await?;
                if refs.is_empty() {
                    continue;
                }
                let (is_match, _diff) = self.ccip.compare_embeddings(&embedding, &refs)?;
                if is_match {
                    matched_identity = Some(identity.id);
                    break;
                }
            }

            // Auto-create identity for unmatched detections
            if matched_identity.is_none() {
                let new_id = self.create_next_identity().await?;
                matched_identity = Some(new_id);
                let new_name = format!("Character {}", new_id);
                identities.push(CharacterIdentity {
                    id: new_id,
                    name: new_name,
                    detection_count: 0,
                    created_at: String::new(),
                });
            }

            let embedding_bytes = f32_vec_to_bytes(&embedding);
            let result = sqlx::query(
                "INSERT INTO character_detections (image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(image_id)
            .bind(det.x0)
            .bind(det.y0)
            .bind(det.x1)
            .bind(det.y1)
            .bind(det.confidence)
            .bind(&embedding_bytes)
            .bind(matched_identity)
            .execute(&self.db)
            .await?;

            let detection_id = result.last_insert_rowid();

            stored.push(StoredDetection {
                id: detection_id,
                image_id,
                x0: det.x0,
                y0: det.y0,
                x1: det.x1,
                y1: det.y1,
                confidence: det.confidence,
                has_embedding: true,
                identity_id: matched_identity,
            });
        }

        info!(
            "Detected {} characters in image {} ({} matched to identities)",
            stored.len(),
            image_id,
            stored.iter().filter(|d| d.identity_id.is_some()).count()
        );

        Ok(DetectionResult {
            image_id,
            detections: stored,
        })
    }

    /// Batch detect multiple images.
    pub async fn detect_batch(&self, image_ids: &[i64]) -> Result<Vec<DetectionResult>> {
        let mut results = Vec::new();
        for &id in image_ids {
            match self.detect_image(id).await {
                Ok(r) => results.push(r),
                Err(e) => {
                    warn!("Detection failed for image {}: {:?}", id, e);
                }
            }
        }
        Ok(results)
    }

    /// Get all detections for an image.
    pub async fn get_detections(&self, image_id: i64) -> Result<Vec<StoredDetection>> {
        let rows: Vec<(i64, i64, i32, i32, i32, i32, f32, Option<Vec<u8>>, Option<i64>)> =
            sqlx::query_as(
                "SELECT id, image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id FROM character_detections WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(&self.db)
            .await?;

        Ok(rows
            .into_iter()
            .map(|(id, img_id, x0, y0, x1, y1, conf, emb, ident)| StoredDetection {
                id,
                image_id: img_id,
                x0,
                y0,
                x1,
                y1,
                confidence: conf,
                has_embedding: emb.is_some(),
                identity_id: ident,
            })
            .collect())
    }

    /// Assign a detection to a character identity (or unassign).
    pub async fn assign_identity(
        &self,
        detection_id: i64,
        identity_id: Option<i64>,
    ) -> Result<()> {
        sqlx::query("UPDATE character_detections SET identity_id = ? WHERE id = ?")
            .bind(identity_id)
            .bind(detection_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// Create a new character identity with auto-incrementing name.
    pub async fn create_identity(&self, name: Option<String>) -> Result<i64> {
        let final_name = match name {
            Some(n) => n,
            None => {
                let max_id: Option<i64> =
                    sqlx::query_scalar("SELECT MAX(id) FROM character_identities")
                        .fetch_optional(&self.db)
                        .await?
                        .flatten();
                format!("Character {}", max_id.unwrap_or(0) + 1)
            }
        };

        let result = sqlx::query("INSERT INTO character_identities (name) VALUES (?)")
            .bind(&final_name)
            .execute(&self.db)
            .await?;

        let id = result.last_insert_rowid();
        info!("Created character identity: {} (id={})", final_name, id);
        Ok(id)
    }

    /// Rename a character identity.
    pub async fn rename_identity(&self, identity_id: i64, name: String) -> Result<()> {
        sqlx::query("UPDATE character_identities SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(&name)
            .bind(identity_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// Delete a character identity (detections become unassigned).
    pub async fn delete_identity(&self, identity_id: i64) -> Result<()> {
        sqlx::query("DELETE FROM character_identities WHERE id = ?")
            .bind(identity_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// List all character identities with detection counts.
    pub async fn list_identities(&self) -> Result<Vec<CharacterIdentity>> {
        let rows: Vec<(i64, String, i64, String)> = sqlx::query_as(
            "SELECT ci.id, ci.name, COUNT(cd.id) as detection_count, ci.created_at \
             FROM character_identities ci \
             LEFT JOIN character_detections cd ON cd.identity_id = ci.id \
             GROUP BY ci.id \
             ORDER BY ci.id"
        )
        .fetch_all(&self.db)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(id, name, count, created_at)| CharacterIdentity {
                id,
                name,
                detection_count: count,
                created_at,
            })
            .collect())
    }

    /// Delete a single detection by ID.
    pub async fn delete_detection(&self, detection_id: i64) -> Result<()> {
        sqlx::query("DELETE FROM character_detections WHERE id = ?")
            .bind(detection_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// Re-identify all detections against current character identities.
    pub async fn reidentify_all(&self) -> Result<ReidentifyResult> {
        let identities = self.load_identities().await?;
        let detections: Vec<(i64, Vec<u8>)> = sqlx::query_as(
            "SELECT id, ccip_embedding FROM character_detections WHERE ccip_embedding IS NOT NULL"
        )
        .fetch_all(&self.db)
        .await?;

        let total = detections.len() as i64;
        let mut matched = 0i64;

        for (det_id, emb_bytes) in &detections {
            let query_emb = bytes_to_f32_vec(emb_bytes);

            let mut best_identity: Option<i64> = None;
            let mut best_diff = f32::MAX;

            for identity in &identities {
                let refs = self.load_identity_embeddings(identity.id).await?;
                if refs.is_empty() {
                    continue;
                }
                let (is_match, diff) = self.ccip.compare_embeddings(&query_emb, &refs)?;
                if is_match && diff < best_diff {
                    best_diff = diff;
                    best_identity = Some(identity.id);
                }
            }

            sqlx::query("UPDATE character_detections SET identity_id = ? WHERE id = ?")
                .bind(best_identity)
                .bind(det_id)
                .execute(&self.db)
                .await?;

            if best_identity.is_some() {
                matched += 1;
            }
        }

        Ok(ReidentifyResult {
            total_detections: total,
            matched,
            unmatched: total - matched,
        })
    }

    /// Search for all images containing a specific character identity.
    pub async fn search_by_character(&self, identity_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT image_id FROM character_detections WHERE identity_id = ?"
        )
        .bind(identity_id)
        .fetch_all(&self.db)
        .await?;

        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Get all unassigned detections (identity_id IS NULL) with full details.
    pub async fn list_unassigned_detections(&self) -> Result<Vec<StoredDetection>> {
        let rows: Vec<(i64, i64, i32, i32, i32, i32, f32, Option<Vec<u8>>, Option<i64>)> =
            sqlx::query_as(
                "SELECT id, image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id FROM character_detections WHERE identity_id IS NULL ORDER BY id"
            )
            .fetch_all(&self.db)
            .await?;

        Ok(rows
            .into_iter()
            .map(|(id, image_id, x0, y0, x1, y1, confidence, emb, identity_id)| StoredDetection {
                id,
                image_id,
                x0,
                y0,
                x1,
                y1,
                confidence,
                has_embedding: emb.is_some(),
                identity_id,
            })
            .collect())
    }

    /// Load crop thumbnail bytes for a detection (for UI display).
    pub async fn load_crop_jpeg(&self, detection_id: i64) -> Result<Option<Vec<u8>>> {
        let row: (i64, i64, i32, i32, i32, i32, f32, Option<Vec<u8>>, Option<i64>) =
            sqlx::query_as(
                "SELECT id, image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id FROM character_detections WHERE id = ?"
            )
            .bind(detection_id)
            .fetch_one(&self.db)
            .await
            .context("Detection not found")?;

        let det = StoredDetection {
            id: row.0,
            image_id: row.1,
            x0: row.2,
            y0: row.3,
            x1: row.4,
            y1: row.5,
            confidence: row.6,
            has_embedding: row.7.is_some(),
            identity_id: row.8,
        };

        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = ?")
            .bind(det.image_id)
            .fetch_one(&self.db)
            .await
            .context("Image not found")?;

        let filepath = std::path::Path::new(&image.current_filepath);
        if !filepath.exists() {
            return Ok(None);
        }

        let (rgb_buf, width, height) = image_decode::decode_rgb(filepath)?;
        let img = RgbImage::from_raw(width, height, rgb_buf)
            .context("Failed to create RgbImage")?;

        let crop = extract_crop_padded(&img, &det, 0.05)?;

        let resized = image::DynamicImage::ImageRgb8(crop).resize(
            CROP_THUMB_SIZE,
            CROP_THUMB_SIZE,
            image::imageops::FilterType::Lanczos3,
        );

        let rgb = resized.to_rgb8();
        let encoder = webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height());
        let webp_memory = encoder.encode(WEBP_QUALITY);
        Ok(Some(webp_memory.to_vec()))
    }

    async fn load_identities(&self) -> Result<Vec<CharacterIdentity>> {
        self.list_identities().await
    }

    /// Create a new identity with auto-incremented name "Character N".
    async fn create_next_identity(&self) -> Result<i64> {
        let max_id: Option<(Option<i64>,)> = sqlx::query_as(
            "SELECT MAX(id) FROM character_identities"
        )
        .fetch_optional(&self.db)
        .await?;
        let next_id = max_id.and_then(|m| m.0).unwrap_or(0) + 1;
        let name = format!("Character {}", next_id);
        let result = sqlx::query(
            "INSERT INTO character_identities (name) VALUES (?)"
        )
        .bind(&name)
        .execute(&self.db)
        .await?;
        Ok(result.last_insert_rowid())
    }

    async fn load_identity_embeddings(&self, identity_id: i64) -> Result<Vec<Vec<f32>>> {
        let rows: Vec<(Option<Vec<u8>>,) > = sqlx::query_as(
            "SELECT ccip_embedding FROM character_detections WHERE identity_id = ? AND ccip_embedding IS NOT NULL"
        )
        .bind(identity_id)
        .fetch_all(&self.db)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|(emb,)| emb.map(|b| bytes_to_f32_vec(&b)))
            .collect())
    }
}

fn extract_crop(img: &RgbImage, det: &Detection) -> Result<RgbImage> {
    let w = img.width() as f32;
    let h = img.height() as f32;
    let bw = (det.x1 - det.x0) as f32;
    let bh = (det.y1 - det.y0) as f32;
    let pad_x = (bw * 0.05) as i32;
    let pad_y = (bh * 0.05) as i32;

    let x0 = (det.x0 - pad_x).max(0) as u32;
    let y0 = (det.y0 - pad_y).max(0) as u32;
    let x1 = (det.x1 + pad_x).min(w as i32) as u32;
    let y1 = (det.y1 + pad_y).min(h as i32) as u32;

    let crop_w = x1 - x0;
    let crop_h = y1 - y0;

    if crop_w == 0 || crop_h == 0 {
        anyhow::bail!("Invalid crop dimensions: {}x{}", crop_w, crop_h);
    }

    let mut crop = RgbImage::new(crop_w, crop_h);
    let raw = img.as_raw();
    let crop_raw = crop.as_mut();

    for y in 0..crop_h {
        let src_row = ((y0 + y) * img.width() + x0) as usize * 3;
        let dst_row = (y * crop_w) as usize * 3;
        let copy_len = (crop_w * 3) as usize;
        crop_raw[dst_row..dst_row + copy_len]
            .copy_from_slice(&raw[src_row..src_row + copy_len]);
    }

    Ok(crop)
}

fn extract_crop_padded(img: &RgbImage, det: &StoredDetection, padding_ratio: f32) -> Result<RgbImage> {
    let w = img.width() as f32;
    let h = img.height() as f32;
    let bw = (det.x1 - det.x0) as f32;
    let bh = (det.y1 - det.y0) as f32;
    let pad_x = (bw * padding_ratio) as i32;
    let pad_y = (bh * padding_ratio) as i32;

    let x0 = (det.x0 - pad_x).max(0) as u32;
    let y0 = (det.y0 - pad_y).max(0) as u32;
    let x1 = (det.x1 + pad_x).min(w as i32) as u32;
    let y1 = (det.y1 + pad_y).min(h as i32) as u32;

    let crop_w = x1 - x0;
    let crop_h = y1 - y0;

    if crop_w == 0 || crop_h == 0 {
        anyhow::bail!("Invalid crop dimensions: {}x{}", crop_w, crop_h);
    }

    let mut crop = RgbImage::new(crop_w, crop_h);
    let raw = img.as_raw();
    let crop_raw = crop.as_mut();

    for y in 0..crop_h {
        let src_row = ((y0 + y) * img.width() + x0) as usize * 3;
        let dst_row = (y * crop_w) as usize * 3;
        let copy_len = (crop_w * 3) as usize;
        crop_raw[dst_row..dst_row + copy_len]
            .copy_from_slice(&raw[src_row..src_row + copy_len]);
    }

    Ok(crop)
}

fn f32_vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for &f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

fn bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
