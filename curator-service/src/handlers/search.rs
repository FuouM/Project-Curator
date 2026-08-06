use anyhow::Result;
use curator_core::concept::bytes_to_vector;
use curator_core::ipc::{EmbeddingModel, SearchMatch};
use curator_core::vector::{ModelManager, VectorIndex};
use super::image::batch_get_images_logic;

pub struct SearchParams {
    pub query_text: Option<String>,
    pub query_image_path: Option<String>,
    pub tag_filter: Option<String>,
    pub filename_filter: Option<String>,
    pub parse_filter: Option<String>,
    pub parse_type: Option<String>,
    pub concept_id: Option<i64>,
    pub character_identity_id: Option<i64>,
    pub ocr_filter: Option<bool>,
    pub ocr_text_search: Option<String>,
    pub media_type: Option<String>,
    pub limit: usize,
}

/// Returns `(WHERE-clause suffix, boolean video predicate)` for a media-kind
/// filter. The WHERE suffix is used directly in list queries; the boolean
/// predicate is used for post-filtering a candidate id set.
fn media_sql_clause(kind: Option<&str>) -> (String, String) {
    match kind {
        Some("video") => (
            "AND (LOWER(current_filepath) LIKE '%.mp4' OR LOWER(current_filepath) LIKE '%.webm')".to_string(),
            "(LOWER(i.current_filepath) LIKE '%.mp4' OR LOWER(i.current_filepath) LIKE '%.webm')".to_string(),
        ),
        Some("image") => (
            "AND NOT (LOWER(current_filepath) LIKE '%.mp4' OR LOWER(current_filepath) LIKE '%.webm')".to_string(),
            "NOT (LOWER(i.current_filepath) LIKE '%.mp4' OR LOWER(i.current_filepath) LIKE '%.webm')".to_string(),
        ),
        _ => (String::new(), "1".to_string()),
    }
}

/// Resolve a reverse-search query file into a decodable image path. For videos
/// the first frame is extracted to a temp PNG (FFmpeg) so the perceptual hash
/// and CLIP embedding operate on actual pixels; static images pass through.
/// Returns `(path_to_use, cleanup_path)` where `cleanup_path` is `Some` when a
/// temp frame was produced and must be removed after the search completes.
fn resolve_query_image(
    query_path: &std::path::Path,
    data_dir: &std::path::Path,
    ffmpeg: &std::path::Path,
) -> (std::path::PathBuf, Option<std::path::PathBuf>) {
    if !curator_core::video::is_video(query_path) {
        return (query_path.to_path_buf(), None);
    }
    match curator_core::video::extract_video_frame(query_path, 0, ffmpeg) {
        Ok(frame) => {
            let tmp = data_dir.join("search_tmp").join(format!(
                "query_frame_{}.png",
                uuid::Uuid::new_v4()
            ));
            if let Some(parent) = tmp.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(bytes) = curator_core::video::frame_to_png_bytes(&frame) {
                if std::fs::write(&tmp, &bytes).is_ok() {
                    return (tmp.clone(), Some(tmp));
                }
            }
            (query_path.to_path_buf(), None)
        }
        Err(_) => (query_path.to_path_buf(), None),
    }
}

/// Parse search terms supporting quoted strings and field:value syntax.
/// Examples: `anime:"Ichijyoma Mankitsu" episode:09 Erai-raws`
/// Returns: ["anime:Ichijyoma Mankitsu", "episode:09", "Erai-raws"]
fn parse_search_terms(input: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut chars = input.chars().peekable();
    let mut current = String::new();

    while let Some(&c) = chars.peek() {
        match c {
            '"' => {
                chars.next(); // skip opening quote
                // Read until closing quote
                while let Some(&qc) = chars.peek() {
                    if qc == '"' {
                        chars.next();
                        break;
                    }
                    current.push(qc);
                    chars.next();
                }
            }
            ' ' => {
                chars.next();
                if !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(c);
                chars.next();
            }
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    terms
}
use sqlx::SqlitePool;

use super::concepts::get_custom_concept_by_id;

pub async fn search_logic(
    params: SearchParams,
    preferred_source: &str,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
    data_dir: &std::path::Path,
    ffmpeg: Option<std::path::PathBuf>,
) -> Result<Vec<SearchMatch>> {
    let SearchParams {
        query_text,
        query_image_path,
        tag_filter,
        filename_filter,
        parse_filter,
        parse_type,
        concept_id,
        character_identity_id,
        ocr_filter,
        ocr_text_search,
        media_type,
        limit,
    } = params;
    let mut candidate_ids: Option<std::collections::HashSet<i64>> = None;
    let mut vector_scores: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
    let mut exact_matches = std::collections::HashSet::new();
    let mut perceptual_matches = std::collections::HashMap::new();

    if let Some(c_id) = concept_id {
        if let Ok(concept) = get_custom_concept_by_id(db, c_id).await {
            let active_model = model_manager.active_model();
            let source_name = match active_model {
                EmbeddingModel::ClipVitB32 => curator_core::constants::SOURCE_CLIP,
                EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
            };
            let source_row: Option<(i64,)> = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
                .bind(source_name)
                .fetch_optional(db)
                .await?;
            if let Some((source_id,)) = source_row {
                let vec_row: Option<(Vec<u8>,)> = sqlx::query_as(
                    "SELECT vector FROM custom_concept_vectors WHERE concept_id = ? AND source_id = ? LIMIT 1",
                )
                .bind(c_id)
                .bind(source_id)
                .fetch_optional(db)
                .await?;

                if let Some((blob,)) = vec_row {
                    let proto_vec = bytes_to_vector(&blob);
                    if !proto_vec.is_empty() {
                        let mut ids = std::collections::HashSet::new();

                        let results = vector_index.search(&proto_vec, limit.max(500))?;
                        for (id, dist) in results {
                            let image_id = id as i64;
                            let raw_score = 1.0 - dist;

                            // Include candidates down to reasonable similarity threshold (CLIP cosine space cutoff)
                            let min_threshold = (concept.threshold * 0.25).max(0.15);
                            let is_match = raw_score >= min_threshold;

                            if is_match {
                                // Normalize score for display ranking
                                let normalized_score = ((raw_score - 0.15) / 0.85).clamp(0.0, 1.0);
                                ids.insert(image_id);
                                vector_scores.insert(image_id, normalized_score);
                            }
                        }

                        let tagged_images: Vec<(i64,)> = sqlx::query_as(
                            "SELECT DISTINCT it.image_id FROM image_tags it
                             JOIN tags t ON it.tag_id = t.id
                             WHERE t.name = ? AND it.is_deleted = 0",
                        )
                        .bind(&concept.name)
                        .fetch_all(db)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::warn!("Failed to query concept tagged images: {:?}", e);
                            Vec::new()
                        });
                        for r in tagged_images {
                            ids.insert(r.0);
                            vector_scores.entry(r.0).or_insert(1.0);
                        }

                        candidate_ids = Some(ids);
                    }
                }
            }
        }
    }

    // Filter by character identity
    if let Some(char_id) = character_identity_id {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT image_id FROM character_detections WHERE identity_id = ?"
        )
        .bind(char_id)
        .fetch_all(db)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Failed to query character detections: {:?}", e);
            Vec::new()
        });
        let ids: std::collections::HashSet<i64> = rows.into_iter().map(|r| r.0).collect();
        candidate_ids = Some(match candidate_ids.take() {
            Some(existing) => existing.intersection(&ids).copied().collect(),
            None => ids,
        });
    }

    // Filter to only images with OCR detections
    if ocr_filter == Some(true) {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT image_id FROM image_ocr_detections"
        )
        .fetch_all(db)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Failed to query OCR detections: {:?}", e);
            Vec::new()
        });
        let ids: std::collections::HashSet<i64> = rows.into_iter().map(|r| r.0).collect();
        candidate_ids = Some(match candidate_ids.take() {
            Some(existing) => existing.intersection(&ids).copied().collect(),
            None => ids,
        });
    }

    if let Some(ref img_path) = query_image_path {
        let path = std::path::Path::new(&img_path);
        if path.exists() {
            // Videos can't be decoded directly — use the extracted first frame.
            let (usable, mut cleanup) = match &ffmpeg {
                Some(ffmpeg) if ffmpeg.exists() => resolve_query_image(path, data_dir, ffmpeg),
                _ => (path.to_path_buf(), None),
            };

            // Exact sha256 identity: hashes the WHOLE file (matching how videos
            // are deduplicated at import time), not just the decoded first frame.
            let file_sha = tokio::task::block_in_place(|| curator_core::media::sha256_file(path));
            if let Ok(sha) = file_sha {
                let rows: Vec<(i64,)> =
                    sqlx::query_as("SELECT id FROM images WHERE sha256 = ? AND deleted_at IS NULL")
                        .bind(&sha)
                        .fetch_all(db)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::warn!("Failed to query exact sha256 matches: {:?}", e);
                            Vec::new()
                        });
                for r in rows {
                    exact_matches.insert(r.0);
                }
            } else {
                tracing::warn!("Failed to hash query file {:?}", path);
            }

            // Perceptual hash decodes the image (CPU-bound) — off the reactor.
            let query_ahash = tokio::task::block_in_place(|| curator_core::vector::compute_ahash(&usable));
            if let Ok(query_ahash) = query_ahash {
                let query_val = u64::from_str_radix(&query_ahash, 16).unwrap_or(0);
                let rows: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT id, phash FROM images WHERE phash IS NOT NULL AND deleted_at IS NULL",
                )
                .fetch_all(db)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!("Failed to query phashes: {:?}", e);
                    Vec::new()
                });
                for (id, db_phash) in rows {
                    let db_val = u64::from_str_radix(&db_phash, 16).unwrap_or(0);
                    let dist = (query_val ^ db_val).count_ones();
                    if dist <= 10 {
                        perceptual_matches.insert(id, dist);
                    }
                }
            }

            // CLIP image embedding = full decode + resize + ONNX (CPU-bound) — off the reactor.
            let query_vector = match tokio::task::block_in_place(|| model_manager.generate_image_embedding(&usable)) {
                Ok(v) => v,
                Err(e) => {
                    if let Some(cleanup_path) = cleanup.take() {
                        let _ = std::fs::remove_file(cleanup_path);
                    }
                    return Err(e);
                }
            };
            let results = vector_index.search(&query_vector, limit.max(100))?;

            let mut ids = std::collections::HashSet::new();
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                vector_scores.insert(id_i64, 1.0 - dist);
            }
            candidate_ids = Some(ids);

            if let Some(cleanup_path) = cleanup {
                let _ = std::fs::remove_file(cleanup_path);
            }
        }
    }

    if let Some(ref text) = query_text {
        if !text.trim().is_empty() {
            let mut ids = std::collections::HashSet::new();

            // Text embedding via ONNX (CPU-bound) — off the reactor.
            let query_vector = tokio::task::block_in_place(|| model_manager.generate_text_embedding(text))?;
            let results = vector_index.search(&query_vector, limit.max(100))?;
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                vector_scores.insert(id_i64, 1.0 - dist);
            }

            candidate_ids = Some(ids);
        }
    }

    // Dedicated OCR text full-text search
    if let Some(ref ocr_text) = ocr_text_search {
        if !ocr_text.trim().is_empty() {
            let fts_rows: Vec<(i64,)> = sqlx::query_as(
                "SELECT DISTINCT image_id FROM image_ocr_fts WHERE text MATCH ?"
            )
            .bind(ocr_text)
            .fetch_all(db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to query OCR FTS: {:?}", e);
                Vec::new()
            });
            let mut ids = std::collections::HashSet::new();
            for (id,) in fts_rows {
                ids.insert(id);
                vector_scores.insert(id, 1.0);
            }
            candidate_ids = Some(ids);
        }
    }

    // Search by parsed filename metadata (artist, pixiv_id, twitter_id, source site, etc.)
    // Supports chaining: "anime:ichijyoma episode:09" (space-separated, AND logic)
    // Each term can be "field:value" (searches extracted_tags) or plain text (searches all fields)
    let mut parse_matches = std::collections::HashSet::new();
    let has_parse_query = parse_filter.as_ref().is_some_and(|f| !f.trim().is_empty())
        || parse_type.as_ref().is_some_and(|t| !t.trim().is_empty());

    if has_parse_query {
        let mut conditions = Vec::new();
        let mut bind_values: Vec<String> = Vec::new();

        if let Some(ref filter) = parse_filter {
            if !filter.trim().is_empty() {
                // Parse terms: supports "field:value" and "field:"quoted value"" syntax
                // Space-separated, quoted strings preserved as single terms
                let terms = parse_search_terms(filter.trim());
                for term in terms {
                    if let Some((field, value)) = term.split_once(':') {
                        if !value.is_empty() {
                            // field:"value" or field:value — search extracted_tags for "field:value"
                            let tag_term = format!("{}:{}", field, value);
                            let pattern = format!("%{}%", tag_term);
                            bind_values.push(pattern);
                            conditions.push("extracted_tags LIKE ? COLLATE NOCASE".to_string());
                        }
                    } else {
                        // Plain text — search across all fields (OR within this term)
                        let pattern = format!("%{}%", term);
                        bind_values.push(pattern.clone());
                        bind_values.push(pattern.clone());
                        bind_values.push(pattern.clone());
                        bind_values.push(pattern.clone());
                        bind_values.push(pattern.clone());
                        bind_values.push(pattern.clone());
                        conditions.push(
                            "(artist LIKE ? COLLATE NOCASE
                              OR pixiv_id LIKE ? COLLATE NOCASE
                              OR twitter_id LIKE ? COLLATE NOCASE
                              OR match_type LIKE ? COLLATE NOCASE
                              OR extracted_tags LIKE ? COLLATE NOCASE
                              OR raw_matched LIKE ? COLLATE NOCASE)".to_string()
                        );
                    }
                }
            }
        }

        if let Some(ref ptype) = parse_type {
            if !ptype.trim().is_empty() {
                bind_values.push(ptype.trim().to_string());
                conditions.push("match_type = ?".to_string());
            }
        }

        if !conditions.is_empty() {
            let where_clause = conditions.join(" AND ");
            let sql = format!(
                "SELECT image_id FROM image_parsed_metadata WHERE {}",
                where_clause
            );
            let mut query = sqlx::query_as::<_, (i64,)>(&sql);
            for val in &bind_values {
                query = query.bind(val);
            }
            let parsed_rows: Vec<(i64,)> = query.fetch_all(db).await.unwrap_or_else(|e| {
                tracing::warn!("Failed to query parsed metadata: {:?}", e);
                Vec::new()
            });
            for (id,) in parsed_rows {
                parse_matches.insert(id);
            }
        }
    }

    // Search by filename (current_filepath LIKE %query%)
    let mut filename_matches = std::collections::HashSet::new();
    if let Some(ref fname) = filename_filter {
        if !fname.trim().is_empty() {
            let pattern = format!("%{}%", fname.trim());
            let rows: Vec<(i64,)> = sqlx::query_as(
                "SELECT id FROM images WHERE current_filepath LIKE ? COLLATE NOCASE AND deleted_at IS NULL",
            )
            .bind(&pattern)
            .fetch_all(db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to query filename filter: {:?}", e);
                Vec::new()
            });
            for (id,) in rows {
                filename_matches.insert(id);
            }
        }
    }

    let mut target_set = std::collections::HashSet::new();
    if let Some(c_ids) = candidate_ids {
        target_set.extend(c_ids);
    }
    target_set.extend(exact_matches.iter().copied());
    target_set.extend(perceptual_matches.keys().copied());
    target_set.extend(parse_matches.iter().copied());
    target_set.extend(filename_matches.iter().copied());

    if let Some(ref tag_filter_raw) = tag_filter {
        let tag_names: Vec<String> = tag_filter_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let is_tag_only = query_text.is_none()
            && exact_matches.is_empty()
            && perceptual_matches.is_empty()
            && parse_matches.is_empty();

        if !tag_names.is_empty() {
            let mut first = true;
            let source_id = super::common::resolve_source_id(db, preferred_source).await.unwrap_or(0);
            for tag_name in &tag_names {
                let tagged_images: Vec<(i64,)> = sqlx::query_as(
                    "SELECT DISTINCT it.image_id FROM image_tags it
                     JOIN tags t ON it.tag_id = t.id
                     WHERE REPLACE(LOWER(t.name), '_', ' ') = REPLACE(LOWER(?), '_', ' ') AND it.is_deleted = 0 AND it.source_id = ?",
                )
                .bind(tag_name)
                .bind(source_id)
                .fetch_all(db)
                .await?;

                let tag_set: std::collections::HashSet<i64> =
                    tagged_images.into_iter().map(|row| row.0).collect();

                if first && is_tag_only {
                    target_set = tag_set;
                } else {
                    target_set = target_set.intersection(&tag_set).cloned().collect();
                }
                first = false;
            }
        }
    }

    let has_query = query_text.is_some()
        || query_image_path.is_some()
        || tag_filter.is_some()
        || filename_filter.is_some()
        || parse_filter.is_some()
        || parse_type.is_some()
        || concept_id.is_some()
        || character_identity_id.is_some()
        || ocr_filter.is_some()
        || ocr_text_search.is_some();

    let target_ids = if !has_query {
        let (media_where, _) = media_sql_clause(media_type.as_deref());
        let sql = format!(
            "SELECT id FROM images WHERE deleted_at IS NULL {media_where} ORDER BY created_at DESC LIMIT ?"
        );
        let latest: Vec<(i64,)> = sqlx::query_as(&sql)
            .bind(limit as i64)
            .fetch_all(db)
            .await?;
        latest.into_iter().map(|r| r.0).collect()
    } else {
        let mut ids: Vec<i64> = target_set.into_iter().collect();
        ids.sort_unstable();
        ids
    };

    // Media kind filter: "image" excludes videos, "video" keeps only videos.
    let target_ids: Vec<i64> = match media_type.as_deref() {
        None => target_ids,
        Some(_) if !has_query => target_ids,
        Some(kind) if !target_ids.is_empty() => {
            let placeholders = target_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let (_, is_video_clause) = media_sql_clause(Some(kind));
            let sql = format!(
                "SELECT i.id FROM images i WHERE i.id IN ({}) AND {} AND i.deleted_at IS NULL",
                placeholders, is_video_clause
            );
            let mut query = sqlx::query_as::<_, (i64,)>(&sql);
            for id in &target_ids {
                query = query.bind(id);
            }
            let rows: Vec<(i64,)> = query.fetch_all(db).await?;
            rows.into_iter().map(|r| r.0).collect()
        }
        Some(_) => Vec::new(),
    };

    let batch_details = batch_get_images_logic(&target_ids, preferred_source, db)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Failed to batch get image details in search: {:?}", e);
            Vec::new()
        });
    let details_map: std::collections::HashMap<i64, _> =
        batch_details.into_iter().map(|d| (d.id, d)).collect();

    let mut matches = Vec::new();
    for id in &target_ids {
        let details = match details_map.get(id) {
            Some(d) => d,
            None => continue,
        };

        let (match_type, score, hamming_distance) = if exact_matches.contains(id) {
            ("exact".to_string(), 1.0, None)
        } else if let Some(&dist) = perceptual_matches.get(id) {
            (
                "perceptual".to_string(),
                1.0 - (dist as f32 / 64.0),
                Some(dist),
            )
        } else {
            let sem_score = vector_scores.get(id).cloned().unwrap_or(0.0);
            ("semantic".to_string(), sem_score, None)
        };

        matches.push(SearchMatch {
            id: details.id,
            filepath: details.current_filepath.clone(),
            score,
            tags: details.tags.clone(),
            match_type,
            hamming_distance,
            parsed_metadata: details.parsed_metadata.clone(),
            ocr_text: details.ocr_text.clone(),
            character_identities: details.character_identities.clone(),
            animation: details.animation.clone(),
            video: details.video.clone(),
            favorite: details.favorite,
            is_missing: details.is_missing,
        });
    }

    matches.sort_by(|a, b| {
        let priority = |m: &str| -> i32 {
            match m {
                "exact" => 0,
                "perceptual" => 1,
                _ => 2,
            }
        };
        let p_a = priority(&a.match_type);
        let p_b = priority(&b.match_type);
        if p_a != p_b {
            p_a.cmp(&p_b)
        } else {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.id.cmp(&b.id))
        }
    });

    matches.retain(|m| {
        if let Some(details) = details_map.get(&m.id) {
            !details.is_missing
        } else {
            false
        }
    });

    matches.truncate(limit);
    Ok(matches)
}
