use anyhow::Result;

use curator_core::vector::VectorIndex;
use sqlx::SqlitePool;

pub async fn resolve_source_id(db: &SqlitePool, name: &str) -> Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
        .bind(name)
        .fetch_one(db)
        .await?;
    Ok(row.0)
}

/// Clear the in-memory vector index and mark every image's vector for the given
/// source as `pending` so the worker recomputes and reindexes them all.
pub async fn reindex_all_pending(
    db: &SqlitePool,
    vector_index: &VectorIndex,
    source_id: i64,
) -> Result<()> {
    if let Err(e) = vector_index.clear() {
        return Err(anyhow::anyhow!("Failed to clear index: {:?}", e));
    }

    let sql = "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state, vector_checksum)
               SELECT id, ?, '', 'pending', NULL FROM images WHERE deleted_at IS NULL
               ON CONFLICT(image_id, source_id) DO UPDATE SET vector_state = 'pending', vector_id = '', vector_checksum = NULL";
    sqlx::query(sql).bind(source_id).execute(db).await?;

    Ok(())
}

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
