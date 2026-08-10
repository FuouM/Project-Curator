use curator_core::db::models::Image;
use curator_core::ipc::EmbeddingModel;
use curator_core::vector::{ModelManager, VectorIndex};
use sha2::Digest;
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info, warn};

pub struct BackgroundWorker {
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
}

const INDEX_SAVE_BATCH_INTERVAL: u32 = 8;

struct PreprocessedBatch {
    images: Vec<Image>,
    preprocessed_buffers: Vec<Result<Vec<u8>, anyhow::Error>>,
    source_id: i64,
}

impl BackgroundWorker {
    pub fn new(
        db: SqlitePool,
        model_manager: Arc<ModelManager>,
        vector_index: Arc<VectorIndex>,
    ) -> Self {
        Self {
            db,
            model_manager,
            vector_index,
        }
    }

    pub fn start(self) {
        // Reset any leftover 'preprocessing' states to 'pending' on startup,
        // and reconcile debounced-index saves: any 'ready' row for the active
        // source that is missing from the on-disk USearch index (e.g. after a
        // crash between batches) is reset to 'pending' so it is re-indexed.
        let db_startup = self.db.clone();
        let vi_startup = self.vector_index.clone();
        let mm_startup = self.model_manager.clone();
        tokio::spawn(async move {
            let active = mm_startup.active_model();
            let source_name = match active {
                EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
                EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
            };
            if let Ok((source_id,)) =
                sqlx::query_as::<_, (i64,)>("SELECT id FROM sources WHERE name = ? LIMIT 1")
                    .bind(source_name)
                    .fetch_one(&db_startup)
                    .await
            {
                let ready_ids: Vec<(i64,)> = sqlx::query_as(
                    "SELECT image_id FROM image_vectors WHERE source_id = ? AND vector_state = 'ready'",
                )
                .bind(source_id)
                .fetch_all(&db_startup)
                .await
                .unwrap_or_default();
                let stale: Vec<i64> = ready_ids
                    .into_iter()
                    .map(|r| r.0)
                    .filter(|id| !vi_startup.contains(*id as u64))
                    .collect();
                if !stale.is_empty() {
                    let ph = stale.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "UPDATE image_vectors SET vector_state = 'pending' WHERE source_id = ? AND image_id IN ({})",
                        ph
                    );
                    let mut q = sqlx::query(&sql).bind(source_id);
                    for id in &stale {
                        q = q.bind(*id);
                    }
                    if let Err(e) = q.execute(&db_startup).await {
                        warn!("Failed to reconcile stale index state on startup: {:?}", e);
                    } else {
                        warn!("Reset {} ready rows missing from index to pending", stale.len());
                    }
                }
            }
            if let Err(e) = sqlx::query("UPDATE image_vectors SET vector_state = 'pending' WHERE vector_state = 'preprocessing'")
                .execute(&db_startup)
                .await
            {
                warn!("Failed to reset transient preprocessing states on startup: {:?}", e);
            }
        });

        // Background missing-image reconciler: checks file existence periodically
        {
            let db_recon = self.db.clone();
            tokio::spawn(async move {
                info!("Missing-image reconciler started.");
                loop {
                    sleep(Duration::from_secs(300)).await;
                    if let Err(e) = reconcile_missing_images(&db_recon).await {
                        warn!("Missing-image reconciler failed: {:?}", e);
                    }
                }
            });
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel::<PreprocessedBatch>(1);
        let db_pre = self.db.clone();
        let mm_pre = self.model_manager.clone();

        // Stage 1 Task: CPU-bound image reading, decoding, cropping, and resizing (Parallelized Preprocessing)
        tokio::spawn(async move {
            info!("Pipelined preprocessing stage started.");
            loop {
                let active = mm_pre.active_model();
                let source_name = match active {
                    EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
                    EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
                };

                // Fetch source_id for active model
                let source_id = match sqlx::query_as::<_, (i64,)>(
                    "SELECT id FROM sources WHERE name = ? LIMIT 1",
                )
                .bind(source_name)
                .fetch_one(&db_pre)
                .await
                {
                    Ok(r) => r.0,
                    Err(e) => {
                        error!("Preprocessing task failed to fetch source_id: {:?}", e);
                        sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                };

                // Query for images that have pending vector indexing (fetch up to 16 for batching)
                let pending_images: Vec<Image> = match sqlx::query_as::<_, Image>(
                    "SELECT i.* FROM images i
                     JOIN image_vectors iv ON i.id = iv.image_id
                     WHERE iv.vector_state = 'pending' AND iv.source_id = ? AND i.deleted_at IS NULL
                     LIMIT 16",
                )
                .bind(source_id)
                .fetch_all(&db_pre)
                .await
                {
                    Ok(imgs) => imgs,
                    Err(e) => {
                        error!("Preprocessing task failed to query pending images: {:?}", e);
                        sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                };

                if pending_images.is_empty() {
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }

                // Mark images as 'preprocessing' in the DB so they are not processed by other runs
                let image_ids: Vec<i64> = pending_images.iter().map(|img| img.id).collect();
                let placeholders = image_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let update_sql = format!(
                    "UPDATE image_vectors SET vector_state = 'preprocessing' WHERE source_id = ? AND image_id IN ({})",
                    placeholders
                );
                let mut query = sqlx::query(&update_sql).bind(source_id);
                for id in &image_ids {
                    query = query.bind(*id);
                }
                if let Err(e) = query.execute(&db_pre).await {
                    error!(
                        "Preprocessing task failed to mark vectors as preprocessing: {:?}",
                        e
                    );
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }

                info!("Preprocessing batch of {} images...", pending_images.len());

                // CPU-bound parallel preprocessing (reading, decoding, cropping, resizing)
                let mm = mm_pre.clone();
                let paths: Vec<String> = pending_images
                    .iter()
                    .map(|img| {
                        curator_core::video::decode_path(
                            &img.current_filepath,
                            img.video_frame_path.as_deref(),
                        )
                        .to_string_lossy()
                        .into_owned()
                    })
                    .collect();
                let preprocessed_res =
                    tokio::task::spawn_blocking(move || mm.preprocess_image_batch(&paths)).await;

                let preprocessed_buffers = match preprocessed_res {
                    Ok(Ok(bufs)) => bufs,
                    Ok(Err(e)) => {
                        error!("Error in parallel batch preprocessing: {:?}", e);
                        // Revert DB states
                        let revert_sql = format!(
                            "UPDATE image_vectors SET vector_state = 'pending' WHERE source_id = ? AND image_id IN ({})",
                            placeholders
                        );
                        let mut q = sqlx::query(&revert_sql).bind(source_id);
                        for id in &image_ids {
                            q = q.bind(*id);
                        }
                        let _ = q.execute(&db_pre).await;
                        sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                    Err(e) => {
                        error!("Task join error during batch preprocessing: {:?}", e);
                        sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                };

                // Push the preprocessed batch to Stage 2
                if tx
                    .send(PreprocessedBatch {
                        images: pending_images,
                        preprocessed_buffers,
                        source_id,
                    })
                    .await
                    .is_err()
                {
                    info!("Preprocessing channel closed. Exiting preprocessing task.");
                    break;
                }
            }
        });

        // Stage 2 Task: ONNX Inference, Vector Indexing, and Database Writes
        let db_inf = self.db.clone();
        let mm_inf = self.model_manager.clone();
        let vi_inf = self.vector_index.clone();

        tokio::spawn(async move {
            info!("Pipelined indexing/inference stage started.");
            let mut batches_since_save: u32 = 0;
            while let Some(batch) = rx.recv().await {
                info!(
                    "Indexing preprocessed batch of {} images...",
                    batch.images.len()
                );

                let mm = mm_inf.clone();
                let preprocessed_bufs = batch.preprocessed_buffers;
                let images = batch.images;
                let source_id = batch.source_id;

                // Run inference on the preprocessed batch (ONNX + Normalization)
                let inference_res = tokio::task::spawn_blocking(move || {
                    mm.run_inference_on_preprocessed_batch(&preprocessed_bufs)
                })
                .await;

                match inference_res {
                    Ok(Ok(embeddings_results)) => {
                        let mut added_any = false;

                        // Batch all per-image state updates into a single transaction
                        let mut tx = match db_inf.begin().await {
                            Ok(tx) => tx,
                            Err(e) => {
                                error!("Failed to begin index state transaction: {:?}", e);
                                continue;
                            }
                        };
                        for (image, emb_res) in images.into_iter().zip(embeddings_results) {
                            match emb_res {
                                Ok(embedding) => {
                                    // Add to USearch index in memory (persisted periodically)
                                    if let Err(e) = vi_inf.add_without_save(image.id as u64, &embedding)
                                    {
                                        error!(
                                            "Failed to index vector in USearch for image {}: {:?}",
                                            image.id, e
                                        );
                                        let _ = sqlx::query("UPDATE image_vectors SET vector_state = 'failed' WHERE image_id = ? AND source_id = ?")
                                            .bind(image.id)
                                            .bind(source_id)
                                            .execute(&mut *tx)
                                            .await;
                                        continue;
                                    }
                                    added_any = true;

                                    // Compute checksum (simple SHA256 of the embedding floats for auditing)
                                    let checksum = format!(
                                        "{:x}",
                                        sha2::Sha256::digest(bytemuck::cast_slice(&embedding))
                                    );

                                    // Update SQLite database to set state to ready.
                                    // BLOB layout is native-endian (bytemuck cast_slice) and is
                                    // only ever read back on the same machine via bytes_to_vector
                                    // (explicit LE) - NOT portable across endianness.
                                    let update_res = sqlx::query(
                                        "UPDATE image_vectors 
                                         SET vector_state = 'ready', vector_id = ?, vector_checksum = ?, vector = ?, created_at = CURRENT_TIMESTAMP
                                         WHERE image_id = ? AND source_id = ?"
                                    )
                                    .bind(image.id.to_string())
                                    .bind(checksum)
                                    .bind(bytemuck::cast_slice(&embedding))
                                    .bind(image.id)
                                    .bind(source_id)
                                    .execute(&mut *tx)
                                    .await;

                                    if let Err(e) = update_res {
                                        error!("Failed to update image_vectors in DB for image {}: {:?}", image.id, e);
                                    }
                                }
                                Err(e) => {
                                    error!("Inference error for image {}: {:?}", image.id, e);
                                    let _ = sqlx::query("UPDATE image_vectors SET vector_state = 'failed' WHERE image_id = ? AND source_id = ?")
                                        .bind(image.id)
                                        .bind(source_id)
                                        .execute(&mut *tx)
                                        .await;
                                }
                            }
                        }
                        if let Err(e) = tx.commit().await {
                            error!("Failed to commit index state transaction: {:?}", e);
                        }

                        // Debounce USearch persistence: a full index save is expensive,
                        // so only flush to disk every N batches instead of every batch.
                        batches_since_save += 1;
                        if added_any && (batches_since_save >= INDEX_SAVE_BATCH_INTERVAL || rx.is_empty()) {
                            batches_since_save = 0;
                            if let Err(e) = vi_inf.save() {
                                error!("Failed to save USearch index after batch processing: {:?}", e);
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        error!("Batch inference failed: {:?}", e);
                        for image in images {
                            let _ = sqlx::query("UPDATE image_vectors SET vector_state = 'failed' WHERE image_id = ? AND source_id = ?")
                                .bind(image.id)
                                .bind(source_id)
                                .execute(&db_inf)
                                .await;
                        }
                    }
                    Err(e) => {
                        error!("Task join error during batch inference: {:?}", e);
                        for image in images {
                            let _ = sqlx::query("UPDATE image_vectors SET vector_state = 'failed' WHERE image_id = ? AND source_id = ?")
                                .bind(image.id)
                                .bind(source_id)
                                .execute(&db_inf)
                                .await;
                        }
                    }
                }
            }
        });
    }
}

use std::path::Path;

async fn reconcile_missing_images(db: &SqlitePool) -> Result<(), anyhow::Error> {
    info!("Running missing-image reconciliation...");

    let batch_size: i64 = 1000;
    let mut offset: i64 = 0;

    loop {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, current_filepath FROM images WHERE is_missing = 0 AND deleted_at IS NULL LIMIT ? OFFSET ?",
        )
        .bind(batch_size)
        .bind(offset)
        .fetch_all(db)
        .await?;

        if rows.is_empty() {
            break;
        }

        let mut newly_missing = Vec::new();
        for (id, filepath) in &rows {
            if !Path::new(filepath).exists() {
                newly_missing.push(*id);
            }
        }

        if !newly_missing.is_empty() {
            let ph = newly_missing.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE images SET is_missing = 1 WHERE id IN ({})", ph);
            let mut q = sqlx::query(&sql);
            for id in &newly_missing {
                q = q.bind(id);
            }
            q.execute(db).await?;
            info!("Marked {} images as missing", newly_missing.len());
        }

        offset += batch_size;
    }

    let recheck_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, current_filepath FROM images WHERE is_missing = 1 AND deleted_at IS NULL LIMIT 500",
    )
    .fetch_all(db)
    .await?;

    let mut reappeared = Vec::new();
    for (id, filepath) in &recheck_rows {
        if Path::new(filepath).exists() {
            reappeared.push(id);
        }
    }

    if !reappeared.is_empty() {
        let ph = reappeared.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE images SET is_missing = 0 WHERE id IN ({})", ph);
        let mut q = sqlx::query(&sql);
        for id in &reappeared {
            q = q.bind(id);
        }
        q.execute(db).await?;
        info!("Re-found {} previously missing images", reappeared.len());
    }

    Ok(())
}
