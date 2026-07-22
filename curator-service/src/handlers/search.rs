use anyhow::Result;
use curator_core::concept::bytes_to_vector;
use curator_core::ipc::{EmbeddingModel, SearchMatch};
use curator_core::vector::{ModelManager, VectorIndex};
use sha2::Digest;
use sqlx::SqlitePool;

use super::concepts::get_custom_concept_by_id;
use super::image::get_image_logic;

pub async fn search_logic(
    query_text: Option<String>,
    query_image_path: Option<String>,
    tag_filter: Option<String>,
    concept_id: Option<i64>,
    limit: usize,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<Vec<SearchMatch>> {
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

    let mut target_set = std::collections::HashSet::new();
    if let Some(c_ids) = candidate_ids {
        target_set.extend(c_ids);
    }
    target_set.extend(exact_matches.iter().copied());
    target_set.extend(perceptual_matches.keys().copied());

    if let Some(tag_name) = tag_filter {
        if !tag_name.trim().is_empty() {
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

            if target_set.is_empty()
                && query_text.is_none()
                && exact_matches.is_empty()
                && perceptual_matches.is_empty()
            {
                target_set = tag_set;
            } else {
                target_set = target_set.intersection(&tag_set).cloned().collect();
            }
        }
    }

    let target_ids = if target_set.is_empty()
        && query_text.is_none()
        && exact_matches.is_empty()
        && perceptual_matches.is_empty()
    {
        let latest: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(db)
        .await?;
        latest.into_iter().map(|r| r.0).collect()
    } else {
        target_set.into_iter().collect::<Vec<i64>>()
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
        }
    });
    matches.truncate(limit);
    Ok(matches)
}
