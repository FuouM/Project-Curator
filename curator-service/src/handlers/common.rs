use anyhow::Result;
use curator_core::ipc::TagSummary;
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

pub fn sort_tags_by_priority(tags: &mut [TagSummary]) {
    tags.sort_by(|a, b| {
        let priority = |t: &TagSummary| -> i32 {
            if t.source_name.as_deref() == Some("ai:custom-concepts") || t.category == "user" {
                -1
            } else {
                match t.category.as_str() {
                    "character" => 1,
                    "copyright" => 2,
                    "meta" => 3,
                    _ => 4,
                }
            }
        };

        let p_a = priority(a);
        let p_b = priority(b);

        if p_a != p_b {
            p_a.cmp(&p_b)
        } else {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });
}
