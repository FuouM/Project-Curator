use anyhow::{Context, Result};
use curator_core::concept::{
    bytes_to_vector, sanitize_concept_name, vector_to_bytes, CustomConcept,
};
use curator_core::vector::ModelManager;
use sqlx::SqlitePool;

use super::common::resolve_source_id;

pub async fn get_custom_concept_by_id(db: &SqlitePool, concept_id: i64) -> Result<CustomConcept> {
    let row: (i64, String, String, f64, i64, String, String) = sqlx::query_as(
        "SELECT c.id, c.name, c.category, c.threshold,
                (SELECT COUNT(*) FROM custom_concept_samples WHERE concept_id = c.id) as sample_count,
                c.created_at, c.updated_at
         FROM custom_concepts c
         WHERE c.id = ? LIMIT 1",
    )
    .bind(concept_id)
    .fetch_one(db)
    .await?;

    Ok(CustomConcept {
        id: row.0,
        name: row.1,
        category: row.2,
        threshold: row.3 as f32,
        sample_count: row.4 as usize,
        created_at: row.5,
        updated_at: row.6,
    })
}

pub async fn apply_concept_tags_to_samples(
    db: &SqlitePool,
    concept: &CustomConcept,
    sample_image_ids: &[i64],
) -> Result<()> {
    let concept_source_id = resolve_source_id(db, "ai:custom-concepts").await?;

    let tag_row: (i64,) = sqlx::query_as(
        "INSERT INTO tags (name, category) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET category = excluded.category
         RETURNING id",
    )
    .bind(&concept.name)
    .bind(&concept.category)
    .fetch_one(db)
    .await?;
    let tag_id = tag_row.0;

    // Batch sample tag links in one transaction.
    let mut tx = db.begin().await?;
    for &img_id in sample_image_ids {
        let _ = sqlx::query(
            "INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted)
             VALUES (?, ?, ?, 1.0, 0)
             ON CONFLICT(image_id, tag_id, source_id, transaction_id) DO UPDATE SET is_deleted = 0, confidence = 1.0",
        )
        .bind(img_id)
        .bind(tag_id)
        .bind(concept_source_id)
        .execute(&mut *tx)
        .await;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn recompute_concept_prototype_logic(
    db: &SqlitePool,
    concept_id: i64,
    model_manager: &ModelManager,
) -> Result<Vec<f32>> {
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ? AND is_negative = 0",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;

    let ids: Vec<i64> = sample_rows.into_iter().map(|(id,)| id).collect();

    let active_model = model_manager.active_model();
    let source_name = active_model.source_name();
    let source_id = resolve_source_id(db, source_name).await?;

    let mut sample_vectors = Vec::new();
    if !ids.is_empty() {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query_str = format!(
            "SELECT vector FROM image_vectors WHERE source_id = ? AND vector_state = 'ready' AND image_id IN ({})",
            placeholders
        );
        let mut q = sqlx::query_as::<_, (Vec<u8>,)>(query_str.as_str()).bind(source_id);
        for id in &ids {
            q = q.bind(id);
        }
        if let Ok(vec_rows) = q.fetch_all(db).await {
            for (blob,) in vec_rows {
                let vec = bytes_to_vector(&blob);
                if !vec.is_empty() {
                    sample_vectors.push(vec);
                }
            }
        }

        // Strict check: if any sample image vectors are missing, fail loudly instead of falling back to disk/re-inference
        if sample_vectors.len() < ids.len() {
            return Err(anyhow::anyhow!(
                "Cannot recompute concept prototype: {} of {} sample images are missing ready vectors in the database. Please index the images first.",
                ids.len() - sample_vectors.len(),
                ids.len()
            ));
        }
    }

    let prompt_text = format!("anime artwork of {}", concept.name.replace('_', " "));
    // Text embedding via ONNX — off the reactor. Must succeed or fail loudly.
    let text_vec = tokio::task::block_in_place(|| model_manager.generate_text_embedding(&prompt_text))
        .context("Failed to generate text embedding for concept training prompt")?;

    // Fast SQLite vector BLOB pre-fetch for background negative contrast subspace
    let neg_rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT vector FROM image_vectors
         WHERE source_id = ? AND vector_state = 'ready'
           AND image_id NOT IN (SELECT image_id FROM custom_concept_samples WHERE concept_id = ?)
         ORDER BY RANDOM() LIMIT 32",
    )
    .bind(source_id)
    .bind(concept_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mut negative_vectors = Vec::new();
    for (blob,) in neg_rows {
        let vec = bytes_to_vector(&blob);
        if !vec.is_empty() {
            negative_vectors.push(vec);
        }
    }

    let (proto_vec, _bias) = curator_core::concept::train_linear_svm_decision_boundary(
        &sample_vectors,
        &negative_vectors,
        Some(&text_vec),
    );

    let blob = vector_to_bytes(&proto_vec);

    let active_model = model_manager.active_model();
    let source_name = active_model.source_name();
    let source_id = resolve_source_id(db, source_name).await?;

    sqlx::query(
        "INSERT INTO custom_concept_vectors (concept_id, source_id, vector, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(concept_id, source_id) DO UPDATE SET vector = excluded.vector, updated_at = CURRENT_TIMESTAMP"
    )
    .bind(concept_id)
    .bind(source_id)
    .bind(blob)
    .execute(db)
    .await?;

    sqlx::query("UPDATE custom_concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(concept_id)
        .execute(db)
        .await?;

    Ok(proto_vec)
}

pub async fn create_concept_logic(
    db: &SqlitePool,
    name: &str,
    category: &str,
    threshold: f32,
    sample_image_ids: &[i64],
    model_manager: &ModelManager,
) -> Result<CustomConcept> {
    let clean_name = sanitize_concept_name(name);
    if clean_name.is_empty() {
        return Err(anyhow::anyhow!("Concept name cannot be empty"));
    }

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM custom_concepts WHERE name = ? LIMIT 1")
        .bind(&clean_name)
        .fetch_optional(db)
        .await?;

    let concept_id = match existing {
        Some((id,)) => {
            sqlx::query("UPDATE custom_concepts SET category = ?, threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(category)
                .bind(threshold as f64)
                .bind(id)
                .execute(db)
                .await?;
            id
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO custom_concepts (name, category, threshold) VALUES (?, ?, ?)"
            )
            .bind(&clean_name)
            .bind(category)
            .bind(threshold as f64)
            .execute(db)
            .await?;
            res.last_insert_rowid()
        }
    };

    // Batch sample inserts in one transaction.
    let mut tx = db.begin().await?;
    for &img_id in sample_image_ids {
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO custom_concept_samples (concept_id, image_id) VALUES (?, ?)"
        )
        .bind(concept_id)
        .bind(img_id)
        .execute(&mut *tx)
        .await;
    }
    tx.commit().await?;

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    let _ = apply_concept_tags_to_samples(db, &concept, sample_image_ids).await;

    Ok(concept)
}

pub async fn list_concepts_logic(db: &SqlitePool) -> Result<Vec<CustomConcept>> {
    let rows: Vec<(i64, String, String, f64, i64, String, String)> = sqlx::query_as(
        "SELECT c.id, c.name, c.category, c.threshold,
                (SELECT COUNT(*) FROM custom_concept_samples WHERE concept_id = c.id) as sample_count,
                c.created_at, c.updated_at
         FROM custom_concepts c
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| CustomConcept {
            id: r.0,
            name: r.1,
            category: r.2,
            threshold: r.3 as f32,
            sample_count: r.4 as usize,
            created_at: r.5,
            updated_at: r.6,
        })
        .collect())
}

pub async fn get_concept_samples_logic(
    db: &SqlitePool,
    concept_id: i64,
    preferred_source: &str,
) -> Result<Vec<curator_core::ipc::ImageDetails>> {
    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;

    let ids: Vec<i64> = sample_rows.into_iter().map(|r| r.0).collect();
    // Batch-fetch all sample details (4 queries total) instead of N×6.
    let samples = super::image::batch_get_images_logic(&ids, preferred_source, db)
        .await
        .unwrap_or_default();
    Ok(samples)
}

pub async fn update_concept_logic(
    db: &SqlitePool,
    id: i64,
    threshold: Option<f32>,
    category: Option<String>,
) -> Result<CustomConcept> {
    if let Some(th) = threshold {
        sqlx::query("UPDATE custom_concepts SET threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(th as f64)
            .bind(id)
            .execute(db)
            .await?;
    }

    if let Some(cat) = category {
        sqlx::query("UPDATE custom_concepts SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(&cat)
            .bind(id)
            .execute(db)
            .await?;
    }

    get_custom_concept_by_id(db, id).await
}

pub async fn delete_concept_logic(db: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM custom_concepts WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn add_concept_samples_logic(
    db: &SqlitePool,
    concept_id: i64,
    image_ids: &[i64],
    model_manager: &ModelManager,
) -> Result<CustomConcept> {
    // Batch sample inserts in one transaction.
    let mut tx = db.begin().await?;
    for &img_id in image_ids {
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO custom_concept_samples (concept_id, image_id) VALUES (?, ?)"
        )
        .bind(concept_id)
        .bind(img_id)
        .execute(&mut *tx)
        .await;
    }
    tx.commit().await?;

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    let _ = apply_concept_tags_to_samples(db, &concept, image_ids).await;

    Ok(concept)
}

pub async fn remove_concept_sample_logic(
    db: &SqlitePool,
    concept_id: i64,
    image_id: i64,
    model_manager: &ModelManager,
) -> Result<CustomConcept> {
    sqlx::query("DELETE FROM custom_concept_samples WHERE concept_id = ? AND image_id = ?")
        .bind(concept_id)
        .bind(image_id)
        .execute(db)
        .await?;

    if let Ok(concept) = get_custom_concept_by_id(db, concept_id).await {
        let _ = sqlx::query(
            "DELETE FROM image_tags WHERE image_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
        )
        .bind(image_id)
        .bind(&concept.name)
        .execute(db)
        .await;
    }

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    get_custom_concept_by_id(db, concept_id).await
}

pub async fn sync_all_custom_concept_tags(db: &SqlitePool) -> Result<()> {
    let concepts = list_concepts_logic(db).await?;
    for concept in concepts {
        let sample_rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
        )
        .bind(concept.id)
        .fetch_all(db)
        .await?;

        let sample_ids: Vec<i64> = sample_rows.into_iter().map(|r| r.0).collect();
        if !sample_ids.is_empty() {
            let _ = apply_concept_tags_to_samples(db, &concept, &sample_ids).await;
        }
    }
    Ok(())
}

pub async fn clean_auto_concept_tags_logic(
    db: &SqlitePool,
    concept_id: Option<i64>,
) -> Result<u64> {
    let rows_affected = match concept_id {
        Some(c_id) => {
            let concept = get_custom_concept_by_id(db, c_id).await?;
            let res = sqlx::query(
                "DELETE FROM image_tags
                 WHERE tag_id = (SELECT id FROM tags WHERE name = ?)
                   AND image_id NOT IN (
                     SELECT image_id FROM custom_concept_samples WHERE concept_id = ?
                   )",
            )
            .bind(&concept.name)
            .bind(c_id)
            .execute(db)
            .await?;
            res.rows_affected()
        }
        None => {
            let res = sqlx::query(
                "DELETE FROM image_tags
                 WHERE id IN (
                   SELECT it.id
                   FROM image_tags it
                   JOIN tags t ON it.tag_id = t.id
                   JOIN custom_concepts c ON c.name = t.name
                   WHERE it.image_id NOT IN (
                     SELECT image_id FROM custom_concept_samples WHERE concept_id = c.id
                   )
                 )",
            )
            .execute(db)
            .await?;
            res.rows_affected()
        }
    };

    Ok(rows_affected)
}

pub async fn rescan_concept_logic(
    db: &SqlitePool,
    concept_id: i64,
    model_manager: &ModelManager,
    vector_index: &curator_core::vector::VectorIndex,
) -> Result<usize> {
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;
    let sample_ids: Vec<i64> = sample_rows.into_iter().map(|r| r.0).collect();
    if !sample_ids.is_empty() {
        let _ = apply_concept_tags_to_samples(db, &concept, &sample_ids).await;
    }

    // Clean up any stale auto-tags on non-samples
    let _ = clean_auto_concept_tags_logic(db, Some(concept_id)).await;

    let active_model = model_manager.active_model();
    let source_name = active_model.source_name();
    let source_id = match resolve_source_id(db, source_name).await {
        Ok(id) => id,
        Err(_) => return Ok(0),
    };

    let vec_row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT vector FROM custom_concept_vectors WHERE concept_id = ? AND source_id = ? LIMIT 1",
    )
    .bind(concept_id)
    .bind(source_id)
    .fetch_optional(db)
    .await?;

    let proto_vec = match vec_row {
        Some((blob,)) => bytes_to_vector(&blob),
        None => return Ok(0),
    };

    if proto_vec.is_empty() {
        return Ok(0);
    }

    // HNSW expansion of 10k candidates is CPU-bound — off the reactor.
    let results = tokio::task::block_in_place(|| vector_index.search(&proto_vec, 10000))?;
    let mut match_count = 0usize;
    for (_id, dist) in results {
        let sim = 1.0 - dist;
        if sim >= concept.threshold {
            match_count += 1;
        }
    }

    Ok(match_count)
}
