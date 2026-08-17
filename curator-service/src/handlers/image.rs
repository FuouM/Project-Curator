use anyhow::{Context, Result};
use curator_core::ipc::{ImageDetails, TagSummary};
use curator_core::tagger::TaggerEngine;
use curator_core::thumbnail::{self, ThumbnailCache};
use sqlx::SqlitePool;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tracing::info;

use super::common::{resolve_source_id, upsert_tag_id};

pub struct TagImageOutcome {
    pub tags_applied: usize,
    pub skipped: bool,
    pub tags: Vec<TagSummary>,
}

pub struct BackfillOutcome {
    pub processed: usize,
    pub failed: usize,
    pub skipped: usize,
}

pub async fn tag_image_logic(
    image_id: i64,
    threshold: f32,
    force: bool,
    db: &SqlitePool,
    tagger: &Arc<TaggerEngine>,
) -> Result<TagImageOutcome> {
    let t_start = std::time::Instant::now();
    let source_name = tagger.spec().source_name;

    let t0 = std::time::Instant::now();
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT current_filepath, video_frame_path FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?;

    let (current_filepath, video_frame_path) = match row {
        Some(r) => r,
        None => anyhow::bail!("Image {} not found", image_id),
    };
    let filepath = curator_core::video::decode_path(&current_filepath, video_frame_path.as_deref())
        .to_string_lossy()
        .into_owned();
    let db_resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = std::time::Instant::now();
    let tagger_source: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
            .bind(source_name)
            .fetch_optional(db)
            .await?;

    if let Some((tagger_source_id,)) = tagger_source {
        if force {
            sqlx::query("DELETE FROM image_tags WHERE image_id = ? AND source_id = ? AND is_blacklisted = 0")
                .bind(image_id)
                .bind(tagger_source_id)
                .execute(db)
                .await?;
            info!(
                "Forced overwrite: wiped existing {} tags for image {}",
                source_name, image_id
            );
        } else {
            let existing: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM image_tags WHERE image_id = ? AND source_id = ? AND is_deleted = 0",
            )
            .bind(image_id)
            .bind(tagger_source_id)
            .fetch_one(db)
            .await?;

            if existing.0 > 0 {
                info!(
                    "Image {} already has {} {} tags — skipping",
                    image_id, existing.0, source_name
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
    let tagger_name = tagger.spec().display_name.to_string();
    let predictions =
        tokio::task::spawn_blocking(move || tagger_clone.tag_image(&filepath_clone, threshold))
            .await
            .context(format!(
                "spawn_blocking panicked during {} inference",
                tagger_name
            ))??;
    let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

    let t3 = std::time::Instant::now();
    let source_id = resolve_source_id(db, source_name).await?;

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

    // All per-tag writes in one transaction. Categories are never upserted —
    // the first-inserted category wins.
    let mut tx = db.begin().await?;
    for pred in &predictions {
        if blacklisted_names.contains(&pred.tag) {
            info!(
                "Skipping blacklisted AI tag '{}' for image {}",
                pred.tag, image_id
            );
            continue;
        }
        let tag_id = upsert_tag_id(&mut tx, &pred.tag, &pred.category).await?;

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
        .execute(&mut *tx)
        .await?;

        tag_summaries.push(TagSummary {
            tag: pred.tag.clone(),
            category: pred.category.clone(),
            confidence: pred.confidence,
            source_name: Some(source_name.to_string()),
            is_blacklisted: false,
        });
    }
    tx.commit().await?;

    info!(
        "Auto-tagged image {} with {} {} tags (tx: {})",
        image_id,
        tag_summaries.len(),
        source_name,
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

/// Backfill `to_tagger` onto every image already tagged by `from_tagger`.
///
/// The work set is the from-tagger's active rows (`DISTINCT image_id`), so the
/// exact same image corpus receives `to_tagger` rows and no feature loses its
/// images when the preference is switched. Uses `force=false` for idempotency:
/// already-backfilled images are skipped. Fails fast if `to_tagger`'s model is
/// missing (no silent fallbacks).
pub async fn backfill_tag_source_logic(
    db: &SqlitePool,
    from_source: &str,
    to_source: &str,
    to_engine: &Arc<TaggerEngine>,
    threshold: f32,
) -> Result<BackfillOutcome> {
    if from_source == to_source {
        anyhow::bail!("from_tagger and to_tagger must differ");
    }

    // Fail fast (no fallbacks): the destination model must be usable.
    let to_model = to_engine.model_path();
    if !to_model.exists() {
        anyhow::bail!(
            "{} model file missing at {:?}. Convert/download it before backfilling.",
            to_engine.spec().display_name,
            to_model
        );
    }

    let from_source_id = resolve_source_id(db, from_source).await?;
    let image_ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT DISTINCT image_id FROM image_tags
         WHERE source_id = ? AND is_deleted = 0 ORDER BY image_id",
    )
    .bind(from_source_id)
    .fetch_all(db)
    .await?;

    let mut processed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;

    for (image_id,) in image_ids {
        match tag_image_logic(image_id, threshold, false, db, to_engine).await {
            Ok(outcome) => {
                if outcome.skipped {
                    skipped += 1;
                } else {
                    processed += 1;
                }
            }
            Err(e) => {
                warn_scoped(
                    "BackfillTagSource",
                    format!(
                        "failed for image {} ({}) with {}: {:?}",
                        image_id,
                        to_source,
                        to_engine.spec().display_name,
                        e
                    ),
                );
                failed += 1;
            }
        }
    }

    info!(
        "Backfill {} -> {} complete: processed={} failed={} skipped={}",
        from_source, to_source, processed, failed, skipped
    );

    Ok(BackfillOutcome {
        processed,
        failed,
        skipped,
    })
}

fn warn_scoped(scope: &str, msg: String) {
    tracing::warn!("{} {}", scope, msg);
}

pub async fn get_image_logic(
    image_id: i64,
    preferred_source: &str,
    vector_source: &str,
    db: &SqlitePool,
) -> Result<ImageDetails> {
    curator_core::ImageRepo::get_image(image_id, preferred_source, vector_source, db).await
}

pub async fn batch_get_images_logic(
    ids: &[i64],
    preferred_source: &str,
    vector_source: &str,
    db: &SqlitePool,
) -> Result<Vec<ImageDetails>> {
    curator_core::ImageRepo::batch_get_images(ids, preferred_source, vector_source, db).await
}

pub async fn list_images_logic(
    limit: usize,
    offset: usize,
    only_favorites: Option<bool>,
    preferred_source: &str,
    vector_source: &str,
    db: &SqlitePool,
) -> Result<(Vec<ImageDetails>, i64)> {
    curator_core::ImageRepo::list_images(
        limit,
        offset,
        only_favorites,
        preferred_source,
        vector_source,
        db,
    )
    .await
}

pub async fn get_thumbnail_logic(
    image_id: i64,
    width: u32,
    mtime: Option<i64>,
    kind: Option<u8>,
    cache: &ThumbnailCache,
    db: &SqlitePool,
) -> Result<(Option<Vec<u8>>, bool)> {
    let target_kind = kind.unwrap_or(thumbnail::THUMB_KIND_STATIC);

    // 1. Short-circuit: Check thumbnail cache FIRST using provided mtime
    if let Some(m) = mtime {
        if m > 0 {
            if let Some(cached) = cache.get(image_id, width, m, target_kind).await {
                return Ok((Some(cached), false));
            }
        }
    }

    let row: Option<(String, i64, bool, Option<String>)> = sqlx::query_as(
        "SELECT current_filepath, mtime, is_missing, video_frame_path FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?;

    let (filepath, db_mtime, is_missing, video_frame_path) = match row {
        Some(r) => r,
        None => return Ok((None, true)),
    };

    if is_missing || !Path::new(&filepath).exists() {
        return Ok((None, true));
    }

    // Cache is keyed on (image_id, width, mtime, kind) so a replaced file with the
    // same path never serves a stale thumbnail and a width change never serves
    // a wrong-size blob.
    if let Some(cached) = cache.get(image_id, width, db_mtime, target_kind).await {
        return Ok((Some(cached), false));
    }

    // Videos are hashed/probed against their cached first-frame PNG so the
    // thumbnail pipeline always decodes decodable pixels.
    let thumb_path: std::path::PathBuf = match video_frame_path {
        Some(frame) if Path::new(&frame).exists() => frame.into(),
        _ => filepath.into(),
    };
    match tokio::task::spawn_blocking(move || thumbnail::generate_thumbnail(&thumb_path, width))
        .await
    {
        Ok(Ok(webp_bytes)) => {
            let _ = cache
                .put(image_id, width, db_mtime, target_kind, &webp_bytes)
                .await;
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

pub async fn clear_thumbnails_logic(cache: &ThumbnailCache) -> Result<i64> {
    let deleted = cache.clear().await?;
    Ok(deleted as i64)
}

pub async fn get_featured_image(
    db: &SqlitePool,
    data_dir: &Path,
    preferred_source: &str,
    vector_source: &str,
) -> Option<ImageDetails> {
    let today_str = {
        let secs = curator_core::util::now_secs();
        let day_number = secs / 86400;
        format!("day_{}", day_number)
    };

    let featured_file = data_dir.join("featured_of_the_day.txt");

    if let Ok(content) = fs::read_to_string(&featured_file) {
        let parts: Vec<&str> = content.trim().splitn(2, '|').collect();
        if parts.len() == 2 && parts[0] == today_str {
            if let Ok(id) = parts[1].parse::<i64>() {
                if let Ok(img) = get_image_logic(id, preferred_source, vector_source, db).await {
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
        if let Ok(img) = get_image_logic(rand_id, preferred_source, vector_source, db).await {
            if std::path::Path::new(&img.current_filepath).exists() {
                let _ = fs::write(&featured_file, format!("{}|{}", today_str, rand_id));
                return Some(img);
            }
        }
    }

    None
}

/// Returns a random image and its position index (0-based) in the gallery order.
pub async fn get_random_image_logic(
    db: &SqlitePool,
    preferred_source: &str,
    vector_source: &str,
) -> Result<(ImageDetails, i64)> {
    // Pick a random image
    let rand_row: (i64, String) = sqlx::query_as(
        "SELECT id, created_at FROM images WHERE deleted_at IS NULL AND is_missing = 0 ORDER BY RANDOM() LIMIT 1",
    )
    .fetch_one(db)
    .await?;

    let rand_id = rand_row.0;
    let rand_created_at = &rand_row.1;

    // Count how many images come before it in gallery order (created_at DESC, id DESC)
    let pos: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (created_at > ?1 OR (created_at = ?1 AND id > ?2))",
    )
    .bind(rand_created_at)
    .bind(rand_id)
    .fetch_one(db)
    .await?;

    let img = get_image_logic(rand_id, preferred_source, vector_source, db).await?;
    Ok((img, pos.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_batch_get_images_logic() -> Result<()> {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("../curator-db/migrations")
            .run(&pool)
            .await?;

        // Insert a test image
        sqlx::query(
            "INSERT INTO images (id, sha256, current_filepath, mtime, created_at) VALUES (101, 'testsha', 'C:/test.png', 1000, '2026-08-13')",
        )
        .execute(&pool)
        .await?;

        // Insert default source
        sqlx::query("INSERT INTO sources (id, name, type) VALUES (1, 'user', 'user')")
            .execute(&pool)
            .await?;

        // Insert tag and image_tag
        sqlx::query("INSERT INTO tags (id, name, category) VALUES (201, 'testtag', 'general')")
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_blacklisted) VALUES (101, 201, 1, 0.95, 0)")
            .execute(&pool)
            .await?;

        let details = batch_get_images_logic(&[101], "user", "user", &pool).await?;
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].id, 101);
        assert_eq!(details[0].tags.len(), 1);
        assert_eq!(details[0].tags[0].tag, "testtag");
        assert_eq!(details[0].tags[0].category, "general");

        Ok(())
    }
}
