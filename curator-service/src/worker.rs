use curator_core::db::models::Image;
use curator_core::vector::{ModelManager, VectorIndex};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info};
use sha2::Digest;

pub struct BackgroundWorker {
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
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
        tokio::spawn(async move {
            info!("Background job worker started.");
            loop {
                if let Err(e) = self.process_jobs().await {
                    error!("Error in background job worker: {:?}", e);
                }
                // Sleep for a short interval before polling again
                sleep(Duration::from_secs(3)).await;
            }
        });
    }

    async fn process_jobs(&self) -> Result<(), anyhow::Error> {
        // Query for images that have pending vector indexing
        // We look for images that do not have a ready vector in `image_vectors`
        // or where `vector_state = 'pending'`
        let pending_images: Vec<Image> = sqlx::query_as(
            "SELECT i.* FROM images i
             JOIN image_vectors iv ON i.id = iv.image_id
             WHERE iv.vector_state = 'pending' AND i.deleted_at IS NULL
             LIMIT 10"
        )
        .fetch_all(&self.db)
        .await?;

        if !pending_images.is_empty() {
            info!("Found {} pending images to index.", pending_images.len());
        }

        // Fetch source_id for CLIP model (we register the model as a source)
        let source_row: (i64,) = sqlx::query_as(
            "SELECT id FROM sources WHERE name = 'ai:clip-vit-b-32' LIMIT 1"
        )
        .fetch_one(&self.db)
        .await?;
        let source_id = source_row.0;

        for image in pending_images {
            info!("Processing embedding for image ID {} path {:?}", image.id, image.current_filepath);

            match self.model_manager.generate_image_embedding(&image.current_filepath) {
                Ok(embedding) => {
                    // Save to USearch index
                    if let Err(e) = self.vector_index.add(image.id as u64, &embedding) {
                        error!("Failed to index vector in USearch for image {}: {:?}", image.id, e);
                        self.mark_vector_failed(image.id, source_id).await?;
                        continue;
                    }

                    // Compute checksum (simple SHA256 of the embedding floats for auditing)
                    let checksum = format!("{:x}", sha2::Sha256::digest(bytemuck::cast_slice(&embedding)));

                    // Update SQLite database to set state to ready
                    sqlx::query(
                        "UPDATE image_vectors 
                         SET vector_state = 'ready', vector_id = ?, vector_checksum = ?, created_at = CURRENT_TIMESTAMP
                         WHERE image_id = ? AND source_id = ?"
                    )
                    .bind(image.id.to_string())
                    .bind(checksum)
                    .bind(image.id)
                    .bind(source_id)
                    .execute(&self.db)
                    .await?;

                    info!("Successfully indexed image ID {}.", image.id);
                }
                Err(e) => {
                    error!("Failed to generate embedding for image {}: {:?}", image.id, e);
                    self.mark_vector_failed(image.id, source_id).await?;
                }
            }
        }

        Ok(())
    }

    async fn mark_vector_failed(&self, image_id: i64, source_id: i64) -> Result<(), anyhow::Error> {
        sqlx::query(
            "UPDATE image_vectors 
             SET vector_state = 'failed' 
             WHERE image_id = ? AND source_id = ?"
        )
        .bind(image_id)
        .bind(source_id)
        .execute(&self.db)
        .await?;
        Ok(())
    }
}
