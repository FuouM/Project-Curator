use anyhow::{Context, Error};
use clap::Parser;
use curator_core::db::init_db;
use curator_core::vector::{ModelManager, VectorIndex};
use curator_core::ipc::{Request, Response, SearchMatch, ImageDetails, TagSummary, DevicePreference};
use curator_core::tagger::TaggerEngine;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ServerOptions;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use sha2::Digest;

mod auth;
mod worker;

use auth::load_or_create_service_key;
use worker::BackgroundWorker;

/// Persistent application settings stored in `<data_dir>/settings.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    clip_device: DevicePreference,
    tagger_device: DevicePreference,
    /// Seconds of inactivity before models are automatically unloaded. 0 = never.
    #[serde(default = "default_idle_timeout")]
    idle_timeout_secs: u64,
}

fn default_idle_timeout() -> u64 {
    300 // 5 minutes
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            clip_device: DevicePreference::Auto,
            tagger_device: DevicePreference::Auto,
            idle_timeout_secs: default_idle_timeout(),
        }
    }
}

fn load_settings(data_dir: &Path) -> AppSettings {
    let path = data_dir.join("settings.json");
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            warn!("Failed to parse settings.json, using defaults: {:?}", e);
            AppSettings::default()
        }),
        Err(_) => AppSettings::default(),
    }
}

fn save_settings(data_dir: &Path, settings: &AppSettings) -> Result<(), Error> {
    let path = data_dir.join("settings.json");
    let json = serde_json::to_string_pretty(settings)
        .context("Failed to serialize settings")?;
    fs::write(&path, json).context("Failed to write settings.json")?;
    Ok(())
}

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short, long, default_value = ".curator")]
    data_dir: String,

    /// Directory containing camie-tagger-v2.onnx and camie-tagger-v2-metadata.json.
    /// If not set, defaults to <data_dir>/models.
    #[arg(long)]
    tagger_model_dir: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args = Args::parse();
    let data_dir = PathBuf::from(&args.data_dir);
    fs::create_dir_all(&data_dir)?;

    // Open log file in append mode
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(data_dir.join("curator.log"))
        .context("Failed to open log file")?;

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false);

    let console_layer = tracing_subscriber::fmt::layer();

    // Initialize structured logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(console_layer)
        .with(file_layer)
        .init();

    info!("Starting Project Curator Service...");

    // 1. Load or generate service key
    let service_key = load_or_create_service_key(&data_dir)?;
    info!("Service Key authenticated successfully.");

    // 2. Initialize SQLite Database
    let db_path = data_dir.join("curator.db");
    let db = init_db(&db_path).await?;

    // Seed AI model sources if missing
    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('ai:clip-vit-b-32', 'AI_MODEL', '{}')"
    )
    .execute(&db)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('ai:camie-tagger-v2', 'AI_MODEL', '{}')"
    )
    .execute(&db)
    .await?;

    // Seed the user source if missing
    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('user', 'USER', '{}')"
    )
    .execute(&db)
    .await?;

    // 3. Load settings
    let settings = load_settings(&data_dir);
    info!(
        "Settings loaded: clip_device={:?}, tagger_device={:?}, idle_timeout={}s",
        settings.clip_device, settings.tagger_device, settings.idle_timeout_secs
    );

    // 4. Initialize CLIP Models
    let model_dir = data_dir.join("models");
    let mut model_manager = ModelManager::new(&model_dir, settings.clip_device.clone());
    model_manager.init()?;
    let model_manager = Arc::new(model_manager);

    // 5. Initialize Vector Index
    let index_path = data_dir.join("vector_index.usearch");
    let vector_index = Arc::new(VectorIndex::new(&index_path, 512)?);

    // 6. Initialize Camie Tagger (lazy — does not load the model yet)
    let tagger_dir = args.tagger_model_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("models"));
    let tagger = Arc::new(TaggerEngine::new(&tagger_dir, settings.tagger_device.clone()));
    info!(
        "Camie Tagger configured at {:?} with device {:?} (model loads on first use)",
        tagger_dir, settings.tagger_device
    );

    // 7. Start Background Job Worker
    let worker = BackgroundWorker::new(db.clone(), model_manager.clone(), vector_index.clone());
    worker.start();

    // 8. Create settings arc (shared by idle reaper + IPC handler)
    let settings_arc = Arc::new(tokio::sync::Mutex::new(settings));

    // 9. Start idle timeout reaper
    {
        let mm = model_manager.clone();
        let tg = tagger.clone();
        let st = settings_arc.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let timeout = {
                    let s = st.lock().await;
                    s.idle_timeout_secs
                };
                if timeout == 0 {
                    continue;
                }
                if mm.is_loaded() && mm.idle_secs() >= timeout {
                    mm.unload();
                }
                if tg.is_loaded() && tg.idle_secs() >= timeout {
                    tg.unload();
                }
            }
        });
    }

    // 10. Start Named Pipe Server Loop
    let pipe_name = r"\\.\pipe\curator_ipc";
    info!("Listening on Named Pipe: {}", pipe_name);

    let db_arc = db.clone();
    let mm_arc = model_manager.clone();
    let vi_arc = vector_index.clone();
    let tagger_arc = tagger.clone();
    let key_arc = Arc::new(service_key);
    let data_dir_arc = Arc::new(data_dir);

    // Named Pipe listener loop
    let mut is_first = true;
    loop {
        let server = ServerOptions::new()
            .first_pipe_instance(is_first)
            .create(pipe_name)
            .context("Failed to create named pipe instance")?;
        is_first = false;

        server.connect().await?;

        let db = db_arc.clone();
        let mm = mm_arc.clone();
        let vi = vi_arc.clone();
        let tagger = tagger_arc.clone();
        let key = key_arc.clone();
        let dd = data_dir_arc.clone();
        let st = settings_arc.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_client(server, db, mm, vi, tagger, key, dd, st).await {
                error!("Error handling IPC client: {:?}", e);
            }
        });
    }
}

async fn handle_client(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
    tagger: Arc<TaggerEngine>,
    service_key: Arc<String>,
    data_dir: Arc<PathBuf>,
    settings: Arc<tokio::sync::Mutex<AppSettings>>,
) -> Result<(), Error> {
    info!("New client connected to named pipe.");
    let mut buffer = vec![0; 16384];

    // Read Handshake (the token key must be sent first)
    let n = stream.read(&mut buffer).await?;
    if n == 0 {
        return Ok(());
    }

    let token_input = String::from_utf8_lossy(&buffer[..n]).trim().to_string();
    if token_input != *service_key {
        warn!("Client authentication failed. Invalid token.");
        stream.write_all(b"AUTH_FAILED").await?;
        return Ok(());
    }

    // Auth succeeded
    stream.write_all(b"AUTH_OK").await?;

    // Process requests
    loop {
        let n = stream.read(&mut buffer).await?;
        if n == 0 {
            break; // connection closed
        }

        let request_str = String::from_utf8_lossy(&buffer[..n]);
        let request: Request = match serde_json::from_str(&request_str) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = Response::Error {
                    message: format!("Failed to parse request JSON: {:?}", e),
                };
                let resp_str = serde_json::to_string(&err_resp)?;
                stream.write_all(resp_str.as_bytes()).await?;
                continue;
            }
        };

        info!("Received Request: {:?}", request);
        let response =
            handle_request(request, &db, &model_manager, &vector_index, &tagger, &data_dir, &settings).await;

        let response_str = serde_json::to_string(&response)?;
        stream.write_all(response_str.as_bytes()).await?;
    }

    info!("Client disconnected.");
    Ok(())
}

async fn handle_request(
    request: Request,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
    tagger: &Arc<TaggerEngine>,
    data_dir: &PathBuf,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> Response {
    match request {
        Request::Ping => Response::Pong,

        Request::RunBenchmark => {
            let vision_path = model_manager.model_dir().join("vision_model.onnx");
            let tagger_path = tagger.model_path();
            info!("RunBenchmark request: vision_path={:?}, tagger_path={:?}, tagger_path_exists={}", vision_path, tagger_path, tagger_path.exists());

            let clip_res = curator_core::run_onnx_benchmark(&vision_path, 224);
            let tagger_res = if tagger_path.exists() {
                match curator_core::run_onnx_benchmark(&tagger_path, 512) {
                    Ok((cpu, gpu, err, _)) => (Some(cpu), gpu, err),
                    Err(e) => (None, None, Some(format!("Tagger benchmark failed: {:?}", e))),
                }
            } else {
                (None, None, Some("Tagger model file not found.".to_string()))
            };

            match clip_res {
                Ok((clip_cpu, clip_gpu, clip_err, has_gpu)) => Response::BenchmarkResult {
                    clip_cpu_time_ms: clip_cpu,
                    clip_gpu_time_ms: clip_gpu,
                    clip_gpu_error: clip_err,
                    tagger_cpu_time_ms: tagger_res.0,
                    tagger_gpu_time_ms: tagger_res.1,
                    tagger_gpu_error: tagger_res.2,
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CLIP model benchmark failed: {:?}", e),
                },
            }
        }

        Request::GetStatus => match query_status(db).await {
            Ok((images, vectors, pending)) => Response::StatusResult {
                image_count: images,
                vector_count: vectors,
                pending_jobs: pending,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::ImportImage { path } => match import_image_logic(&path, db).await {
            Ok((id, sha256)) => Response::ImportResult {
                image_id: id,
                sha256,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::AddTag {
            image_id,
            tag,
            category,
        } => match add_tag_logic(image_id, &tag, &category, db).await {
            Ok(_) => Response::Success,
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::RemoveTag { image_id, tag } => {
            // Find the tag ID
            let tag_res: Option<(i64,)> = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                .bind(&tag)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

            if let Some((tag_id,)) = tag_res {
                // Find the user source ID
                let user_source: Option<(i64,)> = sqlx::query_as("SELECT id FROM sources WHERE name = 'user' LIMIT 1")
                    .fetch_optional(db)
                    .await
                    .unwrap_or(None);

                if let Some((source_id,)) = user_source {
                    // Soft-delete: only delete if the association was created by user
                    match sqlx::query(
                        "UPDATE image_tags
                         SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
                         WHERE image_id = ? AND tag_id = ? AND source_id = ?",
                    )
                    .bind(image_id)
                    .bind(tag_id)
                    .bind(source_id)
                    .execute(db)
                    .await
                    {
                        Ok(_) => Response::Success,
                        Err(e) => Response::Error {
                            message: e.to_string(),
                        },
                    }
                } else {
                    Response::Error { message: "User source not found".to_string() }
                }
            } else {
                Response::Error { message: "Tag not found".to_string() }
            }
        }

        Request::Search {
            query_text,
            tag_filter,
            limit,
        } => {
            match search_logic(query_text, tag_filter, limit, db, model_manager, vector_index).await
            {
                Ok(matches) => Response::SearchResult { matches },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ListImages { limit, offset } => {
            match list_images_logic(limit, offset, db).await {
                Ok(images) => Response::ListResult { images },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetImage { image_id } => match get_image_logic(image_id, db).await {
            Ok(image) => Response::ImageResult { image },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::ValidatePlugin { manifest_path } => {
            match validate_plugin_logic(&manifest_path).await {
                Ok((name, version)) => Response::ValidationResult {
                    name,
                    version,
                    valid: true,
                    error: None,
                },
                Err(e) => Response::ValidationResult {
                    name: String::new(),
                    version: String::new(),
                    valid: false,
                    error: Some(e.to_string()),
                },
            }
        }

        // ----------------------------------------------------------------
        // Camie Tagger handlers
        // ----------------------------------------------------------------
        Request::GetTaggerStatus => {
            let status = tagger.status();
            Response::TaggerStatusResult {
                loaded: status.loaded,
                model_path: status.model_path,
                total_tags: status.total_tags,
            }
        }

        Request::TagImage {
            image_id,
            threshold,
            force,
        } => {
            let threshold = threshold.unwrap_or(0.5);
            let force = force.unwrap_or(false);
            match tag_image_logic(image_id, threshold, force, db, tagger).await {
                Ok(outcome) => Response::TagImageResult {
                    image_id,
                    tags_applied: outcome.tags_applied,
                    skipped: outcome.skipped,
                    tags: outcome.tags,
                },
                Err(e) => {
                    error!("TagImage {} failed: {:?}", image_id, e);
                    Response::Error {
                        message: e.to_string(),
                    }
                }
            }
        }

        Request::TagImageBatch {
            image_ids,
            threshold,
            force,
        } => {
            let threshold = threshold.unwrap_or(0.5);
            let force = force.unwrap_or(false);
            let mut processed = 0usize;
            let mut failed = 0usize;
            let mut skipped = 0usize;

            for image_id in image_ids {
                match tag_image_logic(image_id, threshold, force, db, tagger).await {
                    Ok(outcome) => {
                        if outcome.skipped {
                            skipped += 1;
                        } else {
                            processed += 1;
                        }
                    }
                    Err(e) => {
                        warn!("Batch auto-tag failed for image {}: {:?}", image_id, e);
                        failed += 1;
                    }
                }
            }

            Response::BatchTagResult {
                processed,
                failed,
                skipped,
            }
        }

        Request::GetSettings => {
            let s = settings.lock().await;
            Response::SettingsResult {
                clip_device: s.clip_device.clone(),
                tagger_device: s.tagger_device.clone(),
                idle_timeout_secs: s.idle_timeout_secs,
            }
        }

        Request::UpdateSettings {
            clip_device,
            tagger_device,
            idle_timeout_secs,
        } => {
            let mut s = settings.lock().await;
            if let Some(ref cd) = clip_device {
                s.clip_device = cd.clone();
            }
            if let Some(ref td) = tagger_device {
                s.tagger_device = td.clone();
            }
            if let Some(to) = idle_timeout_secs {
                s.idle_timeout_secs = to;
            }
            if let Err(e) = save_settings(data_dir, &s) {
                warn!("Failed to save settings: {:?}", e);
            }
            let clip = s.clip_device.clone();
            let tagger_dev = s.tagger_device.clone();
            let idle = s.idle_timeout_secs;
            drop(s);

            // Apply CLIP device change immediately (unloads sessions for reload)
            if clip_device.is_some() {
                model_manager.set_device(clip.clone());
            }

            // Apply Tagger device change immediately (unloads if loaded)
            if tagger_device.is_some() {
                tagger.set_device(tagger_dev.clone());
            }

            info!("Settings updated: clip_device={:?}, tagger_device={:?}, idle_timeout={}s", clip, tagger_dev, idle);
            Response::SettingsResult {
                clip_device: clip,
                tagger_device: tagger_dev,
                idle_timeout_secs: idle,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tagger logic
// ---------------------------------------------------------------------------

struct TagImageOutcome {
    tags_applied: usize,
    skipped: bool,
    tags: Vec<TagSummary>,
}

async fn tag_image_logic(
    image_id: i64,
    threshold: f32,
    force: bool,
    db: &SqlitePool,
    tagger: &Arc<TaggerEngine>,
) -> Result<TagImageOutcome, Error> {
    // 1. Resolve image path
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT current_filepath FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?;

    let filepath = match row {
        Some(r) => r.0,
        None => anyhow::bail!("Image {} not found", image_id),
    };

    // 2. Dedup/Overwrite check
    let camie_source: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:camie-tagger-v2' LIMIT 1")
            .fetch_optional(db)
            .await?;

    if let Some((camie_source_id,)) = camie_source {
        if force {
            // Wipe existing Camie tags (hard delete to allow clean overwrite)
            sqlx::query("DELETE FROM image_tags WHERE image_id = ? AND source_id = ?")
                .bind(image_id)
                .bind(camie_source_id)
                .execute(db)
                .await?;
            info!("Forced overwrite: wiped existing Camie tags for image {}", image_id);
        } else {
            let existing: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM image_tags WHERE image_id = ? AND source_id = ? AND is_deleted = 0",
            )
            .bind(image_id)
            .bind(camie_source_id)
            .fetch_one(db)
            .await?;

            if existing.0 > 0 {
                info!(
                    "Image {} already has {} Camie tags — skipping",
                    image_id, existing.0
                );
                return Ok(TagImageOutcome {
                    tags_applied: 0,
                    skipped: true,
                    tags: vec![],
                });
            }
        }
    }

    // 3. Run inference in a blocking thread (model uses std::sync::Mutex)
    let tagger_clone = Arc::clone(tagger);
    let filepath_clone = filepath.clone();
    let predictions = tokio::task::spawn_blocking(move || {
        tagger_clone.tag_image(&filepath_clone, threshold)
    })
    .await
    .context("spawn_blocking panicked during Camie inference")??;

    // 4. Get camie source_id (seed it if missing)
    let source_row: (i64,) =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:camie-tagger-v2' LIMIT 1")
            .fetch_one(db)
            .await?;
    let source_id = source_row.0;

    // 5. Generate a shared transaction_id for this tagging run (enables future undo)
    let transaction_id = uuid::Uuid::new_v4().to_string();

    // 6. Persist each predicted tag
    let mut tag_summaries: Vec<TagSummary> = Vec::with_capacity(predictions.len());

    for pred in &predictions {
        // Ensure tag exists in tags table
        sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
            .bind(&pred.tag)
            .bind(&pred.category)
            .execute(db)
            .await?;

        let tag_row: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
            .bind(&pred.tag)
            .fetch_one(db)
            .await?;
        let tag_id = tag_row.0;

        // Insert with confidence and transaction tracking
        sqlx::query(
            "INSERT OR IGNORE INTO image_tags
             (image_id, tag_id, source_id, confidence, is_deleted, transaction_id)
             VALUES (?, ?, ?, ?, 0, ?)",
        )
        .bind(image_id)
        .bind(tag_id)
        .bind(source_id)
        .bind(pred.confidence)
        .bind(&transaction_id)
        .execute(db)
        .await?;

        tag_summaries.push(TagSummary {
            tag: pred.tag.clone(),
            category: pred.category.clone(),
            confidence: pred.confidence,
        });
    }

    info!(
        "Auto-tagged image {} with {} tags (tx: {})",
        image_id,
        tag_summaries.len(),
        &transaction_id[..8]
    );

    Ok(TagImageOutcome {
        tags_applied: tag_summaries.len(),
        skipped: false,
        tags: tag_summaries,
    })
}

// ---------------------------------------------------------------------------
// Existing logic (unchanged)
// ---------------------------------------------------------------------------

async fn query_status(db: &SqlitePool) -> Result<(i64, i64, i64), Error> {
    let images: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM images WHERE deleted_at IS NULL")
            .fetch_one(db)
            .await?;
    let vectors: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'ready'",
    )
    .fetch_one(db)
    .await?;
    let pending: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'pending'",
    )
    .fetch_one(db)
    .await?;
    Ok((images.0, vectors.0, pending.0))
}

async fn import_image_logic(path_str: &str, db: &SqlitePool) -> Result<(i64, String), Error> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!(
            "File or directory does not exist: {}",
            path_str
        ));
    }

    if path.is_dir() {
        let mut paths_to_process = vec![path.to_path_buf()];
        let mut image_paths = Vec::new();

        while let Some(current_path) = paths_to_process.pop() {
            if current_path.is_dir() {
                if let Ok(entries) = fs::read_dir(&current_path) {
                    for entry in entries.flatten() {
                        paths_to_process.push(entry.path());
                    }
                }
            } else if current_path.is_file() {
                if let Some(ext) = current_path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if matches!(
                        ext_lower.as_str(),
                        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff"
                    ) {
                        image_paths.push(current_path);
                    }
                }
            }
        }

        if image_paths.is_empty() {
            return Err(anyhow::anyhow!(
                "No supported image files found in directory: {}",
                path_str
            ));
        }

        let mut first_id = 0;
        let mut first_sha = String::new();
        let mut imported_any = false;

        for img_path in image_paths {
            if let Some(p_str) = img_path.to_str() {
                match import_single_image(p_str, db).await {
                    Ok((id, sha)) => {
                        if !imported_any {
                            first_id = id;
                            first_sha = sha;
                            imported_any = true;
                        }
                    }
                    Err(e) => {
                        warn!("Failed to import image {:?}: {:?}", img_path, e);
                    }
                }
            }
        }

        if imported_any {
            Ok((first_id, first_sha))
        } else {
            Err(anyhow::anyhow!(
                "Failed to import any images from directory: {}",
                path_str
            ))
        }
    } else {
        import_single_image(path_str, db).await
    }
}

async fn import_single_image(path_str: &str, db: &SqlitePool) -> Result<(i64, String), Error> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("File does not exist: {}", path_str));
    }

    let data = fs::read(path)?;
    let sha256 = format!("{:x}", sha2::Sha256::digest(&data));

    let metadata = fs::metadata(path)?;
    let mtime = metadata
        .modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?
        .as_secs() as i64;

    let clip_row: (i64,) =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:clip-vit-b-32' LIMIT 1")
            .fetch_one(db)
            .await?;
    let clip_source_id = clip_row.0;

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
            .bind(&sha256)
            .fetch_optional(db)
            .await?;

    if let Some((id, old_path)) = existing {
        if old_path != path_str {
            sqlx::query(
                "UPDATE images SET current_filepath = ?, mtime = ?, deleted_at = NULL WHERE id = ?",
            )
            .bind(path_str)
            .bind(mtime)
            .bind(id)
            .execute(db)
            .await?;
            info!(
                "Path repair: updated filepath of image ID {} from {} to {}",
                id, old_path, path_str
            );
        }
        return Ok((id, sha256));
    }

    let id = sqlx::query("INSERT INTO images (sha256, current_filepath, mtime) VALUES (?, ?, ?)")
        .bind(&sha256)
        .bind(path_str)
        .bind(mtime)
        .execute(db)
        .await?
        .last_insert_rowid();

    sqlx::query(
        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
    )
    .bind(id)
    .bind(clip_source_id)
    .execute(db)
    .await?;

    Ok((id, sha256))
}

async fn add_tag_logic(
    image_id: i64,
    tag: &str,
    category: &str,
    db: &SqlitePool,
) -> Result<(), Error> {
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

    let source_row: (i64,) =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'user' LIMIT 1")
            .fetch_one(db)
            .await?;
    let source_id = source_row.0;

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

async fn search_logic(
    query_text: Option<String>,
    tag_filter: Option<String>,
    limit: usize,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<Vec<SearchMatch>, Error> {
    let mut candidate_ids: Option<std::collections::HashSet<i64>> = None;
    let mut vector_scores: std::collections::HashMap<i64, f32> =
        std::collections::HashMap::new();

    if let Some(text) = query_text {
        if !text.trim().is_empty() {
            let query_vector = model_manager.generate_text_embedding(&text)?;
            let results = vector_index.search(&query_vector, limit.max(100))?;

            let mut ids = std::collections::HashSet::new();
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                vector_scores.insert(id_i64, 1.0 - dist);
            }
            candidate_ids = Some(ids);
        }
    }

    if let Some(tag_name) = tag_filter {
        if !tag_name.trim().is_empty() {
            let tagged_images: Vec<(i64,)> = sqlx::query_as(
                "SELECT DISTINCT it.image_id FROM image_tags it
                 JOIN tags t ON it.tag_id = t.id
                 WHERE t.name = ? AND it.is_deleted = 0",
            )
            .bind(tag_name)
            .fetch_all(db)
            .await?;

            let mut tag_set = std::collections::HashSet::new();
            for row in tagged_images {
                tag_set.insert(row.0);
            }

            if let Some(ref mut existing) = candidate_ids {
                *existing = existing.intersection(&tag_set).cloned().collect();
            } else {
                candidate_ids = Some(tag_set);
            }
        }
    }

    let target_ids = match candidate_ids {
        Some(set) => set.into_iter().collect::<Vec<i64>>(),
        None => {
            let latest: Vec<(i64,)> = sqlx::query_as(
                "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
            )
            .bind(limit as i64)
            .fetch_all(db)
            .await?;
            latest.into_iter().map(|r| r.0).collect()
        }
    };

    let mut matches = Vec::new();
    for id in target_ids {
        if let Ok(details) = get_image_logic(id, db).await {
            let score = vector_scores.get(&details.id).cloned().unwrap_or(1.0);
            matches.push(SearchMatch {
                id: details.id,
                filepath: details.current_filepath,
                score,
                tags: details.tags,
            });
        }
    }

    matches.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    matches.truncate(limit);
    Ok(matches)
}

async fn list_images_logic(
    limit: usize,
    offset: usize,
    db: &SqlitePool,
) -> Result<Vec<ImageDetails>, Error> {
    let image_ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(db)
    .await?;

    let mut images = Vec::new();
    for row in image_ids {
        if let Ok(img) = get_image_logic(row.0, db).await {
            images.push(img);
        }
    }
    Ok(images)
}

async fn get_image_logic(image_id: i64, db: &SqlitePool) -> Result<ImageDetails, Error> {
    let img: curator_core::db::models::Image = sqlx::query_as(
        "SELECT * FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_one(db)
    .await?;

    let tags: Vec<TagSummary> = sqlx::query_as(
        "SELECT t.name as tag, t.category as category, it.confidence as confidence
         FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         WHERE it.image_id = ? AND it.is_deleted = 0"
    )
    .bind(image_id)
    .fetch_all(db)
    .await?;

    // Sort tags: user tags at the absolute top (category == "user"),
    // followed by character, copyright, meta, then the rest.
    // Within each category, sort by confidence descending.
    let mut sorted_tags = tags;
    sorted_tags.sort_by(|a, b| {
        let priority = |cat: &str| -> i32 {
            match cat {
                "user" => 0,
                "character" => 1,
                "copyright" => 2,
                "meta" => 3,
                _ => 4,
            }
        };

        let p_a = priority(&a.category);
        let p_b = priority(&b.category);

        if p_a != p_b {
            p_a.cmp(&p_b)
        } else {
            b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    // Use fetch_optional to avoid panic if image_vectors row is missing
    let vector_state: String = sqlx::query_as(
        "SELECT vector_state FROM image_vectors WHERE image_id = ? LIMIT 1",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await?
    .map(|(s,): (String,)| s)
    .unwrap_or_else(|| "unknown".to_string());

    Ok(ImageDetails {
        id: img.id,
        sha256: img.sha256,
        current_filepath: img.current_filepath,
        mtime: img.mtime,
        created_at: img.created_at.to_string(),
        tags: sorted_tags,
        vector_state,
    })
}

async fn validate_plugin_logic(manifest_path_str: &str) -> Result<(String, String), Error> {
    let path = Path::new(manifest_path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("manifest.json path does not exist"));
    }

    let content = fs::read_to_string(path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;

    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .context("Missing 'name' field")?
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .context("Missing 'version' field")?
        .to_string();

    if let Some(permissions) = val.get("permissions") {
        if !permissions.is_object() {
            return Err(anyhow::anyhow!("'permissions' must be a JSON object"));
        }
    }

    Ok((name, version))
}
