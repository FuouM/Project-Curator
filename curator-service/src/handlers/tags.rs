use anyhow::Result;
use sqlx::SqlitePool;

use super::common::{reindex_all_pending, resolve_source_id};

pub async fn add_tag_logic(
    image_id: i64,
    tag: &str,
    category: &str,
    db: &SqlitePool,
) -> Result<()> {
    let source_id = resolve_source_id(db, "user").await?;

    // Insert tag without clobbering an existing category; when the tag already
    // exists, the insert returns no row and we fetch its id by name.
    let mut tx = db.begin().await?;
    let tag_row: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO tags (name, category) VALUES (?, ?)
         ON CONFLICT(name) DO NOTHING
         RETURNING id",
    )
    .bind(tag)
    .bind(category)
    .fetch_optional(&mut *tx)
    .await?;

    let tag_id = match tag_row {
        Some((id,)) => id,
        None => {
            let existing: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ?")
                .bind(tag)
                .fetch_one(&mut *tx)
                .await?;
            existing.0
        }
    };

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

pub async fn remove_tag_logic(
    image_id: i64,
    tag: &str,
    db: &SqlitePool,
) -> Result<()> {
    let tag_res: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
            .bind(tag)
            .fetch_optional(db)
            .await
            .unwrap_or(None);

    if let Some((tag_id,)) = tag_res {
        // Find which source owns this active tag for this image
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
                // Hard-delete concept tags
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

                // Only mark this source's row as deleted — don't touch other sources
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

pub async fn unblacklist_tag_logic(
    image_id: i64,
    tag: &str,
    db: &SqlitePool,
) -> Result<()> {
    let tag_res: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
            .bind(tag)
            .fetch_optional(db)
            .await
            .unwrap_or(None);

    if let Some((tag_id,)) = tag_res {
        // Find the source that blacklisted this tag
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

pub async fn reindex_vectors_logic(
    db: &SqlitePool,
    vector_index: &curator_core::vector::VectorIndex,
    active_model: curator_core::ipc::EmbeddingModel,
) -> Result<()> {
    let source_name = active_model.source_name();
    let source_id = resolve_source_id(db, source_name).await?;

    reindex_all_pending(db, vector_index, source_id).await
}

pub async fn reindex_failed_vectors_logic(
    db: &SqlitePool,
    active_model: curator_core::ipc::EmbeddingModel,
) -> Result<i64> {
    let source_name = active_model.source_name();
    let source_id = resolve_source_id(db, source_name).await?;

    let result = sqlx::query(
        "UPDATE image_vectors SET vector_state = 'pending', vector_id = '', vector_checksum = NULL
         WHERE source_id = ? AND vector_state = 'failed'"
    )
    .bind(source_id)
    .execute(db)
    .await?;

    Ok(result.rows_affected() as i64)
}

pub async fn set_favorite_logic(
    image_id: i64,
    favorite: bool,
    db: &SqlitePool,
) -> Result<()> {
    let fav_val = if favorite { 1 } else { 0 };
    sqlx::query("UPDATE images SET favorite = ? WHERE id = ?")
        .bind(fav_val)
        .bind(image_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn get_tag_statistics_logic(
    preferred_source: &str,
    db: &SqlitePool,
) -> Result<Vec<curator_core::ipc::TagStat>> {
    let source_id = resolve_source_id(db, preferred_source).await.unwrap_or(0);
    let tags = sqlx::query_as::<_, curator_core::ipc::TagStat>(
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

pub async fn get_character_suggestions_logic(
    db: &SqlitePool,
    query: Option<&str>,
) -> Result<Vec<curator_core::ipc::TagStat>> {
    let tags = if let Some(q) = query {
        let pattern = format!("%{}%", q);
        sqlx::query_as::<_, curator_core::ipc::TagStat>(
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
        sqlx::query_as::<_, curator_core::ipc::TagStat>(
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
