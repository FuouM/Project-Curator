use crate::crop_cache::CropCache;
use crate::db::models::Image;
use crate::detection::ccip::CCIPModel;
use crate::detection::types::*;
use crate::detection::yolo::YoloDetector;
use crate::image_decode;
use anyhow::{Context, Result};
use image::RgbImage;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tracing::{info, warn};

const CROP_THUMB_SIZE: u32 = 128;
const WEBP_QUALITY: f32 = 80.0;

pub struct DetectionPipeline {
    pub yolo: YoloDetector,
    pub ccip: CCIPModel,
    pub db: SqlitePool,
    pub crop_cache: Arc<CropCache>,
}

impl DetectionPipeline {
    pub fn new(yolo: YoloDetector, ccip: CCIPModel, db: SqlitePool, crop_cache: Arc<CropCache>) -> Self {
        Self { yolo, ccip, db, crop_cache }
    }

    /// Detect persons in an image, extract CCIP embeddings, match against known identities,
    /// and store results in the database.
    pub async fn detect_image(&self, image_id: i64) -> Result<DetectionResult> {
        let t_total = std::time::Instant::now();

        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(&self.db)
            .await?
            .context(format!("Image {} not found", image_id))?;

        let filepath = std::path::Path::new(&image.current_filepath);
        if !filepath.exists() {
            anyhow::bail!("Image file not found: {:?}", filepath);
        }

        // Clear existing detections for this image to prevent duplicate accumulation
        let old_dets: Vec<(i64,)> = sqlx::query_as("SELECT id FROM character_detections WHERE image_id = ?")
            .bind(image_id)
            .fetch_all(&self.db)
            .await?;
        for (old_id,) in old_dets {
            let _ = self.crop_cache.delete(old_id).await;
        }
        sqlx::query("DELETE FROM character_detections WHERE image_id = ?")
            .bind(image_id)
            .execute(&self.db)
            .await?;
        self.cleanup_empty_identities().await?;

        let t_decode = std::time::Instant::now();
        let (rgb_buf, width, height) = image_decode::decode_rgb(filepath)?;
        let img = RgbImage::from_raw(width, height, rgb_buf)
            .context("Failed to create RgbImage from decoded buffer")?;
        let decode_ms = t_decode.elapsed().as_millis();

        let t_yolo = std::time::Instant::now();
        let detections = self.yolo.detect_persons(&img)?;
        let yolo_ms = t_yolo.elapsed().as_millis();

        let mut identities = self.load_identities().await?;

        let mut stored = Vec::new();
        let mut ccip_ms = 0;
        let mut match_ms = 0;
        let mut cache_ms = 0;

        if !detections.is_empty() {
            let t_match_setup = std::time::Instant::now();
            // Pre-load all character identity embeddings in a single query to avoid N queries in loop
            let mut identity_embeddings: std::collections::HashMap<i64, Vec<Vec<f32>>> = std::collections::HashMap::new();
            let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
                "SELECT identity_id, ccip_embedding FROM character_detections WHERE identity_id IS NOT NULL AND ccip_embedding IS NOT NULL"
            )
            .fetch_all(&self.db)
            .await?;
            for (ident_id, emb_bytes) in rows {
                identity_embeddings.entry(ident_id).or_default().push(bytes_to_f32_vec(&emb_bytes));
            }
            match_ms += t_match_setup.elapsed().as_millis();

            for det in &detections {
                let t_ccip = std::time::Instant::now();
                let crop = extract_crop(&img, det)?;
                let embedding = self.ccip.extract_embedding(&crop)?;
                ccip_ms += t_ccip.elapsed().as_millis();

                let t_match = std::time::Instant::now();
                let mut matched_identity: Option<i64> = None;
                for identity in &identities {
                    if let Some(refs) = identity_embeddings.get(&identity.id) {
                        let (is_match, _diff) = self.ccip.compare_embeddings(&embedding, refs)?;
                        if is_match {
                            matched_identity = Some(identity.id);
                            break;
                        }
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
                    // Insert empty vector list for the new identity
                    identity_embeddings.insert(new_id, Vec::new());
                }
                match_ms += t_match.elapsed().as_millis();

                let t_cache = std::time::Instant::now();
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

                let stored_det = StoredDetection {
                    id: detection_id,
                    image_id,
                    x0: det.x0,
                    y0: det.y0,
                    x1: det.x1,
                    y1: det.y1,
                    confidence: det.confidence,
                    has_embedding: true,
                    identity_id: matched_identity,
                };

                stored.push(stored_det);

                // Add this new embedding to the cache so subsequent detections can match it immediately
                if let Some(matched_id) = matched_identity {
                    identity_embeddings.entry(matched_id).or_default().push(embedding.clone());
                }
                cache_ms += t_cache.elapsed().as_millis();
            }

            // Offload crop extraction and cache insertion to a background task
            let crops_cache = self.crop_cache.clone();
            let stored_cloned = stored.clone();
            let img_cloned = img.clone();
            tokio::spawn(async move {
                let mut crops_to_cache = Vec::new();
                for stored_det in stored_cloned {
                    if let Ok(crop) = extract_crop_padded(&img_cloned, &stored_det, 0.05) {
                        if let Ok(resized_raw) = resize_rgb_fast(&crop, CROP_THUMB_SIZE) {
                            let webp_bytes = {
                                let encoder = webp::Encoder::from_rgb(&resized_raw, CROP_THUMB_SIZE, CROP_THUMB_SIZE);
                                let webp_memory = encoder.encode(WEBP_QUALITY);
                                webp_memory.to_vec()
                            };
                            crops_to_cache.push((stored_det.id, CROP_THUMB_SIZE, webp_bytes));
                        }
                    }
                }
                if !crops_to_cache.is_empty() {
                    if let Err(e) = crops_cache.put_batch(&crops_to_cache).await {
                        tracing::warn!("Failed to warm up crop cache in background: {:?}", e);
                    }
                }
            });
        }

        let total_ms = t_total.elapsed().as_millis();
        info!(
            "detect_image timing summary for image {}: decode={}ms yolo={}ms ccip={}ms match={}ms cache={}ms total={}ms | {} detections",
            image_id, decode_ms, yolo_ms, ccip_ms, match_ms, cache_ms, total_ms, stored.len()
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
        self.cleanup_empty_identities().await?;
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

    pub async fn rename_identity(&self, identity_id: i64, name: String) -> Result<()> {
        let target_name = name.trim();
        
        let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM character_identities WHERE name = ?")
            .bind(target_name)
            .fetch_optional(&self.db)
            .await?;

        if let Some((existing_id,)) = existing {
            if existing_id != identity_id {
                // Merge identities: update detections to point to existing identity, then delete old identity
                sqlx::query("UPDATE character_detections SET identity_id = ? WHERE identity_id = ?")
                    .bind(existing_id)
                    .bind(identity_id)
                    .execute(&self.db)
                    .await?;

                sqlx::query("DELETE FROM character_identities WHERE id = ?")
                    .bind(identity_id)
                    .execute(&self.db)
                    .await?;

                info!("Merged identity {} into existing identity {} (name: {})", identity_id, existing_id, target_name);
                return Ok(());
            }
        }

        sqlx::query("UPDATE character_identities SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(target_name)
            .bind(identity_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// Delete a character identity (detections become unassigned).
    pub async fn delete_identity(&self, identity_id: i64) -> Result<()> {
        // Explicitly set identity_id to NULL for all associated detections to prevent orphaning them
        sqlx::query("UPDATE character_detections SET identity_id = NULL WHERE identity_id = ?")
            .bind(identity_id)
            .execute(&self.db)
            .await?;

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

    pub async fn delete_detection(&self, detection_id: i64) -> Result<()> {
        sqlx::query("DELETE FROM character_detections WHERE id = ?")
            .bind(detection_id)
            .execute(&self.db)
            .await?;
        self.cleanup_empty_identities().await?;
        Ok(())
    }

    async fn cleanup_empty_identities(&self) -> Result<()> {
        sqlx::query(
            "DELETE FROM character_identities WHERE id NOT IN (SELECT DISTINCT identity_id FROM character_detections WHERE identity_id IS NOT NULL)"
        )
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Update a detection's bounding box coordinates, clear its cache, and extract a new embedding.
    pub async fn update_detection_bbox(&self, detection_id: i64, x0: i32, y0: i32, x1: i32, y1: i32) -> Result<()> {
        // 1. Invalidate crop cache
        self.crop_cache.delete(detection_id).await?;

        // 2. Fetch image_id
        let row: (i64,) = sqlx::query_as(
            "SELECT image_id FROM character_detections WHERE id = ?"
        )
        .bind(detection_id)
        .fetch_one(&self.db)
        .await?;

        let image_id = row.0;

        // 3. Fetch image path
        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_one(&self.db)
            .await?;

        let filepath = std::path::Path::new(&image.current_filepath);
        if !filepath.exists() {
            anyhow::bail!("Image file not found: {:?}", filepath);
        }

        // 4. Decode image
        let (rgb_buf, width, height) = image_decode::decode_rgb(filepath)?;
        let img = RgbImage::from_raw(width, height, rgb_buf)
            .context("Failed to create RgbImage from decoded buffer")?;

        // 5. Extract crop & CCIP embedding
        // Clamp coordinates to image dimensions
        let x0 = x0.clamp(0, width as i32 - 1);
        let y0 = y0.clamp(0, height as i32 - 1);
        let x1 = x1.clamp(0, width as i32);
        let y1 = y1.clamp(0, height as i32);

        let det = StoredDetection {
            id: detection_id,
            image_id,
            x0,
            y0,
            x1,
            y1,
            confidence: 1.0,
            has_embedding: false,
            identity_id: None,
        };

        let crop = extract_crop_padded(&img, &det, 0.0)?;
        let embedding = self.ccip.extract_embedding(&crop)?;
        let embedding_bytes = f32_vec_to_bytes(&embedding);

        // 6. Update database
        sqlx::query("UPDATE character_detections SET x0 = ?, y0 = ?, x1 = ?, y1 = ?, confidence = ?, ccip_embedding = ? WHERE id = ?")
            .bind(x0)
            .bind(y0)
            .bind(x1)
            .bind(y1)
            .bind(1.0f32)
            .bind(&embedding_bytes)
            .bind(detection_id)
            .execute(&self.db)
            .await?;

        // 7. Invalidate SQLite crop cache so next crop request pulls the updated box coordinates
        let _ = self.crop_cache.delete(detection_id).await;

        Ok(())
    }

    /// Manually add a bounding box detection, extract its embedding,
    /// set its identity to NULL (unassigned), store it, and warm up its crop cache.
    pub async fn add_detection(&self, image_id: i64, x0: i32, y0: i32, x1: i32, y1: i32) -> Result<StoredDetection> {
        // 1. Fetch image details
        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(&self.db)
            .await?
            .context(format!("Image {} not found", image_id))?;

        let filepath = std::path::Path::new(&image.current_filepath);
        if !filepath.exists() {
            anyhow::bail!("Image file not found: {:?}", filepath);
        }

        // 2. Decode image
        let (rgb_buf, width, height) = image_decode::decode_rgb(filepath)?;
        let img = RgbImage::from_raw(width, height, rgb_buf)
            .context("Failed to create RgbImage from decoded buffer")?;

        // 3. Clamp coordinates to image dimensions
        let x0 = x0.clamp(0, width as i32 - 1);
        let y0 = y0.clamp(0, height as i32 - 1);
        let x1 = x1.clamp(0, width as i32);
        let y1 = y1.clamp(0, height as i32);

        let det = Detection {
            x0,
            y0,
            x1,
            y1,
            confidence: 1.0,
        };

        // 4. Extract crop & CCIP embedding
        let crop = extract_crop(&img, &det)?;
        let embedding = self.ccip.extract_embedding(&crop)?;
        let embedding_bytes = f32_vec_to_bytes(&embedding);

        // 5. Store in database (with identity_id = NULL)
        let result = sqlx::query(
            "INSERT INTO character_detections (image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
        )
        .bind(image_id)
        .bind(det.x0)
        .bind(det.y0)
        .bind(det.x1)
        .bind(det.y1)
        .bind(det.confidence)
        .bind(&embedding_bytes)
        .execute(&self.db)
        .await?;

        let detection_id = result.last_insert_rowid();

        let stored_det = StoredDetection {
            id: detection_id,
            image_id,
            x0: det.x0,
            y0: det.y0,
            x1: det.x1,
            y1: det.y1,
            confidence: det.confidence,
            has_embedding: true,
            identity_id: None,
        };

        // 6. Cache crop thumbnail in background
        let crops_cache = self.crop_cache.clone();
        let stored_cloned = stored_det.clone();
        tokio::spawn(async move {
            if let Ok(crop) = extract_crop_padded(&img, &stored_cloned, 0.05) {
                if let Ok(resized_raw) = resize_rgb_fast(&crop, CROP_THUMB_SIZE) {
                    let webp_bytes = {
                        let encoder = webp::Encoder::from_rgb(&resized_raw, CROP_THUMB_SIZE, CROP_THUMB_SIZE);
                        let webp_memory = encoder.encode(WEBP_QUALITY);
                        webp_memory.to_vec()
                    };
                    let _ = crops_cache.put(stored_cloned.id, CROP_THUMB_SIZE, &webp_bytes).await;
                }
            }
        });

        Ok(stored_det)
    }

    /// Identify a single detection against known identities.
    /// Compare its embedding against known identities, assign it to the matching identity
    /// or create a new one if no match is found.
    pub async fn identify_detection(&self, detection_id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<Vec<u8>>, Option<i64>)> = sqlx::query_as(
            "SELECT ccip_embedding, identity_id FROM character_detections WHERE id = ?"
        )
        .bind(detection_id)
        .fetch_optional(&self.db)
        .await?;

        let (emb_bytes, current_identity) = match row {
            Some((Some(bytes), ident)) => (bytes, ident),
            _ => anyhow::bail!("Detection {} has no embedding or does not exist", detection_id),
        };

        let query_emb = bytes_to_f32_vec(&emb_bytes);

        // Load current identities and their references
        let identities = self.load_identities().await?;
        let mut identity_embeddings: std::collections::HashMap<i64, Vec<Vec<f32>>> = std::collections::HashMap::new();
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
            "SELECT identity_id, ccip_embedding FROM character_detections WHERE identity_id IS NOT NULL AND ccip_embedding IS NOT NULL"
        )
        .fetch_all(&self.db)
        .await?;
        for (ident_id, emb_bytes) in rows {
            identity_embeddings.entry(ident_id).or_default().push(bytes_to_f32_vec(&emb_bytes));
        }

        // Find match
        let mut best_identity: Option<i64> = None;
        let mut best_diff = f32::MAX;

        for identity in &identities {
            if let Some(refs) = identity_embeddings.get(&identity.id) {
                let (is_match, diff) = self.ccip.compare_embeddings(&query_emb, refs)?;
                if is_match && diff < best_diff {
                    best_diff = diff;
                    best_identity = Some(identity.id);
                }
            }
        }

        // If no match, auto-create a new identity
        let target_identity = match best_identity {
            Some(id) => Some(id),
            None => {
                let new_id = self.create_next_identity().await?;
                Some(new_id)
            }
        };

        // Update database if it changed
        if target_identity != current_identity {
            sqlx::query("UPDATE character_detections SET identity_id = ? WHERE id = ?")
                .bind(target_identity)
                .bind(detection_id)
                .execute(&self.db)
                .await?;
            self.cleanup_empty_identities().await?;
        }

        Ok(target_identity)
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

        if !detections.is_empty() {
            // Pre-load all character identity embeddings in a single query
            let mut identity_embeddings: std::collections::HashMap<i64, Vec<Vec<f32>>> = std::collections::HashMap::new();
            let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
                "SELECT identity_id, ccip_embedding FROM character_detections WHERE identity_id IS NOT NULL AND ccip_embedding IS NOT NULL"
            )
            .fetch_all(&self.db)
            .await?;
            for (ident_id, emb_bytes) in rows {
                identity_embeddings.entry(ident_id).or_default().push(bytes_to_f32_vec(&emb_bytes));
            }

            for (det_id, emb_bytes) in &detections {
                let query_emb = bytes_to_f32_vec(emb_bytes);

                let mut best_identity: Option<i64> = None;
                let mut best_diff = f32::MAX;

                for identity in &identities {
                    if let Some(refs) = identity_embeddings.get(&identity.id) {
                        let (is_match, diff) = self.ccip.compare_embeddings(&query_emb, refs)?;
                        if is_match && diff < best_diff {
                            best_diff = diff;
                            best_identity = Some(identity.id);
                        }
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
        if let Some(cached) = self.crop_cache.get(detection_id).await {
            return Ok(Some(cached));
        }

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

        let current_filepath = image.current_filepath.clone();
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let path = std::path::Path::new(&current_filepath);
            let (rgb_buf, width, height) = image_decode::decode_rgb(path)?;
            let img = RgbImage::from_raw(width, height, rgb_buf)
                .context("Failed to create RgbImage")?;

            let crop = extract_crop_padded(&img, &det, 0.05)?;
            let crop_w = crop.width();
            let crop_h = crop.height();
            info!(
                "load_crop_jpeg: det_id={} coords=({},{},{},{}) image_dims={}x{} crop_dims={}x{}",
                detection_id, det.x0, det.y0, det.x1, det.y1, width, height, crop_w, crop_h
            );

            let resized_raw = resize_rgb_fast(&crop, CROP_THUMB_SIZE)?;
            let encoder = webp::Encoder::from_rgb(&resized_raw, CROP_THUMB_SIZE, CROP_THUMB_SIZE);
            let webp_memory = encoder.encode(WEBP_QUALITY);
            Ok(webp_memory.to_vec())
        })
        .await
        .context("Failed to execute spawn_blocking for crop thumbnail")??;

        let _ = self.crop_cache.put(detection_id, CROP_THUMB_SIZE, &bytes).await;

        Ok(Some(bytes))
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


}

pub fn extract_crop(img: &RgbImage, det: &Detection) -> Result<RgbImage> {
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
    let w = img.width() as i32;
    let h = img.height() as i32;
    let bw = (det.x1 - det.x0) as f32;
    let bh = (det.y1 - det.y0) as f32;
    let pad_x = (bw * padding_ratio) as i32;
    let pad_y = (bh * padding_ratio) as i32;

    // 1. Crop exactly the bounding box (with padding)
    let x0 = (det.x0 - pad_x).max(0);
    let y0 = (det.y0 - pad_y).max(0);
    let x1 = (det.x1 + pad_x).min(w);
    let y1 = (det.y1 + pad_y).min(h);

    let crop_w = (x1 - x0) as u32;
    let crop_h = (y1 - y0) as u32;

    if crop_w == 0 || crop_h == 0 {
        anyhow::bail!("Invalid crop dimensions: {}x{}", crop_w, crop_h);
    }

    // 2. Initialize a white square image
    let square_size = crop_w.max(crop_h);
    let mut square_img = RgbImage::from_pixel(square_size, square_size, image::Rgb([255, 255, 255]));

    // 3. Center the rectangular crop inside the white square
    let offset_x = (square_size - crop_w) / 2;
    let offset_y = (square_size - crop_h) / 2;

    let raw = img.as_raw();
    let square_raw = square_img.as_mut();

    for y in 0..crop_h {
        let src_row = (((y0 + y as i32) * w) + x0) as usize * 3;
        let dst_y = offset_y + y;
        let dst_row = ((dst_y * square_size + offset_x) as usize) * 3;
        let copy_len = (crop_w * 3) as usize;
        square_raw[dst_row..dst_row + copy_len]
            .copy_from_slice(&raw[src_row..src_row + copy_len]);
    }

    Ok(square_img)
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

fn resize_rgb_fast(crop: &RgbImage, target_size: u32) -> Result<Vec<u8>> {
    let mut resizer = fast_image_resize::Resizer::new();
    let src_image = fast_image_resize::images::ImageRef::new(
        crop.width(),
        crop.height(),
        crop.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )?;
    let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
        target_size,
        target_size,
        vec![0u8; (target_size * target_size * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )?;
    resizer.resize(&src_image, &mut dst_image, None)?;
    Ok(dst_image.buffer().to_vec())
}
