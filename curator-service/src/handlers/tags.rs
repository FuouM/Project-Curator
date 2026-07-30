use anyhow::Result;
use sqlx::SqlitePool;

use super::common::resolve_source_id;

pub async fn add_tag_logic(
    image_id: i64,
    tag: &str,
    category: &str,
    db: &SqlitePool,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
        .bind(tag)
        .bind(category)
        .execute(db)
        .await?;

    let tag_row: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
        .bind(tag)
        .fetch_one(db)
        .await?;
    let tag_id = tag_row.0;

    let source_id = resolve_source_id(db, "user").await?;

    sqlx::query(
        "INSERT OR REPLACE INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted)
         VALUES (?, ?, ?, 1.0, 0)",
    )
    .bind(image_id)
    .bind(tag_id)
    .bind(source_id)
    .execute(db)
    .await?;

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
    let source_name = match active_model {
        curator_core::ipc::EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        curator_core::ipc::EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let source_id = resolve_source_id(db, source_name).await?;

    if let Err(e) = vector_index.clear() {
        return Err(anyhow::anyhow!("Failed to clear index: {:?}", e));
    }

    let sql = "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state, vector_checksum)
               SELECT id, ?, '', 'pending', NULL FROM images WHERE deleted_at IS NULL
               ON CONFLICT(image_id, source_id) DO UPDATE SET vector_state = 'pending', vector_id = '', vector_checksum = NULL";
    sqlx::query(sql).bind(source_id).execute(db).await?;

    Ok(())
}

pub async fn reindex_failed_vectors_logic(
    db: &SqlitePool,
    active_model: curator_core::ipc::EmbeddingModel,
) -> Result<i64> {
    let source_name = match active_model {
        curator_core::ipc::EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        curator_core::ipc::EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
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
    db: &SqlitePool,
) -> Result<Vec<curator_core::ipc::TagStat>> {
    let tags = sqlx::query_as::<_, curator_core::ipc::TagStat>(
        r#"
        SELECT t.name AS tag, t.category AS category, COUNT(*) AS count
        FROM image_tags it
        JOIN tags t ON t.id = it.tag_id
        WHERE it.is_deleted = 0
        GROUP BY it.tag_id
        ORDER BY count DESC
        "#,
    )
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
