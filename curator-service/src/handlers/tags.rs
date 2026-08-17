use anyhow::Result;
use sqlx::SqlitePool;

use super::common::{reindex_all_pending, resolve_source_id};

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
         WHERE source_id = ? AND vector_state = 'failed'",
    )
    .bind(source_id)
    .execute(db)
    .await?;

    Ok(result.rows_affected() as i64)
}
