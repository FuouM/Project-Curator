use anyhow::Result;
use curator_core::concept::bytes_to_vector;
use curator_core::ipc::{EmbeddingModel, SearchMatch};
use curator_core::vector::{ModelManager, VectorIndex};
use sha2::Digest;

pub struct SearchParams {
    pub query_text: Option<String>,
    pub query_image_path: Option<String>,
    pub tag_filter: Option<String>,
    pub filename_filter: Option<String>,
    pub parse_filter: Option<String>,
    pub parse_type: Option<String>,
    pub concept_id: Option<i64>,
    pub limit: usize,
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
use super::image::get_image_logic;

pub async fn search_logic(
    params: SearchParams,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<Vec<SearchMatch>> {
    let SearchParams {
        query_text,
        query_image_path,
        tag_filter,
        filename_filter,
        parse_filter,
        parse_type,
        concept_id,
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

                        let sample_camie_logits: Vec<(i64, f64)> = sqlx::query_as(
                            "SELECT it.tag_id, AVG(it.confidence) as avg_conf
                             FROM image_tags it
                             JOIN custom_concept_samples ccs ON it.image_id = ccs.image_id
                             JOIN sources s ON it.source_id = s.id
                             WHERE ccs.concept_id = ? AND s.name = 'ai:camie-tagger-v2' AND it.is_deleted = 0
                             GROUP BY it.tag_id",
                        )
                        .bind(c_id)
                        .fetch_all(db)
                        .await
                        .unwrap_or_default();

                        let results = vector_index.search(&proto_vec, limit.max(500))?;
                        for (id, dist) in results {
                            let image_id = id as i64;
                            let clip_sim = 1.0 - dist;

                            let mut camie_logit_sim = 0.0f32;
                            let mut has_cand_camie = false;
                            if !sample_camie_logits.is_empty() {
                                let candidate_camie_tags: Vec<(i64, f64)> = sqlx::query_as(
                                    "SELECT it.tag_id, it.confidence
                                     FROM image_tags it
                                     JOIN sources s ON it.source_id = s.id
                                     WHERE it.image_id = ? AND s.name = 'ai:camie-tagger-v2' AND it.is_deleted = 0",
                                )
                                .bind(image_id)
                                .fetch_all(db)
                                .await
                                .unwrap_or_default();

                                if !candidate_camie_tags.is_empty() {
                                    has_cand_camie = true;
                                    let cand_map: std::collections::HashMap<i64, f64> = candidate_camie_tags.into_iter().collect();
                                    let mut dot_product = 0.0f64;
                                    let mut proto_norm_sq = 0.0f64;
                                    let mut cand_norm_sq = 0.0f64;

                                    for &(tag_id, proto_conf) in &sample_camie_logits {
                                        proto_norm_sq += proto_conf * proto_conf;
                                        if let Some(&cand_conf) = cand_map.get(&tag_id) {
                                            dot_product += proto_conf * cand_conf;
                                        }
                                    }

                                    for &cand_conf in cand_map.values() {
                                        cand_norm_sq += cand_conf * cand_conf;
                                    }

                                    if proto_norm_sq > 0.0 && cand_norm_sq > 0.0 {
                                        camie_logit_sim = (dot_product / (proto_norm_sq.sqrt() * cand_norm_sq.sqrt())) as f32;
                                    }
                                }
                            }

                            let svm_score = if clip_sim > 0.55 { (clip_sim - 0.55) / 0.45 } else { 0.0 };

                            let (final_score, is_match) = if has_cand_camie {
                                if camie_logit_sim > 0.0 {
                                    let score = 0.50 * svm_score + 0.50 * camie_logit_sim;
                                    (score, score >= (concept.threshold * 0.60) || camie_logit_sim >= (concept.threshold * 0.60))
                                } else {
                                    (0.0f32, false)
                                }
                            } else {
                                (svm_score, svm_score >= (concept.threshold * 0.60))
                            };

                            if is_match {
                                ids.insert(image_id);
                                vector_scores.insert(image_id, final_score);
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
                        .unwrap_or_default();

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

    if let Some(img_path) = query_image_path {
        let path = std::path::Path::new(&img_path);
        if path.exists() {
            if let Ok(data) = std::fs::read(path) {
                let sha256 = format!("{:x}", sha2::Sha256::digest(&data));
                let rows: Vec<(i64,)> =
                    sqlx::query_as("SELECT id FROM images WHERE sha256 = ? AND deleted_at IS NULL")
                        .bind(&sha256)
                        .fetch_all(db)
                        .await
                        .unwrap_or_default();
                for r in rows {
                    exact_matches.insert(r.0);
                }
            }

            if let Ok(query_ahash) = curator_core::vector::compute_ahash(path) {
                let query_val = u64::from_str_radix(&query_ahash, 16).unwrap_or(0);
                let rows: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT id, phash FROM images WHERE phash IS NOT NULL AND deleted_at IS NULL",
                )
                .fetch_all(db)
                .await
                .unwrap_or_default();
                for (id, db_phash) in rows {
                    let db_val = u64::from_str_radix(&db_phash, 16).unwrap_or(0);
                    let dist = (query_val ^ db_val).count_ones();
                    if dist <= 10 {
                        perceptual_matches.insert(id, dist);
                    }
                }
            }

            let query_vector = model_manager.generate_image_embedding(path)?;
            let results = vector_index.search(&query_vector, limit.max(100))?;

            let mut ids = std::collections::HashSet::new();
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                vector_scores.insert(id_i64, 1.0 - dist);
            }
            candidate_ids = Some(ids);
        }
    }

    if let Some(ref text) = query_text {
        if !text.trim().is_empty() {
            let query_vector = model_manager.generate_text_embedding(text)?;
            let results = vector_index.search(&query_vector, limit.max(100))?;

            let mut ids = std::collections::HashSet::new();
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                vector_scores.insert(id_i64, 1.0 - dist);
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
            let parsed_rows: Vec<(i64,)> = query.fetch_all(db).await.unwrap_or_default();

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
            .unwrap_or_default();
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

    if let Some(tag_filter_raw) = tag_filter {
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
            for tag_name in &tag_names {
                let tagged_images: Vec<(i64,)> = sqlx::query_as(
                    "SELECT DISTINCT it.image_id FROM image_tags it
                     JOIN tags t ON it.tag_id = t.id
                     WHERE t.name = ? AND it.is_deleted = 0",
                )
                .bind(tag_name)
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

    let target_ids = if target_set.is_empty()
        && query_text.is_none()
        && exact_matches.is_empty()
        && perceptual_matches.is_empty()
        && parse_matches.is_empty()
    {
        let latest: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(db)
        .await?;
        latest.into_iter().map(|r| r.0).collect()
    } else {
        let mut ids: Vec<i64> = target_set.into_iter().collect();
        ids.sort_unstable(); // deterministic order for non-neural result sets
        ids
    };

    let mut matches = Vec::new();
    for id in target_ids {
        if let Ok(details) = get_image_logic(id, db).await {
            let (match_type, score, hamming_distance) = if exact_matches.contains(&id) {
                ("exact".to_string(), 1.0, None)
            } else if let Some(&dist) = perceptual_matches.get(&id) {
                (
                    "perceptual".to_string(),
                    1.0 - (dist as f32 / 64.0),
                    Some(dist),
                )
            } else {
                let sem_score = vector_scores.get(&details.id).cloned().unwrap_or(0.0);
                ("semantic".to_string(), sem_score, None)
            };

            matches.push(SearchMatch {
                id: details.id,
                filepath: details.current_filepath,
                score,
                tags: details.tags,
                match_type,
                hamming_distance,
                parsed_metadata: details.parsed_metadata,
            });
        }
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
    matches.truncate(limit);
    Ok(matches)
}
