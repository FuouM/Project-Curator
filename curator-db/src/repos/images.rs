use anyhow::Result;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;

use crate::models::{
    AnimationSummary, CharacterIdentitySummary, Image, ImageDetails, ParsedMetadata,
    StorageStats, StorageTypeStat, TagSummary, VideoSummary,
};
use super::sources::SourceRepo;

pub struct ImageRepo;

impl ImageRepo {
    /// Sort tags by category priority: user / custom concepts first, then character, copyright, meta, general.
    pub fn sort_tags_by_priority(tags: &mut [TagSummary]) {
        tags.sort_by(|a, b| {
            let priority = |t: &TagSummary| -> i32 {
                if t.source_name.as_deref() == Some("ai:custom-concepts") || t.category == "user" {
                    -1
                } else {
                    match t.category.as_str() {
                        "character" => 1,
                        "copyright" => 2,
                        "meta" => 3,
                        _ => 4,
                    }
                }
            };

            let p_a = priority(a);
            let p_b = priority(b);

            if p_a != p_b {
                p_a.cmp(&p_b)
            } else {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }
        });
    }

    /// Batch-fetch animated media metadata for image IDs.
    pub async fn fetch_animation_metadata_batch(
        ids: &[i64],
        db: &SqlitePool,
    ) -> HashMap<i64, AnimationSummary> {
        let mut map = HashMap::new();
        if ids.is_empty() {
            return map;
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT image_id, format, frame_count, duration_ms, loop_count, is_animated
             FROM image_animation_metadata WHERE image_id IN ({})",
            placeholders
        );
        let mut q = sqlx::query_as::<_, (i64, String, i64, i64, Option<i64>, bool)>(&sql);
        for id in ids {
            q = q.bind(id);
        }
        if let Ok(rows) = q.fetch_all(db).await {
            for (image_id, format, frame_count, duration_ms, loop_count, is_animated) in rows {
                map.insert(
                    image_id,
                    AnimationSummary {
                        format,
                        frame_count,
                        duration_ms,
                        loop_count,
                        is_animated,
                    },
                );
            }
        }
        map
    }

    /// Batch-fetch video metadata for image IDs.
    pub async fn fetch_video_metadata_batch(
        ids: &[i64],
        db: &SqlitePool,
    ) -> HashMap<i64, VideoSummary> {
        let mut map = HashMap::new();
        if ids.is_empty() {
            return map;
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT image_id, format, duration_ms, fps, video_codec, audio_codec, bitrate, width, height
             FROM video_media_metadata WHERE image_id IN ({})",
            placeholders
        );
        let mut q = sqlx::query_as::<_, (i64, String, i64, f64, String, Option<String>, Option<i64>, Option<i64>, Option<i64>)>(&sql);
        for id in ids {
            q = q.bind(id);
        }
        if let Ok(rows) = q.fetch_all(db).await {
            for (image_id, format, duration_ms, fps, video_codec, audio_codec, bitrate, width, height) in rows {
                map.insert(
                    image_id,
                    VideoSummary {
                        format,
                        duration_ms,
                        fps,
                        video_codec,
                        audio_codec,
                        bitrate,
                        width,
                        height,
                    },
                );
            }
        }
        map
    }

    /// Fetch single image details with tags, character detections, OCR, and media info.
    pub async fn get_image(
        image_id: i64,
        preferred_source: &str,
        db: &SqlitePool,
    ) -> Result<ImageDetails> {
        let img: Image = sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_one(db)
            .await?;

        let source_id = SourceRepo::resolve_source_id(db, preferred_source).await?;

        let all_tag_rows: Vec<(String, String, f32, Option<String>, bool)> = sqlx::query_as(
            "SELECT t.name, t.category, it.confidence, s.name, (it.is_blacklisted = 1)
             FROM image_tags it
             JOIN tags t ON it.tag_id = t.id
             LEFT JOIN sources s ON it.source_id = s.id
             WHERE it.image_id = ? AND it.source_id = ? AND (it.is_deleted = 0 OR it.is_blacklisted = 1)",
        )
        .bind(image_id)
        .bind(source_id)
        .fetch_all(db)
        .await?;

        let mut active_tags = Vec::new();
        let mut blacklisted_tags = Vec::new();

        for (tag, category, confidence, source_name, is_blacklisted) in all_tag_rows {
            if source_name.as_deref() == Some("filename_parser") {
                continue;
            }

            let summary = TagSummary {
                tag,
                category,
                confidence,
                source_name,
                is_blacklisted,
            };

            if is_blacklisted {
                blacklisted_tags.push(summary);
            } else {
                active_tags.push(summary);
            }
        }

        Self::sort_tags_by_priority(&mut active_tags);

        let vector_state: String =
            sqlx::query_as("SELECT vector_state FROM image_vectors WHERE image_id = ? LIMIT 1")
                .bind(image_id)
                .fetch_optional(db)
                .await?
                .map(|(s,): (String,)| s)
                .unwrap_or_else(|| "unknown".to_string());

        let parsed_metadata: Option<ParsedMetadata> = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
            "SELECT match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags, raw_matched
             FROM image_parsed_metadata WHERE image_id = ? LIMIT 1"
        )
        .bind(image_id)
        .fetch_optional(db)
        .await?
        .map(|row| {
            let extracted_tags: Vec<String> = serde_json::from_str(&row.6).unwrap_or_default();
            ParsedMetadata {
                match_type: row.0,
                artist: row.1,
                pixiv_id: row.2,
                twitter_id: row.3,
                timestamp_4chan: row.4,
                datetime_iso: row.5,
                extracted_tags,
                raw_matched: row.7,
                partial: false,
            }
        });

        let character_identities: Vec<CharacterIdentitySummary> = sqlx::query_as::<_, (i64, String)>(
            "SELECT ci.id, ci.name
             FROM character_detections cd
             JOIN character_identities ci ON cd.identity_id = ci.id
             WHERE cd.image_id = ? AND cd.identity_id IS NOT NULL
             GROUP BY ci.id"
        )
        .bind(image_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|(id, name)| CharacterIdentitySummary { id, name })
        .collect();

        let ocr_text: Option<String> = sqlx::query_scalar::<_, String>(
            "SELECT GROUP_CONCAT(text, CHAR(10)) FROM image_ocr_detections WHERE image_id = ?"
        )
        .bind(image_id)
        .fetch_optional(db)
        .await?;

        let animation = Self::fetch_animation_metadata_batch(&[image_id], db)
            .await
            .remove(&image_id);

        let video = Self::fetch_video_metadata_batch(&[image_id], db)
            .await
            .remove(&image_id);

        Ok(ImageDetails {
            id: img.id,
            sha256: img.sha256,
            current_filepath: img.current_filepath,
            mtime: img.mtime,
            created_at: img.created_at.to_string(),
            tags: active_tags,
            blacklisted_tags,
            vector_state,
            favorite: img.favorite,
            parsed_metadata,
            is_missing: img.is_missing,
            character_identities,
            ocr_text,
            width: img.width,
            height: img.height,
            animation,
            video,
            note: img.note,
            safe_score: img.safe_score,
            hentai_score: img.hentai_score,
            porn_score: img.porn_score,
            sexy_score: img.sexy_score,
            drawing_score: img.drawing_score,
        })
    }

    /// Fetch full details for a batch of image IDs in a single round-trip.
    pub async fn batch_get_images(
        ids: &[i64],
        preferred_source: &str,
        db: &SqlitePool,
    ) -> Result<Vec<ImageDetails>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let source_id = SourceRepo::resolve_source_id(db, preferred_source).await?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

        #[derive(sqlx::FromRow)]
        struct BatchImageRow {
            id: i64,
            sha256: String,
            current_filepath: String,
            mtime: i64,
            created_at: String,
            favorite: bool,
            is_missing: bool,
            width: Option<i64>,
            height: Option<i64>,
            safe_score: Option<f32>,
            hentai_score: Option<f32>,
            porn_score: Option<f32>,
            sexy_score: Option<f32>,
            drawing_score: Option<f32>,
            note: Option<String>,
            tag_name: Option<String>,
            tag_category: Option<String>,
            confidence: Option<f32>,
            source_name: Option<String>,
            is_blacklisted: bool,
        }

        let sql = format!(
            r#"
            SELECT i.id, i.sha256, i.current_filepath, i.mtime, i.created_at, i.favorite, i.is_missing,
                   i.width, i.height,
                   i.safe_score, i.hentai_score, i.porn_score, i.sexy_score, i.drawing_score,
                   i.note,
                   t.name AS tag_name, t.category AS tag_category, it.confidence, s.name as source_name, COALESCE(it.is_blacklisted, 0) AS is_blacklisted
            FROM images i
            LEFT JOIN image_tags it ON it.image_id = i.id AND it.is_deleted = 0 AND it.source_id = {source_id}
            LEFT JOIN tags t ON it.tag_id = t.id
            LEFT JOIN sources s ON it.source_id = s.id
            WHERE i.id IN ({}) AND i.deleted_at IS NULL
            ORDER BY i.created_at DESC, i.id DESC
            "#,
            placeholders,
            source_id = source_id
        );
        let mut q = sqlx::query_as::<_, BatchImageRow>(&sql);
        for id in ids {
            q = q.bind(id);
        }
        let rows = q.fetch_all(db).await?;

        let mut image_order: Vec<i64> = Vec::new();
        let mut image_map: HashMap<i64, ImageDetails> = HashMap::new();
        for r in rows {
            let BatchImageRow {
                id,
                sha256,
                current_filepath,
                mtime,
                created_at,
                favorite,
                is_missing,
                width,
                height,
                safe_score,
                hentai_score,
                porn_score,
                sexy_score,
                drawing_score,
                note,
                tag_name,
                tag_category,
                confidence,
                source_name,
                is_blacklisted,
            } = r;
            if !image_map.contains_key(&id) {
                image_order.push(id);
            }
            let entry = image_map.entry(id).or_insert_with(|| ImageDetails {
                id,
                sha256,
                current_filepath,
                mtime,
                created_at,
                tags: Vec::new(),
                blacklisted_tags: Vec::new(),
                vector_state: String::new(),
                favorite,
                parsed_metadata: None,
                is_missing,
                character_identities: Vec::new(),
                ocr_text: None,
                width,
                height,
                animation: None,
                video: None,
                note,
                safe_score,
                hentai_score,
                porn_score,
                sexy_score,
                drawing_score,
            });
            if let (Some(name), Some(category)) = (tag_name, tag_category) {
                if source_name.as_deref() != Some("filename_parser") {
                    entry.tags.push(TagSummary {
                        tag: name,
                        category,
                        confidence: confidence.unwrap_or(0.0),
                        source_name: source_name.clone(),
                        is_blacklisted,
                    });
                }
            }
        }

        let img_ids: Vec<i64> = image_map.keys().copied().collect();
        if !img_ids.is_empty() {
            let ph = img_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

            let vq_future = async {
                let vq = format!(
                    "SELECT image_id, vector_state FROM image_vectors WHERE image_id IN ({})",
                    ph
                );
                let mut q = sqlx::query_as::<_, (i64, String)>(&vq);
                for id in &img_ids {
                    q = q.bind(id);
                }
                q.fetch_all(db).await.unwrap_or_default()
            };

            let pm_future = async {
                let pm_query = format!(
                    "SELECT image_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags, raw_matched
                     FROM image_parsed_metadata WHERE image_id IN ({})",
                    ph
                );
                let mut q = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(&pm_query);
                for id in &img_ids {
                    q = q.bind(id);
                }
                q.fetch_all(db).await.unwrap_or_default()
            };

            let ci_future = async {
                let ci_query = format!(
                    "SELECT DISTINCT cd.image_id, ci.id, ci.name
                     FROM character_detections cd
                     JOIN character_identities ci ON cd.identity_id = ci.id
                     WHERE cd.image_id IN ({}) AND cd.identity_id IS NOT NULL",
                    ph
                );
                let mut q = sqlx::query_as::<_, (i64, i64, String)>(&ci_query);
                for id in &img_ids {
                    q = q.bind(id);
                }
                q.fetch_all(db).await.unwrap_or_default()
            };

            let ocr_future = async {
                let ocr_query = format!(
                    "SELECT image_id, GROUP_CONCAT(text, CHAR(10)) FROM image_ocr_detections WHERE image_id IN ({}) GROUP BY image_id",
                    ph
                );
                let mut q = sqlx::query_as::<_, (i64, String)>(&ocr_query);
                for id in &img_ids {
                    q = q.bind(id);
                }
                q.fetch_all(db).await.unwrap_or_default()
            };

            let anim_future = Self::fetch_animation_metadata_batch(&img_ids, db);
            let video_future = Self::fetch_video_metadata_batch(&img_ids, db);

            let (vrows, pm_rows, ci_rows, ocr_rows, anim_rows, video_rows) =
                tokio::join!(vq_future, pm_future, ci_future, ocr_future, anim_future, video_future);

            for (vid, state) in vrows {
                if let Some(img) = image_map.get_mut(&vid) {
                    img.vector_state = state;
                }
            }

            for (img_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags_json, raw_matched) in pm_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    let extracted_tags: Vec<String> = serde_json::from_str(&extracted_tags_json).unwrap_or_default();
                    img.parsed_metadata = Some(ParsedMetadata {
                        match_type,
                        artist,
                        pixiv_id,
                        twitter_id,
                        timestamp_4chan,
                        datetime_iso,
                        extracted_tags,
                        raw_matched,
                        partial: false,
                    });
                }
            }

            for (img_id, identity_id, identity_name) in ci_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    img.character_identities.push(CharacterIdentitySummary {
                        id: identity_id,
                        name: identity_name,
                    });
                }
            }

            for (img_id, text) in ocr_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    img.ocr_text = Some(text);
                }
            }

            for (img_id, animation) in anim_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    img.animation = Some(animation);
                }
            }

            for (img_id, video) in video_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    img.video = Some(video);
                }
            }
        }

        let mut images: Vec<ImageDetails> = Vec::with_capacity(image_order.len());
        for id in image_order {
            if let Some(mut img) = image_map.remove(&id) {
                Self::sort_tags_by_priority(&mut img.tags);
                images.push(img);
            }
        }
        Ok(images)
    }

    /// List paginated images with total count.
    pub async fn list_images(
        limit: usize,
        offset: usize,
        only_favorites: Option<bool>,
        preferred_source: &str,
        db: &SqlitePool,
    ) -> Result<(Vec<ImageDetails>, i64)> {
        let only_favs = only_favorites.unwrap_or(false);
        let fav_bind = if only_favs { 1i64 } else { 0i64 };

        let count_row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (?1 = 0 OR favorite = 1)",
        )
        .bind(fav_bind)
        .fetch_one(db)
        .await?;
        let total_count = count_row.0;

        if total_count == 0 || offset as i64 >= total_count {
            return Ok((Vec::new(), total_count));
        }

        #[derive(Debug, sqlx::FromRow)]
        struct IdPath {
            id: i64,
        }

        let page_ids: Vec<IdPath> = sqlx::query_as(
            "SELECT id FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (?1 = 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3",
        )
        .bind(fav_bind)
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(db)
        .await?;

        if page_ids.is_empty() {
            return Ok((Vec::new(), total_count));
        }

        let id_list: Vec<i64> = page_ids.iter().map(|r| r.id).collect();
        let images = Self::batch_get_images(&id_list, preferred_source, db).await?;

        Ok((images, total_count))
    }

    /// Set favorite status for an image.
    pub async fn set_favorite(db: &SqlitePool, image_id: i64, favorite: bool) -> Result<()> {
        let fav_val = if favorite { 1 } else { 0 };
        sqlx::query("UPDATE images SET favorite = ? WHERE id = ?")
            .bind(fav_val)
            .bind(image_id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// Set user note for an image.
    pub async fn set_note(db: &SqlitePool, image_id: i64, note: Option<String>) -> Result<()> {
        sqlx::query("UPDATE images SET note = ? WHERE id = ?")
            .bind(note)
            .bind(image_id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// Fetch a random image.
    pub async fn get_random_image(
        db: &SqlitePool,
        preferred_source: &str,
    ) -> Result<(ImageDetails, i64)> {
        let count_row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM images WHERE deleted_at IS NULL AND is_missing = 0")
                .fetch_one(db)
                .await?;
        let total_count = count_row.0;

        if total_count == 0 {
            anyhow::bail!("No images found in library");
        }

        let (image_id,): (i64,) = sqlx::query_as(
            "SELECT id FROM images WHERE deleted_at IS NULL AND is_missing = 0 ORDER BY RANDOM() LIMIT 1",
        )
        .fetch_one(db)
        .await?;

        let details = Self::get_image(image_id, preferred_source, db).await?;
        Ok((details, total_count))
    }

    /// Get featured image for dashboard.
    pub async fn get_featured_image(
        db: &SqlitePool,
        preferred_source: &str,
    ) -> Option<ImageDetails> {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM images
             WHERE deleted_at IS NULL AND is_missing = 0
             ORDER BY favorite DESC, created_at DESC
             LIMIT 1",
        )
        .fetch_optional(db)
        .await
        .ok()?;

        if let Some((id,)) = row {
            Self::get_image(id, preferred_source, db).await.ok()
        } else {
            None
        }
    }

    /// Compute storage statistics broken down by file extension / category.
    pub async fn get_storage_stats(db: &SqlitePool) -> Result<StorageStats> {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT current_filepath, video_frame_path FROM images WHERE deleted_at IS NULL AND is_missing = 0",
        )
        .fetch_all(db)
        .await?;

        let mut counts: HashMap<String, (u64, u64)> = HashMap::new();

        for (filepath, _video_frame_path) in rows {
            let path = Path::new(&filepath);
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_else(|| "unknown".to_string());

            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

            let entry = counts.entry(ext).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += size;
        }

        let mut stats: Vec<StorageTypeStat> = counts
            .into_iter()
            .map(|(ext, (count, size))| {
                let category = match ext.as_str() {
                    "jpg" | "jpeg" | "png" | "webp" | "bmp" | "avif" | "jxl" => "Images",
                    "gif" => "GIFs",
                    "mp4" | "webm" | "mov" | "mkv" | "avi" => "Videos",
                    _ => "Other",
                }
                .to_string();

                StorageTypeStat {
                    category,
                    extension: ext,
                    size_bytes: size,
                    count,
                }
            })
            .collect();

        stats.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        Ok(StorageStats { stats })
    }
}
