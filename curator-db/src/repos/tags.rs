use anyhow::Result;
use sqlx::SqlitePool;

use crate::models::TagStat;
use super::sources::SourceRepo;

pub struct TagRepo;

impl TagRepo {
    /// Insert a tag row (or fetch its existing id) inside an ongoing transaction.
    /// The first-inserted category wins; when the insert returns no row the
    /// existing id is selected by name.
    pub async fn upsert_tag_id(
        tx: &mut sqlx::SqliteConnection,
        name: &str,
        category: &str,
    ) -> Result<i64> {
        let tag_row: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO tags (name, category) VALUES (?, ?)
             ON CONFLICT(name) DO NOTHING
             RETURNING id",
        )
        .bind(name)
        .bind(category)
        .fetch_optional(&mut *tx)
        .await?;

        match tag_row {
            Some((id,)) => Ok(id),
            None => {
                let existing: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ?")
                    .bind(name)
                    .fetch_one(&mut *tx)
                    .await?;
                Ok(existing.0)
            }
        }
    }

    /// Add a user tag to an image.
    pub async fn add_user_tag(
        db: &SqlitePool,
        image_id: i64,
        tag: &str,
        category: &str,
    ) -> Result<()> {
        let source_id = SourceRepo::resolve_source_id(db, "user").await?;

        let mut tx = db.begin().await?;
        let tag_id = Self::upsert_tag_id(&mut tx, tag, category).await?;

        sqlx::query(
            "INSERT OR REPLACE INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted)
             VALUES (?, ?, ?, 1.0, 0)",
        )
        .bind(image_id)
        .bind(tag_id)
        .bind(source_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(())
    }

    /// Remove / blacklist a tag for an image.
    pub async fn remove_tag(
        db: &SqlitePool,
        image_id: i64,
        tag: &str,
    ) -> Result<()> {
        let tag_res: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                .bind(tag)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

        if let Some((tag_id,)) = tag_res {
            let source_row: Option<(i64, String)> = sqlx::query_as(
                "SELECT s.id, s.name FROM image_tags it
                 JOIN sources s ON it.source_id = s.id
                 WHERE it.image_id = ? AND it.tag_id = ? AND it.is_deleted = 0
                 LIMIT 1",
            )
            .bind(image_id)
            .bind(tag_id)
            .fetch_optional(db)
            .await
            .unwrap_or(None);

            if let Some((source_id, source_name)) = source_row {
                if source_name == "ai:custom-concepts" {
                    let _ = sqlx::query(
                        "DELETE FROM image_tags WHERE image_id = ? AND tag_id = ? AND source_id = ?",
                    )
                    .bind(image_id)
                    .bind(tag_id)
                    .bind(source_id)
                    .execute(db)
                    .await;
                } else {
                    let is_ai_source = source_name.starts_with("ai:");
                    let is_blacklisted_val = if is_ai_source { 1i64 } else { 0i64 };

                    sqlx::query(
                        "UPDATE image_tags
                         SET is_deleted = 1, is_blacklisted = ?, deleted_at = CURRENT_TIMESTAMP
                         WHERE image_id = ? AND tag_id = ? AND source_id = ?",
                    )
                    .bind(is_blacklisted_val)
                    .bind(image_id)
                    .bind(tag_id)
                    .bind(source_id)
                    .execute(db)
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// Un-blacklist a tag that was previously removed.
    pub async fn unblacklist_tag(
        db: &SqlitePool,
        image_id: i64,
        tag: &str,
    ) -> Result<()> {
        let tag_res: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                .bind(tag)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

        if let Some((tag_id,)) = tag_res {
            let source_row: Option<(i64,)> = sqlx::query_as(
                "SELECT source_id FROM image_tags
                 WHERE image_id = ? AND tag_id = ? AND is_blacklisted = 1
                 LIMIT 1",
            )
            .bind(image_id)
            .bind(tag_id)
            .fetch_optional(db)
            .await
            .unwrap_or(None);

            if let Some((source_id,)) = source_row {
                sqlx::query(
                    "UPDATE image_tags
                     SET is_deleted = 0, is_blacklisted = 0, deleted_at = NULL
                     WHERE image_id = ? AND tag_id = ? AND source_id = ?",
                )
                .bind(image_id)
                .bind(tag_id)
                .bind(source_id)
                .execute(db)
                .await?;
            }
        }
        Ok(())
    }

    /// Fetch tag count statistics for a given preferred source.
    pub async fn get_tag_statistics(
        db: &SqlitePool,
        preferred_source: &str,
    ) -> Result<Vec<TagStat>> {
        let source_id = SourceRepo::resolve_source_id(db, preferred_source).await.unwrap_or(0);
        let tags = sqlx::query_as::<_, TagStat>(
            r#"
            SELECT t.name AS tag, t.category AS category, g.count AS count
            FROM (
                SELECT tag_id, COUNT(*) AS count
                FROM image_tags
                WHERE is_deleted = 0 AND source_id = ?
                GROUP BY tag_id
            ) g
            JOIN tags t ON t.id = g.tag_id
            ORDER BY count DESC
            "#,
        )
        .bind(source_id)
        .fetch_all(db)
        .await?;

        Ok(tags)
    }

    /// Autocomplete / suggest character tags matching an optional substring query.
    pub async fn get_character_suggestions(
        db: &SqlitePool,
        query: Option<&str>,
    ) -> Result<Vec<TagStat>> {
        let tags = if let Some(q) = query {
            let pattern = format!("%{}%", q);
            sqlx::query_as::<_, TagStat>(
                r#"
                SELECT 
                    t.name AS tag, 
                    t.category AS category, 
                    0 AS count
                FROM tags t
                WHERE t.category = 'character' AND t.name LIKE ?
                ORDER BY t.name ASC
                LIMIT 30
                "#,
            )
            .bind(pattern)
            .fetch_all(db)
            .await?
        } else {
            sqlx::query_as::<_, TagStat>(
                r#"
                SELECT 
                    t.name AS tag, 
                    t.category AS category, 
                    0 AS count
                FROM tags t
                WHERE t.category = 'character'
                ORDER BY t.name ASC
                LIMIT 30
                "#,
            )
            .fetch_all(db)
            .await?
        };

        Ok(tags)
    }
}
