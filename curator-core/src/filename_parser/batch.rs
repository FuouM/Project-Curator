use super::types::{BatchExecutionResult, BatchParseState, BatchPreviewItem, TokenBlock};
use super::FilenameParser;
use anyhow::Result;
use futures_util::stream::TryStreamExt;
use sqlx::SqlitePool;

/// Preview batch parsing results on database images
pub async fn preview_batch(
    pool: &SqlitePool,
    limit: usize,
    pattern_or_type: &str,
    rule_type: &str,
    token_config: Option<&[TokenBlock]>,
    output_match_type: Option<&str>,
) -> Result<Vec<BatchPreviewItem>> {
    let mut rows = sqlx::query_as::<_, (i64, String)>(
        "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?",
    )
    .bind(limit as i64)
    .fetch(pool);

    let mut items = Vec::new();
    while let Some(row) = rows.try_next().await? {
        let (id, current_filepath) = row;
        let filename = std::path::Path::new(&current_filepath)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(&current_filepath)
            .to_string();

        let match_res = FilenameParser::test_filename(
            &filename,
            pattern_or_type,
            rule_type,
            token_config,
        )
        .map(|m| super::token_builder::apply_match_type_override(m, output_match_type));

        items.push(BatchPreviewItem {
            image_id: id,
            filename,
            filepath: current_filepath,
            match_result: match_res,
        });
    }

    Ok(items)
}

/// Execute batch filename parsing and save to DB
pub async fn run_batch(
    pool: &SqlitePool,
    pattern_or_type: &str,
    rule_type: &str,
    token_config: Option<&[TokenBlock]>,
    output_match_type: Option<&str>,
) -> Result<BatchExecutionResult> {
    // Ensure source exists for filename_parser
    let source: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM sources WHERE name = 'filename_parser'",
    )
    .fetch_optional(pool)
    .await?;

    let source_id = match source {
        Some((id,)) => id,
        None => {
            let res = sqlx::query(
                "INSERT INTO sources (name, type, manifest) VALUES ('filename_parser', 'builtin', '{}')",
            )
            .execute(pool)
            .await?;
            res.last_insert_rowid()
        }
    };

    let mut rows = sqlx::query_as::<_, (i64, String)>(
        "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL",
    )
    .fetch(pool);

    let mut total_processed: usize = 0;

    // Pre-load existing tags into cache
    let mut tag_cache = std::collections::HashMap::new();
    let existing_tags: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM tags")
        .fetch_all(pool)
        .await?;
    for (id, name) in existing_tags {
        tag_cache.insert(name, id);
    }

    let mut state = BatchParseState {
        source_id,
        tag_cache,
        matched_count: 0,
        tags_created: 0,
    };

    // Process in transaction batches of 500
    const BATCH_SIZE: usize = 500;
    let mut batch: Vec<(i64, String)> = Vec::with_capacity(BATCH_SIZE);

    while let Some(row) = rows.try_next().await? {
        batch.push(row);
        total_processed += 1;

        if batch.len() >= BATCH_SIZE {
            flush_batch(
                pool,
                &mut batch,
                pattern_or_type,
                rule_type,
                token_config,
                &mut state,
                output_match_type,
            )
            .await?;
        }
    }

    // Flush remaining
    if !batch.is_empty() {
        flush_batch(
            pool,
            &mut batch,
            pattern_or_type,
            rule_type,
            token_config,
            &mut state,
            output_match_type,
        )
        .await?;
    }

    Ok(BatchExecutionResult {
        total_processed,
        matched_count: state.matched_count,
        tags_created: state.tags_created,
    })
}

/// Flush a batch of images within a single transaction
async fn flush_batch(
    pool: &SqlitePool,
    batch: &mut Vec<(i64, String)>,
    pattern_or_type: &str,
    rule_type: &str,
    token_config: Option<&[TokenBlock]>,
    state: &mut BatchParseState,
    output_match_type: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;

    for (img_id, current_filepath) in batch.drain(..) {
        let filename = std::path::Path::new(&current_filepath)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(&current_filepath)
            .to_string();

        let match_res = FilenameParser::test_filename(
            &filename,
            pattern_or_type,
            rule_type,
            token_config,
        )
        .map(|m| super::token_builder::apply_match_type_override(m, output_match_type));

        if let Some(res) = match_res {
            // Skip partial matches in batch run (only save complete matches)
            if res.partial {
                continue;
            }
            state.matched_count += 1;
            let extracted_json = serde_json::to_string(&res.extracted_tags).ok();

            sqlx::query(
                r#"
                INSERT INTO image_parsed_metadata (
                    image_id, match_type, artist, pixiv_id, twitter_id,
                    timestamp_4chan, datetime_iso, extracted_tags, raw_matched
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(image_id) DO UPDATE SET
                    match_type = excluded.match_type,
                    artist = excluded.artist,
                    pixiv_id = excluded.pixiv_id,
                    twitter_id = excluded.twitter_id,
                    timestamp_4chan = excluded.timestamp_4chan,
                    datetime_iso = excluded.datetime_iso,
                    extracted_tags = excluded.extracted_tags,
                    raw_matched = excluded.raw_matched,
                    updated_at = CURRENT_TIMESTAMP
                "#,
            )
            .bind(img_id)
            .bind(&res.match_type)
            .bind(&res.artist)
            .bind(&res.pixiv_id)
            .bind(&res.twitter_id)
            .bind(&res.timestamp_4chan)
            .bind(&res.datetime_iso)
            .bind(&extracted_json)
            .bind(&res.raw_matched)
            .execute(&mut *tx)
            .await?;

            for tag_name in res.extracted_tags {
                let category = if tag_name.starts_with("artist:") {
                    "artist"
                } else if tag_name.starts_with("date:") {
                    "meta"
                } else if tag_name.starts_with("site:") || tag_name.starts_with("source:") {
                    "source"
                } else {
                    "general"
                };

                // Use cache or insert and cache
                let tag_id = if let Some(&cached_id) = state.tag_cache.get(&tag_name) {
                    cached_id
                } else {
                    sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
                        .bind(&tag_name)
                        .bind(category)
                        .execute(&mut *tx)
                        .await?;

                    let tag_row: (i64,) = sqlx::query_as(
                        "SELECT id FROM tags WHERE name = ? LIMIT 1",
                    )
                    .bind(&tag_name)
                    .fetch_one(&mut *tx)
                    .await?;

                    state.tag_cache.insert(tag_name.clone(), tag_row.0);
                    tag_row.0
                };

                let res_link = sqlx::query(
                    r#"
                    INSERT INTO image_tags (image_id, tag_id, source_id, confidence)
                    VALUES (?, ?, ?, 1.0)
                    ON CONFLICT(image_id, tag_id, source_id, transaction_id) DO NOTHING
                    "#,
                )
                .bind(img_id)
                .bind(tag_id)
                .bind(state.source_id)
                .execute(&mut *tx)
                .await?;

                if res_link.rows_affected() > 0 {
                    state.tags_created += 1;
                }
            }
        }
    }

    tx.commit().await?;
    Ok(())
}
