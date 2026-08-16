use anyhow::Result;
use sqlx::SqlitePool;

use super::sources::SourceRepo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CustomConceptRecord {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub threshold: f32,
    pub sample_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

pub struct ConceptRepo;

impl ConceptRepo {
    /// Fetch single concept details by ID.
    pub async fn get_concept(db: &SqlitePool, concept_id: i64) -> Result<CustomConceptRecord> {
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

        Ok(CustomConceptRecord {
            id: row.0,
            name: row.1,
            category: row.2,
            threshold: row.3 as f32,
            sample_count: row.4 as usize,
            created_at: row.5,
            updated_at: row.6,
        })
    }

    /// List all custom concepts sorted by latest update.
    pub async fn list_concepts(db: &SqlitePool) -> Result<Vec<CustomConceptRecord>> {
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
            .map(|r| CustomConceptRecord {
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

    /// Upsert concept record (insert or update category & threshold).
    pub async fn upsert_concept(
        db: &SqlitePool,
        name: &str,
        category: &str,
        threshold: f32,
    ) -> Result<i64> {
        let existing: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM custom_concepts WHERE name = ? LIMIT 1")
                .bind(name)
                .fetch_optional(db)
                .await?;

        let id = match existing {
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
                .bind(name)
                .bind(category)
                .bind(threshold as f64)
                .execute(db)
                .await?;
                res.last_insert_rowid()
            }
        };

        Ok(id)
    }

    /// Update category and/or threshold for an existing concept.
    pub async fn update_concept(
        db: &SqlitePool,
        id: i64,
        threshold: Option<f32>,
        category: Option<String>,
    ) -> Result<CustomConceptRecord> {
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

        Self::get_concept(db, id).await
    }

    /// Delete a concept and all associated sample links and vectors.
    pub async fn delete_concept(db: &SqlitePool, id: i64) -> Result<()> {
        sqlx::query("DELETE FROM custom_concepts WHERE id = ?")
            .bind(id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// Add positive sample images to a concept.
    pub async fn add_samples(
        db: &SqlitePool,
        concept_id: i64,
        image_ids: &[i64],
    ) -> Result<()> {
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
        Ok(())
    }

    /// Remove a sample image from a concept.
    pub async fn remove_sample(
        db: &SqlitePool,
        concept_id: i64,
        image_id: i64,
    ) -> Result<()> {
        sqlx::query("DELETE FROM custom_concept_samples WHERE concept_id = ? AND image_id = ?")
            .bind(concept_id)
            .bind(image_id)
            .execute(db)
            .await?;
        Ok(())
    }

    /// Get all positive sample image IDs for a concept.
    pub async fn get_sample_ids(db: &SqlitePool, concept_id: i64) -> Result<Vec<i64>> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT image_id FROM custom_concept_samples WHERE concept_id = ? AND is_negative = 0",
        )
        .bind(concept_id)
        .fetch_all(db)
        .await?;

        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Link concept tags to sample images.
    pub async fn apply_concept_tags_to_samples(
        db: &SqlitePool,
        concept_name: &str,
        concept_category: &str,
        sample_image_ids: &[i64],
    ) -> Result<()> {
        let concept_source_id = SourceRepo::resolve_source_id(db, "ai:custom-concepts").await?;

        let tag_row: (i64,) = sqlx::query_as(
            "INSERT INTO tags (name, category) VALUES (?, ?)
             ON CONFLICT(name) DO UPDATE SET category = excluded.category
             RETURNING id",
        )
        .bind(concept_name)
        .bind(concept_category)
        .fetch_one(db)
        .await?;
        let tag_id = tag_row.0;

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

    /// Clean auto-tagged concept labels from images that are not positive samples.
    pub async fn clean_auto_concept_tags(
        db: &SqlitePool,
        concept_id: Option<i64>,
    ) -> Result<u64> {
        let rows_affected = match concept_id {
            Some(c_id) => {
                let concept = Self::get_concept(db, c_id).await?;
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

    /// Save custom concept vector BLOB into `custom_concept_vectors`.
    pub async fn save_concept_vector(
        db: &SqlitePool,
        concept_id: i64,
        source_id: i64,
        vector_bytes: &[u8],
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO custom_concept_vectors (concept_id, source_id, vector, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(concept_id, source_id) DO UPDATE SET vector = excluded.vector, updated_at = CURRENT_TIMESTAMP"
        )
        .bind(concept_id)
        .bind(source_id)
        .bind(vector_bytes)
        .execute(db)
        .await?;

        sqlx::query("UPDATE custom_concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(concept_id)
            .execute(db)
            .await?;

        Ok(())
    }

    /// Load custom concept vector BLOB.
    pub async fn get_concept_vector(
        db: &SqlitePool,
        concept_id: i64,
        source_id: i64,
    ) -> Result<Option<Vec<u8>>> {
        let row: Option<(Vec<u8>,)> = sqlx::query_as(
            "SELECT vector FROM custom_concept_vectors WHERE concept_id = ? AND source_id = ? LIMIT 1",
        )
        .bind(concept_id)
        .bind(source_id)
        .fetch_optional(db)
        .await?;

        Ok(row.map(|(b,)| b))
    }
}
