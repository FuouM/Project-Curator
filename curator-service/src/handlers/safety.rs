use anyhow::{Result, bail};
use curator_core::grpc::import::{RescanSafetyResult, SafetyRescanProgress};
use curator_core::image_decode::decode_rgb;
use curator_core::ipc::DevicePreference;
use curator_ml::{SafetyClassification, SafetyClassifier};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Batch size for safety classification sweeps.
pub const SAFETY_BATCH_FLUSH: usize = 8;

/// Service-side owner of the `SafetyClassifier` and every DB write of the five

/// per-class safety columns. The DB only ever records what the model produced —
/// there is no threshold, no aggregate, and no filtering on the backend.
#[derive(Clone)]
pub struct SafetyService {
    classifier: Arc<std::sync::Mutex<Option<Arc<SafetyClassifier>>>>,
    data_dir: Arc<PathBuf>,
    progress: Arc<Mutex<SafetyRescanState>>,
    model_missing_logged: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Default)]
pub struct SafetyRescanState {
    pub running: bool,
    pub processed: i64,
    pub total: i64,
    pub updated: i64,
    pub status: String,
}

impl SafetyService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            classifier: Arc::new(std::sync::Mutex::new(None)),
            data_dir: Arc::new(data_dir),
            progress: Arc::new(Mutex::new(SafetyRescanState::default())),
            model_missing_logged: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Lazily construct (and cache) the classifier. Sessions auto-load on the
    /// first `classify_*` call via `ManagedSession::with_session`.
    fn ensure_classifier(&self) -> Result<Arc<SafetyClassifier>> {
        let mut slot = self.classifier.lock().unwrap();
        if let Some(c) = slot.as_ref() {
            return Ok(Arc::clone(c));
        }
        let path = SafetyClassifier::resolve_model_path(&self.data_dir);
        let c = Arc::new(SafetyClassifier::new(path, DevicePreference::Auto));
        *slot = Some(Arc::clone(&c));
        Ok(c)
    }

    /// Classify one batch and write the per-class columns. Absent model file or a
    /// failed run simply leaves the columns `NULL` (a later rescan retries).
    pub async fn classify_and_write(&self, db: &SqlitePool, batch: Vec<(i64, String)>) {
        if batch.is_empty() {
            return;
        }
        let model_path = SafetyClassifier::resolve_model_path(&self.data_dir);
        if !model_path.exists() {
            if !self.model_missing_logged.swap(true, Ordering::SeqCst) {
                info!(
                    "Safety classification skipped (model not downloaded): {:?}. \
                     Download nsfw-detection-2-mini in Settings > Models.",
                    model_path
                );
            }
            return;
        }
        let classifier = match self.ensure_classifier() {
            Ok(c) => c,
            Err(e) => {
                warn!("Safety classifier unavailable: {:#}", e);
                return;
            }
        };
        let results = classify_paths(&classifier, &batch).await;
        write_classifications(db, &results).await;
    }

    /// Classify a single arbitrary image file (ephemeral, library-agnostic).
    /// Unlike the import path — where a missing model is a no-op — the toolbox
    /// must fail fast so the UI can surface the missing-model state clearly.
    pub async fn classify_path(&self, path: &str) -> Result<SafetyClassification> {
        let model_path = SafetyClassifier::resolve_model_path(&self.data_dir);
        if !model_path.exists() {
            bail!(
                "Safety model file not found ({:?}). Download nsfw-detection-2-mini in Settings > Models.",
                model_path
            );
        }
        let classifier = self.ensure_classifier()?;
        let path_owned = path.to_string();
        tokio::task::spawn_blocking(move || {
            let (buffer, width, height) =
                decode_rgb(std::path::Path::new(&path_owned)).map_err(|e| {
                    anyhow::anyhow!("Failed to decode safety image {:?}: {:#}", path_owned, e)
                })?;
            let img = curator_core::image::RgbImage::from_raw(width, height, buffer)
                .ok_or_else(|| anyhow::anyhow!("Invalid RGB buffer for {:?}", path_owned))?;
            let mut results = classifier.classify_images_batch(&[img]);
            results
                .pop()
                .unwrap_or_else(|| Err(anyhow::anyhow!("Safety classification produced no result")))
        })
        .await
        .map_err(|e| anyhow::anyhow!("Safety classification task panicked: {:?}", e))?
    }

    /// Kick off the retroactive full-library scan in the background. Returns
    /// `started = false` when a scan is already running. Re-classifies rows whose
    /// five per-class columns are all `NULL` (unclassified), keeping
    /// `processed`/`updated` counters honest.
    pub async fn start_rescan(&self, db: SqlitePool) -> Result<RescanSafetyResult> {
        let model_path = SafetyClassifier::resolve_model_path(&self.data_dir);
        if !model_path.exists() {
            bail!(
                "Safety model file not found ({:?}). Download nsfw-detection-2-mini in Settings > Models.",
                model_path
            );
        }

        let mut prog = self.progress.lock().await;
        if prog.running {
            return Ok(RescanSafetyResult {
                started: false,
                pending: prog.total,
                message: "Safety rescan is already running.".to_string(),
            });
        }

        #[derive(sqlx::FromRow)]
        struct RescanRow {
            id: i64,
            current_filepath: String,
            video_frame_path: Option<String>,
        }

        let rows: Vec<RescanRow> = sqlx::query_as(
            "SELECT id, current_filepath, video_frame_path
             FROM images
             WHERE deleted_at IS NULL AND is_missing = 0
               AND (safe_score IS NULL OR hentai_score IS NULL
                    OR porn_score IS NULL OR sexy_score IS NULL
                    OR drawing_score IS NULL)
             ORDER BY id ASC",
        )
        .fetch_all(&db)
        .await?;

        // Stills classify their file; videos classify their extracted poster frame.
        let rows: Vec<(i64, String)> = rows
            .into_iter()
            .map(|r| {
                let path = r
                    .video_frame_path
                    .unwrap_or_else(|| r.current_filepath.clone());
                (r.id, path)
            })
            .collect();

        let total = rows.len() as i64;
        *prog = SafetyRescanState {
            running: true,
            processed: 0,
            total,
            updated: 0,
            status: "scanning".to_string(),
        };
        drop(prog);

        info!("Safety rescan started: {} images queued", total);
        let this = self.clone();
        tokio::spawn(async move {
            this.run_rescan(db, rows).await;
        });

        Ok(RescanSafetyResult {
            started: true,
            pending: total,
            message: format!("{} images queued for safety classification.", total),
        })
    }

    async fn run_rescan(&self, db: SqlitePool, rows: Vec<(i64, String)>) {
        let classifier = match self.ensure_classifier() {
            Ok(c) => c,
            Err(e) => {
                let mut prog = self.progress.lock().await;
                prog.running = false;
                prog.status = "failed".to_string();
                warn!("Safety rescan failed to initialize classifier: {:#}", e);
                return;
            }
        };

        for chunk in rows.chunks(SAFETY_BATCH_FLUSH) {
            let chunk_len = chunk.len() as i64;
            let results = classify_paths(&classifier, chunk).await;
            let updated = write_classifications(&db, &results).await;

            let mut prog = self.progress.lock().await;
            prog.processed += chunk_len;
            prog.updated += updated;
        }

        let mut prog = self.progress.lock().await;
        prog.running = false;
        prog.status = "complete".to_string();
        info!(
            "Safety rescan complete: {} processed, {} updated.",
            prog.processed, prog.updated
        );
    }

    /// Classify all unclassified images belonging to a specific folder on demand.
    pub async fn classify_folder_safety(
        &self,
        db: &SqlitePool,
        folder_id: i64,
    ) -> Result<(i64, i64)> {
        let unclassified: Vec<(i64, String, Option<String>)> = sqlx::query_as(
            "SELECT id, current_filepath, video_frame_path FROM images 
             WHERE folder_id = ? AND safe_score IS NULL AND deleted_at IS NULL AND is_missing = 0",
        )
        .bind(folder_id)
        .fetch_all(db)
        .await?;

        let total = unclassified.len() as i64;
        if total == 0 {
            return Ok((0, 0));
        }

        let batch: Vec<(i64, String)> = unclassified
            .into_iter()
            .map(|(id, fp, vfp)| {
                let p = curator_core::video::decode_path(&fp, vfp.as_deref())
                    .to_string_lossy()
                    .into_owned();
                (id, p)
            })
            .collect();

        self.classify_and_write(db, batch).await;
        Ok((total, total))
    }

    pub async fn rescan_progress(&self) -> SafetyRescanProgress {
        let prog = self.progress.lock().await;
        SafetyRescanProgress {
            running: prog.running,
            processed: prog.processed,
            total: prog.total,
            updated: prog.updated,
            status: if prog.status.is_empty() {
                "idle".to_string()
            } else {
                prog.status.clone()
            },
        }
    }
}

/// Decode + classify a path batch off the async runtime (ONNX is blocking).
async fn classify_paths(
    classifier: &Arc<SafetyClassifier>,
    rows: &[(i64, String)],
) -> Vec<(i64, Result<SafetyClassification>)> {
    let classifier = Arc::clone(classifier);
    let rows_owned = rows.to_vec();
    let rows_for_error = rows_owned.clone();
    tokio::task::spawn_blocking(move || {
        let mut all_results = Vec::with_capacity(rows_owned.len());
        const CHUNK_SIZE: usize = 4;

        for chunk in rows_owned.chunks(CHUNK_SIZE) {
            let mut imgs: Vec<(i64, curator_core::image::RgbImage)> =
                Vec::with_capacity(chunk.len());
            for (id, path) in chunk {
                match decode_rgb(std::path::Path::new(path)) {
                    Ok((buffer, width, height)) => {
                        match curator_core::image::RgbImage::from_raw(width, height, buffer) {
                            Some(img) => imgs.push((*id, img)),
                            None => {
                                warn!("Safety: invalid RGB buffer for {:?}", path);
                                all_results.push((*id, Err(anyhow::anyhow!("Invalid RGB buffer"))));
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Safety: skipping unreadable {:?}: {:#}", path, e);
                        all_results.push((*id, Err(e)));
                    }
                }
            }

            if !imgs.is_empty() {
                let ids: Vec<i64> = imgs.iter().map(|(id, _)| *id).collect();
                let images: Vec<curator_core::image::RgbImage> =
                    imgs.into_iter().map(|(_, img)| img).collect();
                let results = classifier.classify_images_batch(&images);
                for (id, res) in ids.into_iter().zip(results) {
                    all_results.push((id, res));
                }
            }
        }
        all_results
    })
    .await
    .unwrap_or_else(|e| {
        warn!("Safety classification task panicked: {:?}", e);
        rows_for_error
            .iter()
            .map(|(id, _)| {
                (
                    *id,
                    Err(anyhow::anyhow!("Safety classification task failed")),
                )
            })
            .collect()
    })
}

/// Persist per-class columns for a batch of classification results. Rows whose
/// classification errored are skipped (columns stay `NULL`). Retries a bounded
/// number of times on SQLite `database is locked` so background flushes never
/// corrupt an in-flight import transaction.
async fn write_classifications(
    db: &SqlitePool,
    results: &[(i64, Result<SafetyClassification>)],
) -> i64 {
    let mut updated: i64 = 0;
    for (id, res) in results {
        let c = match res {
            Ok(c) => *c,
            Err(_) => continue,
        };
        let mut attempts = 0;
        loop {
            let outcome = sqlx::query(
                "UPDATE images
                 SET safe_score = ?, hentai_score = ?, porn_score = ?,
                     sexy_score = ?, drawing_score = ?
                 WHERE id = ?",
            )
            .bind(c.safe_score)
            .bind(c.hentai_score)
            .bind(c.porn_score)
            .bind(c.sexy_score)
            .bind(c.drawing_score)
            .bind(id)
            .execute(db)
            .await;

            match outcome {
                Ok(res) => {
                    updated += res.rows_affected() as i64;
                    break;
                }
                Err(e) if is_db_locked(&e) && attempts < 20 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => {
                    warn!("Safety: DB write failed for image {}: {}", id, e);
                    break;
                }
            }
        }
    }
    updated
}

fn is_db_locked(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db) = e {
        return db.message().to_lowercase().contains("database is locked");
    }
    false
}
