use anyhow::{Context, Result};
use curator_core::ipc::{ImageDetails, TagSummary};
use curator_core::tagger::TaggerEngine;
use curator_core::thumbnail::{self, ThumbnailCache};
use sqlx::SqlitePool;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tracing::info;

use super::common::{resolve_source_id, sort_tags_by_priority};
use super::ImageRow;

pub struct TagImageOutcome {
    pub tags_applied: usize,
    pub skipped: bool,
    pub tags: Vec<TagSummary>,
}

pub async fn tag_image_logic(
    image_id: i64,
    threshold: f32,
    force: bool,
    db: &SqlitePool,
    tagger: &Arc<TaggerEngine>,
) -> Result<TagImageOutcome> {
    let t_start = std::time::Instant::now();

    let t0 = std::time::Instant::now();
    let row: Option<(String,)> =
        sqlx::query_as("SELECT current_filepath FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(db)
            .await?;

    let filepath = match row {
        Some(r) => r.0,
        None => anyhow::bail!("Image {} not found", image_id),
    };
    let db_resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = std::time::Instant::now();
    let camie_source: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:camie-tagger-v2' LIMIT 1")
            .fetch_optional(db)
            .await?;

    if let Some((camie_source_id,)) = camie_source {
        if force {
            sqlx::query("DELETE FROM image_tags WHERE image_id = ? AND source_id = ? AND is_blacklisted = 0")
                .bind(image_id)
                .bind(camie_source_id)
                .execute(db)
                .await?;
            info!(
                "Forced overwrite: wiped existing Camie tags for image {}",
                image_id
            );
        } else {
            let existing: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM image_tags WHERE image_id = ? AND source_id = ? AND is_deleted = 0",
            )
            .bind(image_id)
            .bind(camie_source_id)
            .fetch_one(db)
            .await?;

            if existing.0 > 0 {
                info!(
                    "Image {} already has {} Camie tags — skipping",
                    image_id, existing.0
                );
                return Ok(TagImageOutcome {
                    tags_applied: 0,
                    skipped: true,
                    tags: vec![],
                });
            }
        }
    }
    let db_dedup_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let t2 = std::time::Instant::now();
    let tagger_clone = Arc::clone(tagger);
    let filepath_clone = filepath.clone();
    let predictions =
        tokio::task::spawn_blocking(move || tagger_clone.tag_image(&filepath_clone, threshold))
            .await
            .context("spawn_blocking panicked during Camie inference")??;
    let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

    let t3 = std::time::Instant::now();
    let source_id = resolve_source_id(db, "ai:camie-tagger-v2").await?;

    let transaction_id = uuid::Uuid::new_v4().to_string();

    let blacklisted_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT t.name FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         WHERE it.image_id = ? AND it.is_blacklisted = 1",
    )
    .bind(image_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let blacklisted_names: std::collections::HashSet<String> =
        blacklisted_rows.into_iter().map(|(name,)| name).collect();

    let mut tag_summaries: Vec<TagSummary> = Vec::with_capacity(predictions.len());

    for pred in &predictions {
        if blacklisted_names.contains(&pred.tag) {
            info!("Skipping blacklisted AI tag '{}' for image {}", pred.tag, image_id);
            continue;
        }
        sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
            .bind(&pred.tag)
            .bind(&pred.category)
            .execute(db)
            .await?;

        let tag_row: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
            .bind(&pred.tag)
            .fetch_one(db)
            .await?;
        let tag_id = tag_row.0;

        sqlx::query(
            "INSERT OR REPLACE INTO image_tags
             (image_id, tag_id, source_id, confidence, is_deleted, transaction_id)
             VALUES (?, ?, ?, ?, 0, ?)",
        )
        .bind(image_id)
        .bind(tag_id)
        .bind(source_id)
        .bind(pred.confidence)
        .bind(&transaction_id)
        .execute(db)
        .await?;

        tag_summaries.push(TagSummary {
            tag: pred.tag.clone(),
            category: pred.category.clone(),
            confidence: pred.confidence,
            source_name: Some(curator_core::constants::SOURCE_CAMIE.to_string()),
            is_blacklisted: false,
        });
    }

    info!(
        "Auto-tagged image {} with {} tags (tx: {})",
        image_id,
        tag_summaries.len(),
        &transaction_id[..8]
    );

    let db_write_ms = t3.elapsed().as_secs_f64() * 1000.0;
    let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;
    info!(
        "TagImage {} timing: db_resolve={:.1}ms db_dedup={:.1}ms inference={:.1}ms db_write={:.1}ms total={:.1}ms",
        image_id, db_resolve_ms, db_dedup_ms, inference_ms, db_write_ms, total_ms
    );

    Ok(TagImageOutcome {
        tags_applied: tag_summaries.len(),
        skipped: false,
        tags: tag_summaries,
    })
}

/// Returns (images, total_count). Uses SQL LIMIT/OFFSET — no full table scan.
pub async fn list_images_logic(
    limit: usize,
    offset: usize,
    only_favorites: Option<bool>,
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
        current_filepath: String,
    }

    let page_ids: Vec<IdPath> = sqlx::query_as(
        "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (?1 = 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3",
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
    let images = fetch_image_details_batch(&id_list, db).await?;

    Ok((images, total_count))
}

pub async fn get_image_logic(image_id: i64, db: &SqlitePool) -> Result<ImageDetails> {
    let img: curator_core::db::models::Image =
        sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_one(db)
            .await?;

    let all_tag_rows: Vec<(String, String, f32, Option<String>, bool)> = sqlx::query_as(
        "SELECT t.name, t.category, it.confidence, s.name, (it.is_blacklisted = 1)
         FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         LEFT JOIN sources s ON it.source_id = s.id
         WHERE it.image_id = ? AND (it.is_deleted = 0 OR it.is_blacklisted = 1)",
    )
    .bind(image_id)
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

    sort_tags_by_priority(&mut active_tags);

    let vector_state: String =
        sqlx::query_as("SELECT vector_state FROM image_vectors WHERE image_id = ? LIMIT 1")
            .bind(image_id)
            .fetch_optional(db)
            .await?
            .map(|(s,): (String,)| s)
            .unwrap_or_else(|| "unknown".to_string());

    let parsed_metadata: Option<curator_core::ipc::ParsedMetadata> = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(
        "SELECT match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags, raw_matched
         FROM image_parsed_metadata WHERE image_id = ? LIMIT 1"
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?
    .map(|row| {
        let extracted_tags: Vec<String> = serde_json::from_str(&row.6).unwrap_or_default();
        curator_core::ipc::ParsedMetadata {
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
    })
}

/// Batch-fetch full details for multiple image IDs in 4 queries instead of 4N.
pub async fn batch_get_images_logic(ids: &[i64], db: &SqlitePool) -> Result<Vec<ImageDetails>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    let base_sql = format!(
        "SELECT i.id, i.sha256, i.current_filepath, i.mtime, i.created_at, i.favorite, i.is_missing
         FROM images i
         WHERE i.id IN ({}) AND i.deleted_at IS NULL
         ORDER BY i.created_at DESC, i.id DESC",
        placeholders
    );
    let mut base_q = sqlx::query_as::<_, (i64, String, String, i64, String, bool, bool)>(&base_sql);
    for id in ids {
        base_q = base_q.bind(id);
    }
    let base_rows = base_q.fetch_all(db).await?;

    let mut image_order: Vec<i64> = Vec::new();
    let mut image_map: std::collections::HashMap<i64, ImageDetails> =
        std::collections::HashMap::new();
    for (id, sha256, current_filepath, mtime, created_at, favorite, is_missing) in base_rows {
        image_order.push(id);
        image_map.insert(
            id,
            ImageDetails {
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
            },
        );
    }

    let tag_sql = format!(
        "SELECT it.image_id, t.name, t.category, it.confidence, s.name as source_name, it.is_blacklisted
         FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         LEFT JOIN sources s ON it.source_id = s.id
         WHERE it.image_id IN ({}) AND it.is_deleted = 0",
        placeholders
    );
    let mut tag_q = sqlx::query_as::<_, (i64, String, String, f32, Option<String>, bool)>(&tag_sql);
    for id in ids {
        tag_q = tag_q.bind(id);
    }
    if let Ok(tag_rows) = tag_q.fetch_all(db).await {
        for (image_id, name, category, confidence, source_name, is_blacklisted) in tag_rows {
            if source_name.as_deref() == Some("filename_parser") {
                continue;
            }
            if let Some(img) = image_map.get_mut(&image_id) {
                img.tags.push(TagSummary {
                    tag: name,
                    category,
                    confidence,
                    source_name,
                    is_blacklisted,
                });
            }
        }
    }

    let vec_sql = format!(
        "SELECT image_id, vector_state FROM image_vectors WHERE image_id IN ({})",
        placeholders
    );
    let mut vec_q = sqlx::query_as::<_, (i64, String)>(&vec_sql);
    for id in ids {
        vec_q = vec_q.bind(id);
    }
    if let Ok(vec_rows) = vec_q.fetch_all(db).await {
        for (vid, state) in vec_rows {
            if let Some(img) = image_map.get_mut(&vid) {
                img.vector_state = state;
            }
        }
    }

    let pm_sql = format!(
        "SELECT image_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags, raw_matched
         FROM image_parsed_metadata WHERE image_id IN ({})",
        placeholders
    );
    let mut pm_q = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(&pm_sql);
    for id in ids {
        pm_q = pm_q.bind(id);
    }
    if let Ok(pm_rows) = pm_q.fetch_all(db).await {
        for (img_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags_json, raw_matched) in pm_rows {
            if let Some(img) = image_map.get_mut(&img_id) {
                let extracted_tags: Vec<String> = serde_json::from_str(&extracted_tags_json).unwrap_or_default();
                img.parsed_metadata = Some(curator_core::ipc::ParsedMetadata {
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
    }

    let mut images: Vec<ImageDetails> = Vec::with_capacity(image_order.len());
    for id in image_order {
        if let Some(mut img) = image_map.remove(&id) {
            sort_tags_by_priority(&mut img.tags);
            images.push(img);
        }
    }
    Ok(images)
}

/// Fetch full details for a batch of image IDs (used by list_images_logic page results).
async fn fetch_image_details_batch(ids: &[i64], db: &SqlitePool) -> Result<Vec<ImageDetails>> {
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        r#"
        SELECT i.id, i.sha256, i.current_filepath, i.mtime, i.created_at, i.favorite, i.is_missing,
               t.name, t.category, it.confidence, s.name as source_name
        FROM images i
        LEFT JOIN image_tags it ON it.image_id = i.id AND it.is_deleted = 0
        LEFT JOIN tags t ON it.tag_id = t.id
        LEFT JOIN sources s ON it.source_id = s.id
        WHERE i.id IN ({})
        ORDER BY i.created_at DESC, i.id DESC
        "#,
        placeholders
    );
    let mut q = sqlx::query_as::<_, ImageRow>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows: Vec<ImageRow> = q.fetch_all(db).await?;

    let mut image_order: Vec<i64> = Vec::new();
    let mut image_map: std::collections::HashMap<i64, ImageDetails> =
        std::collections::HashMap::new();
    for (
        id,
        sha256,
        current_filepath,
        mtime,
        created_at,
        favorite,
        is_missing,
        tag_name,
        tag_category,
        confidence,
        source_name,
    ) in rows
    {
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
        });
        if let (Some(name), Some(category)) = (tag_name, tag_category) {
            if source_name.as_deref() != Some("filename_parser") {
                entry.tags.push(TagSummary {
                    tag: name,
                    category,
                    confidence: confidence.unwrap_or(0.0),
                    source_name: source_name.clone(),
                    is_blacklisted: false,
                });
            }
        }
    }

    let img_ids: Vec<i64> = image_map.keys().copied().collect();
    if !img_ids.is_empty() {
        let ph = img_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

        let vq = format!(
            "SELECT image_id, vector_state FROM image_vectors WHERE image_id IN ({})",
            ph
        );
        let mut vq = sqlx::query_as::<_, (i64, String)>(&vq);
        for id in &img_ids {
            vq = vq.bind(id);
        }
        if let Ok(vrows) = vq.fetch_all(db).await {
            for (vid, state) in vrows {
                if let Some(img) = image_map.get_mut(&vid) {
                    img.vector_state = state;
                }
            }
        }

        let pm_query = format!(
            "SELECT image_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags, raw_matched
             FROM image_parsed_metadata WHERE image_id IN ({})",
            ph
        );
        let mut pm_q = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, String)>(&pm_query);
        for id in &img_ids {
            pm_q = pm_q.bind(id);
        }
        if let Ok(pm_rows) = pm_q.fetch_all(db).await {
            for (img_id, match_type, artist, pixiv_id, twitter_id, timestamp_4chan, datetime_iso, extracted_tags_json, raw_matched) in pm_rows {
                if let Some(img) = image_map.get_mut(&img_id) {
                    let extracted_tags: Vec<String> = serde_json::from_str(&extracted_tags_json).unwrap_or_default();
                    img.parsed_metadata = Some(curator_core::ipc::ParsedMetadata {
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
        }
    }

    let mut images: Vec<ImageDetails> = Vec::with_capacity(image_order.len());
    for id in image_order {
        if let Some(mut img) = image_map.remove(&id) {
            sort_tags_by_priority(&mut img.tags);
            images.push(img);
        }
    }
    Ok(images)
}

pub async fn get_thumbnail_logic(
    image_id: i64,
    width: u32,
    cache: &ThumbnailCache,
    db: &SqlitePool,
) -> Result<(Option<Vec<u8>>, bool)> {
    if let Some(cached) = cache.get(image_id).await {
        return Ok((Some(cached), false));
    }

    let row: Option<(String, i64, bool)> = sqlx::query_as(
        "SELECT current_filepath, mtime, is_missing FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?;

    let (filepath, _mtime, is_missing) = match row {
        Some(r) => r,
        None => return Ok((None, true)),
    };

    if is_missing || !Path::new(&filepath).exists() {
        return Ok((None, true));
    }

    let thumb_path: std::path::PathBuf = filepath.into();
    match tokio::task::spawn_blocking(move || thumbnail::generate_thumbnail(&thumb_path, width))
        .await
    {
        Ok(Ok(webp_bytes)) => {
            let _ = cache.put(image_id, width, &webp_bytes).await;
            Ok((Some(webp_bytes), false))
        }
        _ => Ok((None, true)),
    }
}

pub async fn purge_missing_thumbnails_logic(
    cache: &ThumbnailCache,
    db: &SqlitePool,
) -> Result<i64> {
    let missing_ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM images WHERE is_missing = 1")
        .fetch_all(db)
        .await?;

    let ids: Vec<i64> = missing_ids.into_iter().map(|(id,)| id).collect();
    let deleted = cache.purge_missing(&ids).await?;
    Ok(deleted as i64)
}

pub async fn get_featured_image(db: &SqlitePool, data_dir: &Path) -> Option<ImageDetails> {
    let today_str = {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let day_number = secs / 86400;
        format!("day_{}", day_number)
    };

    let featured_file = data_dir.join("featured_of_the_day.txt");

    if let Ok(content) = fs::read_to_string(&featured_file) {
        let parts: Vec<&str> = content.trim().splitn(2, '|').collect();
        if parts.len() == 2 && parts[0] == today_str {
            if let Ok(id) = parts[1].parse::<i64>() {
                if let Ok(img) = get_image_logic(id, db).await {
                    if std::path::Path::new(&img.current_filepath).exists() {
                        return Some(img);
                    }
                }
            }
        }
    }

    if let Ok(Some((rand_id,))) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY RANDOM() LIMIT 1",
    )
    .fetch_optional(db)
    .await
    {
        if let Ok(img) = get_image_logic(rand_id, db).await {
            if std::path::Path::new(&img.current_filepath).exists() {
                let _ = fs::write(&featured_file, format!("{}|{}", today_str, rand_id));
                return Some(img);
            }
        }
    }

    None
}
