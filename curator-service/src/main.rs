use anyhow::{Context, Error};
use clap::Parser;
use curator_core::concept::{
    bytes_to_vector, sanitize_concept_name, vector_to_bytes, CustomConcept,
};
use curator_core::db::init_db;
use curator_core::ipc::{
    DevicePreference, EmbeddingModel, FolderDetails, ImageDetails, Request, Response, SearchMatch,
    TagStat, TagSummary,
};
use curator_core::tagger::TaggerEngine;
use curator_core::vector::{ModelManager, VectorIndex};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use sqlx::SqlitePool;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ServerOptions;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod worker;

use auth::load_or_create_service_key;
use worker::BackgroundWorker;

struct ClientContext {
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
    tagger: Arc<TaggerEngine>,
    service_key: Arc<String>,
    data_dir: Arc<PathBuf>,
    settings: Arc<tokio::sync::Mutex<AppSettings>>,
}

type ImageRow = (
    i64,
    String,
    String,
    i64,
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<f32>,
    Option<String>,
);

/// Persistent application settings stored in `<data_dir>/settings.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    clip_device: DevicePreference,
    tagger_device: DevicePreference,
    /// Seconds of inactivity before models are automatically unloaded. 0 = never.
    #[serde(default = "default_idle_timeout")]
    idle_timeout_secs: u64,
    #[serde(default)]
    embedding_model: EmbeddingModel,
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
            embedding_model: EmbeddingModel::ClipVitB32,
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
    let json = serde_json::to_string_pretty(settings).context("Failed to serialize settings")?;
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

    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('ai:mobileclip-s2', 'AI_MODEL', '{}')"
    )
    .execute(&db)
    .await?;

    // Seed the user source if missing
    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('user', 'USER', '{}')",
    )
    .execute(&db)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('ai:custom-concepts', 'AI_MODEL', '{}')",
    )
    .execute(&db)
    .await?;

    let _ = sync_all_custom_concept_tags(&db).await;

    // 3. Load settings
    let settings = load_settings(&data_dir);
    info!(
        "Settings loaded: clip_device={:?}, tagger_device={:?}, idle_timeout={}s",
        settings.clip_device, settings.tagger_device, settings.idle_timeout_secs
    );

    // 4. Initialize CLIP Models
    let model_dir = data_dir.join("models");
    let model_manager = ModelManager::new(&model_dir, settings.clip_device.clone());
    model_manager.set_active_model(settings.embedding_model);
    model_manager.init()?;
    let model_manager = Arc::new(model_manager);

    // 5. Initialize Vector Index
    let index_path = data_dir.join("vector_index.usearch");
    let vector_index = Arc::new(VectorIndex::new(&index_path, 512)?);

    // 6. Initialize Camie Tagger (lazy — does not load the model yet)
    let tagger_dir = args
        .tagger_model_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("models"));
    let tagger = Arc::new(TaggerEngine::new(
        &tagger_dir,
        settings.tagger_device.clone(),
    ));
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
            let ctx = ClientContext {
                db,
                model_manager: mm,
                vector_index: vi,
                tagger,
                service_key: key,
                data_dir: dd,
                settings: st,
            };
            if let Err(e) = handle_client(server, ctx).await {
                error!("Error handling IPC client: {:?}", e);
            }
        });
    }
}

async fn handle_client(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    ctx: ClientContext,
) -> Result<(), Error> {
    let ClientContext {
        db,
        model_manager,
        vector_index,
        tagger,
        service_key,
        data_dir,
        settings,
    } = ctx;
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
        let response = handle_request(
            request,
            &db,
            &model_manager,
            &vector_index,
            &tagger,
            &data_dir,
            &settings,
        )
        .await;

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
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> Response {
    match request {
        Request::Ping => Response::Pong,

        Request::RunBenchmark { embedding_model } => {
            let vision_path = match embedding_model {
                EmbeddingModel::ClipVitB32 => model_manager.model_dir().join("vision_model.onnx"),
                EmbeddingModel::MobileClipS2 => model_manager
                    .model_dir()
                    .join("mobileclip_s2/onnx/vision_model.onnx"),
            };
            let target_size = match embedding_model {
                EmbeddingModel::ClipVitB32 => 224,
                EmbeddingModel::MobileClipS2 => 256,
            };
            let tagger_path = tagger.model_path();
            info!(
                "RunBenchmark request: embedding_model={:?}, vision_path={:?}, tagger_path={:?}, tagger_path_exists={}",
                embedding_model,
                vision_path,
                tagger_path,
                tagger_path.exists()
            );

            let clip_res = curator_core::run_onnx_benchmark(&vision_path, target_size);
            let tagger_res = if tagger_path.exists() {
                match curator_core::run_onnx_benchmark(tagger_path, 512) {
                    Ok((cpu, gpu, err, _)) => (Some(cpu), gpu, err),
                    Err(e) => (
                        None,
                        None,
                        Some(format!("Tagger benchmark failed: {:?}", e)),
                    ),
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

        Request::BenchmarkPreprocess { image_path } => {
            let path = std::path::Path::new(&image_path);
            match curator_core::benchmark_preprocess(path, 512, 3) {
                Ok((_decode, _resize, _norm, report)) => {
                    info!("Preprocess benchmark:\n{}", report);
                    Response::PreprocessBenchmarkResult { report }
                }
                Err(e) => Response::Error {
                    message: format!("Preprocess benchmark failed: {:?}", e),
                },
            }
        }

        Request::GetStatus => {
            let active = {
                let s = settings.lock().await;
                s.embedding_model
            };
            match query_status(db, active).await {
                Ok((images, vectors, pending, preprocessing)) => Response::StatusResult {
                    image_count: images,
                    vector_count: vectors,
                    pending_jobs: pending,
                    preprocessing_jobs: preprocessing,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ImportImage { path } => {
            let active = {
                let s = settings.lock().await;
                s.embedding_model
            };
            match import_image_logic(&path, db, active).await {
                Ok((id, sha256, count, folder_id)) => Response::ImportResult {
                    image_id: id,
                    sha256,
                    imported_count: count,
                    folder_id,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

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
            let tag_res: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                    .bind(&tag)
                    .fetch_optional(db)
                    .await
                    .unwrap_or(None);

            if let Some((tag_id,)) = tag_res {
                // Check if any active tag association for this image is an AI tag source (starts with 'ai:')
                let source_row: Option<(String,)> = sqlx::query_as(
                    "SELECT s.name FROM image_tags it
                     JOIN sources s ON it.source_id = s.id
                     WHERE it.image_id = ? AND it.tag_id = ? AND it.is_deleted = 0
                     LIMIT 1",
                )
                .bind(image_id)
                .bind(tag_id)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

                let source_name = source_row.map(|(sname,)| sname).unwrap_or_default();
                if source_name == "ai:custom-concepts" {
                    let _ = sqlx::query(
                        "DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?",
                    )
                    .bind(image_id)
                    .bind(tag_id)
                    .execute(db)
                    .await;
                    Response::Success
                } else {
                    let is_ai_source = source_name.starts_with("ai:");
                    let is_blacklisted_val = if is_ai_source { 1i64 } else { 0i64 };

                    match sqlx::query(
                        "UPDATE image_tags
                         SET is_deleted = 1, is_blacklisted = ?, deleted_at = CURRENT_TIMESTAMP
                         WHERE image_id = ? AND tag_id = ?",
                    )
                    .bind(is_blacklisted_val)
                    .bind(image_id)
                    .bind(tag_id)
                    .execute(db)
                    .await
                    {
                        Ok(_) => Response::Success,
                        Err(e) => Response::Error {
                            message: e.to_string(),
                        },
                    }
                }
            } else {
                Response::Success
            }
        }

        Request::UnblacklistTag { image_id, tag } => {
            let tag_res: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1")
                    .bind(&tag)
                    .fetch_optional(db)
                    .await
                    .unwrap_or(None);

            if let Some((tag_id,)) = tag_res {
                match sqlx::query(
                    "UPDATE image_tags
                     SET is_deleted = 0, is_blacklisted = 0, deleted_at = NULL
                     WHERE image_id = ? AND tag_id = ?",
                )
                .bind(image_id)
                .bind(tag_id)
                .execute(db)
                .await
                {
                    Ok(_) => Response::Success,
                    Err(e) => Response::Error {
                        message: e.to_string(),
                    },
                }
            } else {
                Response::Success
            }
        }

        Request::Search {
            query_text,
            query_image_path,
            tag_filter,
            concept_id,
            limit,
        } => {
            match search_logic(
                query_text,
                query_image_path,
                tag_filter,
                concept_id,
                limit,
                db,
                model_manager,
                vector_index,
            )
            .await
            {
                Ok(matches) => Response::SearchResult { matches },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ListImages {
            limit,
            offset,
            only_favorites,
        } => match list_images_logic(limit, offset, only_favorites, db).await {
            Ok(images) => Response::ListResult { images },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::SetFavorite { image_id, favorite } => {
            let fav_val = if favorite { 1 } else { 0 };
            match sqlx::query("UPDATE images SET favorite = ? WHERE id = ?")
                .bind(fav_val)
                .bind(image_id)
                .execute(db)
                .await
            {
                Ok(_) => Response::Success,
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

        Request::ReindexVectors => {
            let active = model_manager.active_model();
            let source_name = match active {
                EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
                EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
            };
            let source_id: i64 =
                match sqlx::query_as::<_, (i64,)>("SELECT id FROM sources WHERE name = ? LIMIT 1")
                    .bind(source_name)
                    .fetch_one(db)
                    .await
                {
                    Ok(row) => row.0,
                    Err(e) => {
                        return Response::Error {
                            message: format!("Failed to fetch source ID for reindex: {:?}", e),
                        };
                    }
                };
            if let Err(e) = vector_index.clear() {
                return Response::Error {
                    message: format!("Failed to clear index: {:?}", e),
                };
            }
            let sql = "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state, vector_checksum)
                       SELECT id, ?, '', 'pending', NULL FROM images WHERE deleted_at IS NULL
                       ON CONFLICT(image_id, source_id) DO UPDATE SET vector_state = 'pending', vector_id = '', vector_checksum = NULL";
            if let Err(e) = sqlx::query(sql).bind(source_id).execute(db).await {
                return Response::Error {
                    message: format!("Failed to reset image vectors: {:?}", e),
                };
            }
            Response::Success
        }

        Request::GetSettings => {
            let s = settings.lock().await;
            Response::SettingsResult {
                clip_device: s.clip_device.clone(),
                tagger_device: s.tagger_device.clone(),
                idle_timeout_secs: s.idle_timeout_secs,
                embedding_model: s.embedding_model,
            }
        }

        Request::UpdateSettings {
            clip_device,
            tagger_device,
            idle_timeout_secs,
            embedding_model,
        } => {
            let mut model_changed = false;
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
            if let Some(ref em) = embedding_model {
                if s.embedding_model != *em {
                    s.embedding_model = *em;
                    model_changed = true;
                }
            }
            if let Err(e) = save_settings(data_dir, &s) {
                warn!("Failed to save settings: {:?}", e);
            }
            let clip = s.clip_device.clone();
            let tagger_dev = s.tagger_device.clone();
            let idle = s.idle_timeout_secs;
            let active_model = s.embedding_model;
            drop(s);

            // Apply CLIP device change immediately (unloads sessions for reload)
            if clip_device.is_some() {
                model_manager.set_device(clip.clone());
            }

            // Apply Tagger device change immediately (unloads if loaded)
            if tagger_device.is_some() {
                tagger.set_device(tagger_dev.clone());
            }

            if model_changed {
                model_manager.set_active_model(active_model);
                if let Err(e) = model_manager.init() {
                    return Response::Error {
                        message: format!("Failed to initialize new model: {:?}", e),
                    };
                }

                let source_name = match active_model {
                    EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
                    EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
                };
                let source_id: i64 = match sqlx::query_as::<_, (i64,)>(
                    "SELECT id FROM sources WHERE name = ? LIMIT 1",
                )
                .bind(source_name)
                .fetch_one(db)
                .await
                {
                    Ok(row) => row.0,
                    Err(e) => {
                        return Response::Error {
                            message: format!("Failed to fetch source ID for model change: {:?}", e),
                        };
                    }
                };
                if let Err(e) = vector_index.clear() {
                    return Response::Error {
                        message: format!("Failed to clear index: {:?}", e),
                    };
                }
                let sql = "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state, vector_checksum)
                           SELECT id, ?, '', 'pending', NULL FROM images WHERE deleted_at IS NULL
                           ON CONFLICT(image_id, source_id) DO UPDATE SET vector_state = 'pending', vector_id = '', vector_checksum = NULL";
                if let Err(e) = sqlx::query(sql).bind(source_id).execute(db).await {
                    return Response::Error {
                        message: format!("Failed to reset image vectors: {:?}", e),
                    };
                }
            }

            info!(
                "Settings updated: clip_device={:?}, tagger_device={:?}, idle_timeout={}s, embedding_model={:?}",
                clip, tagger_dev, idle, active_model
            );
            Response::SettingsResult {
                clip_device: clip,
                tagger_device: tagger_dev,
                idle_timeout_secs: idle,
                embedding_model: active_model,
            }
        }

        Request::GetTagStatistics => {
            let result = sqlx::query_as::<_, TagStat>(
                r#"
                SELECT t.name AS tag, t.category AS category, COUNT(*) AS count
                FROM tags t
                JOIN image_tags it ON it.tag_id = t.id
                WHERE it.is_deleted = 0
                GROUP BY t.id
                ORDER BY count DESC
                "#,
            )
            .fetch_all(db)
            .await;

            match result {
                Ok(tags) => Response::TagStatisticsResult { tags },
                Err(e) => Response::Error {
                    message: format!("Failed to fetch tag statistics: {:?}", e),
                },
            }
        }

        Request::GetDashboardInit => {
            // All data needed for dashboard init — single round-trip
            let (status_result, settings_result) = tokio::join!(
                async {
                    let active = { settings.lock().await.embedding_model };
                    query_status(db, active).await
                },
                async { settings.lock().await.clone() },
            );

            let (image_count, vector_count, pending_jobs, preprocessing_jobs) = match status_result
            {
                Ok(v) => v,
                Err(e) => {
                    return Response::Error {
                        message: e.to_string(),
                    };
                }
            };

            let tagger_status = tagger.status();
            let settings_val = settings_result;

            let (featured_result, latest_resp) = tokio::join!(
                get_featured_image(db, &data_dir),
                list_images_logic(8, 0, None, db),
            );

            let featured_images = featured_result.into_iter().collect();
            let latest_images = latest_resp.unwrap_or_default();

            Response::DashboardInitResult {
                image_count,
                vector_count,
                pending_jobs,
                preprocessing_jobs,
                tagger_loaded: tagger_status.loaded,
                tagger_model_path: tagger_status.model_path,
                tagger_total_tags: tagger_status.total_tags,
                clip_device: settings_val.clip_device,
                tagger_device: settings_val.tagger_device,
                idle_timeout_secs: settings_val.idle_timeout_secs,
                embedding_model: settings_val.embedding_model,
                featured_images,
                latest_images,
            }
        }

        Request::GetImportedFolders => match get_imported_folders_logic(db).await {
            Ok(folders) => Response::ImportedFoldersResult { folders },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::BackfillImageFolders => match backfill_image_folders(db).await {
            Ok(count) => Response::BackfillResult {
                images_backfilled: count,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::CreateConcept {
            name,
            category,
            threshold,
            sample_image_ids,
        } => match create_concept_logic(
            db,
            &name,
            &category,
            threshold,
            &sample_image_ids,
            &model_manager,
        )
        .await {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::ListConcepts => match list_concepts_logic(db).await {
            Ok(concepts) => Response::ConceptListResult { concepts },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::UpdateConcept {
            id,
            threshold,
            category,
        } => match update_concept_logic(db, id, threshold, category).await {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::DeleteConcept { id } => match delete_concept_logic(db, id).await {
            Ok(_) => Response::Success,
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::AddConceptSamples {
            concept_id,
            image_ids,
        } => match add_concept_samples_logic(db, concept_id, &image_ids, &model_manager).await {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::RemoveConceptSample {
            concept_id,
            image_id,
        } => match remove_concept_sample_logic(db, concept_id, image_id, &model_manager).await {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::RescanConcept { concept_id } => match rescan_concept_logic(db, concept_id, &model_manager, vector_index).await {
            Ok(count) => Response::ConceptRescannedResult {
                concept_id,
                tagged_count: count,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::GetConceptSamples { concept_id } => {
            match get_concept_samples_logic(db, concept_id).await {
                Ok(samples) => Response::ConceptSamplesResult { concept_id, samples },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
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
    let t_start = std::time::Instant::now();

    // 1. Resolve image path
    let t0 = std::time::Instant::now();
    let row: Option<(String,)> =
        sqlx::query_as("SELECT current_filepath FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_optional(db)
            .await?;

    let filepath = match row {
        Some(r) => r.0,
        None => anyhow::bail!("Image {} not found", image_id),
    };
    let db_resolve_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // 2. Dedup/Overwrite check
    let t1 = std::time::Instant::now();
    let camie_source: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:camie-tagger-v2' LIMIT 1")
            .fetch_optional(db)
            .await?;

    if let Some((camie_source_id,)) = camie_source {
        if force {
            // Wipe existing active Camie tags (preserve blacklisted negative samples!)
            sqlx::query("DELETE FROM image_tags WHERE image_id = ? AND source_id = ? AND is_blacklisted = 0")
                .bind(image_id)
                .bind(camie_source_id)
                .execute(db)
                .await?;
            info!(
                "Forced overwrite: wiped existing Camie tags for image {}",
                image_id
            );
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
    let db_dedup_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // 3. Run inference in a blocking thread (model uses std::sync::Mutex)
    let t2 = std::time::Instant::now();
    let tagger_clone = Arc::clone(tagger);
    let filepath_clone = filepath.clone();
    let predictions =
        tokio::task::spawn_blocking(move || tagger_clone.tag_image(&filepath_clone, threshold))
            .await
            .context("spawn_blocking panicked during Camie inference")??;
    let inference_ms = t2.elapsed().as_secs_f64() * 1000.0;

    // 4. Get camie source_id (seed it if missing)
    let t3 = std::time::Instant::now();
    let source_row: (i64,) =
        sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:camie-tagger-v2' LIMIT 1")
            .fetch_one(db)
            .await?;
    let source_id = source_row.0;

    // 5. Generate a shared transaction_id for this tagging run (enables future undo)
    let transaction_id = uuid::Uuid::new_v4().to_string();

    // Fetch blacklisted tag names for this image so AI auto-tagging NEVER re-applies negative samples
    let blacklisted_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT t.name FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         WHERE it.image_id = ? AND it.is_blacklisted = 1",
    )
    .bind(image_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let blacklisted_names: std::collections::HashSet<String> =
        blacklisted_rows.into_iter().map(|(name,)| name).collect();

    // 6. Persist each predicted tag
    let mut tag_summaries: Vec<TagSummary> = Vec::with_capacity(predictions.len());

    for pred in &predictions {
        if blacklisted_names.contains(&pred.tag) {
            info!("Skipping blacklisted AI tag '{}' for image {}", pred.tag, image_id);
            continue;
        }
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

        // Insert or replace with confidence and transaction tracking (resets is_deleted to 0 if previously soft-deleted)
        sqlx::query(
            "INSERT OR REPLACE INTO image_tags
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
            source_name: Some(curator_core::constants::SOURCE_CAMIE.to_string()),
            is_blacklisted: false,
        });
    }

    info!(
        "Auto-tagged image {} with {} tags (tx: {})",
        image_id,
        tag_summaries.len(),
        &transaction_id[..8]
    );

    let db_write_ms = t3.elapsed().as_secs_f64() * 1000.0;
    let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;
    info!(
        "TagImage {} timing: db_resolve={:.1}ms db_dedup={:.1}ms inference={:.1}ms db_write={:.1}ms total={:.1}ms",
        image_id, db_resolve_ms, db_dedup_ms, inference_ms, db_write_ms, total_ms
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

async fn query_status(
    db: &SqlitePool,
    active: EmbeddingModel,
) -> Result<(i64, i64, i64, i64), Error> {
    let source_name = match active {
        EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let source_row: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
            .bind(source_name)
            .fetch_optional(db)
            .await?;
    let source_id = source_row.map(|r| r.0).unwrap_or(0);

    let images: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM images WHERE deleted_at IS NULL")
        .fetch_one(db)
        .await?;
    let vectors: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'ready' AND source_id = ?",
    )
    .bind(source_id)
    .fetch_one(db)
    .await?;
    let pending: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'pending' AND source_id = ?",
    )
    .bind(source_id)
    .fetch_one(db)
    .await?;
    let preprocessing: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'preprocessing' AND source_id = ?",
    )
    .bind(source_id)
    .fetch_one(db)
    .await?;
    Ok((images.0, vectors.0, pending.0, preprocessing.0))
}

async fn get_imported_folders_logic(db: &SqlitePool) -> Result<Vec<FolderDetails>, Error> {
    #[derive(Debug, sqlx::FromRow)]
    struct FolderRow {
        id: i64,
        path: String,
        name: String,
        imported_at: String,
        image_count: i64,
        vector_ready: i64,
        vector_pending: i64,
    }

    let rows: Vec<FolderRow> = sqlx::query_as(
        r#"
        SELECT
            f.id,
            f.path,
            f.name,
            f.imported_at,
            COUNT(i.id) as image_count,
            COALESCE(SUM(CASE WHEN iv.vector_state = 'ready' THEN 1 ELSE 0 END), 0) as vector_ready,
            COALESCE(SUM(CASE WHEN iv.vector_state IN ('pending', 'preprocessing') THEN 1 ELSE 0 END), 0) as vector_pending
        FROM folders f
        LEFT JOIN images i ON i.folder_id = f.id AND i.deleted_at IS NULL
        LEFT JOIN image_vectors iv ON iv.image_id = i.id
        GROUP BY f.id
        ORDER BY f.imported_at DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| FolderDetails {
            id: r.id,
            path: r.path,
            name: r.name,
            imported_at: r.imported_at,
            image_count: r.image_count,
            vector_ready: r.vector_ready,
            vector_pending: r.vector_pending,
        })
        .collect())
}

/// Backfill existing images that don't have a folder_id by assigning them
/// to their parent directory folder.
async fn backfill_image_folders(db: &SqlitePool) -> Result<i64, Error> {
    #[derive(Debug, sqlx::FromRow)]
    struct ImageRow {
        id: i64,
        current_filepath: String,
    }

    let images: Vec<ImageRow> = sqlx::query_as(
        "SELECT id, current_filepath FROM images WHERE folder_id IS NULL AND deleted_at IS NULL",
    )
    .fetch_all(db)
    .await?;

    let mut backfilled: i64 = 0;

    for img in images {
        let path = Path::new(&img.current_filepath);
        let parent_dir = match path.parent() {
            Some(p) => p.to_str().unwrap_or(""),
            None => continue,
        };

        if parent_dir.is_empty() {
            continue;
        }

        let folder_id = get_or_create_folder(parent_dir, db).await?;

        sqlx::query("UPDATE images SET folder_id = ? WHERE id = ?")
            .bind(folder_id)
            .bind(img.id)
            .execute(db)
            .await?;

        backfilled += 1;
    }

    info!("Backfilled {} images with folder assignments", backfilled);
    Ok(backfilled)
}

async fn import_image_logic(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
) -> Result<(i64, String, usize, Option<i64>), Error> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!(
            "File or directory does not exist: {}",
            path_str
        ));
    }

    if path.is_dir() {
        // Track the imported folder
        let folder_id = get_or_create_folder(path_str, db).await?;

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

        let total_count = image_paths.len();
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(image_paths.len());

        let chunk_size = (image_paths.len() + num_threads - 1) / num_threads;
        let paths_vec: Vec<String> = image_paths
            .iter()
            .filter_map(|p| p.to_str().map(|s| s.to_string()))
            .collect();

        struct PreppedImage {
            path_str: String,
            sha256: String,
            mtime: i64,
            phash: Option<String>,
        }

        let mut prepped_images = Vec::with_capacity(paths_vec.len());

        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(num_threads);

            for chunk in paths_vec.chunks(chunk_size) {
                let chunk_paths = chunk.to_vec();
                let handle = s.spawn(move || {
                    let mut items = Vec::with_capacity(chunk_paths.len());
                    for p_str in chunk_paths {
                        let p = Path::new(&p_str);
                        if let Ok(metadata) = fs::metadata(p) {
                            let mtime = metadata
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0);
                            if let Ok(data) = fs::read(p) {
                                let sha256 = format!("{:x}", sha2::Sha256::digest(&data));
                                items.push(PreppedImage {
                                    path_str: p_str,
                                    sha256,
                                    mtime,
                                    phash: None,
                                });
                            }
                        }
                    }
                    items
                });
                handles.push(handle);
            }

            for handle in handles {
                if let Ok(items) = handle.join() {
                    prepped_images.extend(items);
                }
            }
        });

        let source_name = match active {
            EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
            EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
        };
        let clip_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
            .bind(source_name)
            .fetch_one(db)
            .await?;
        let clip_source_id = clip_row.0;

        let mut first_id = 0;
        let mut first_sha = String::new();
        let mut imported_any = false;

        for item in prepped_images {
            let existing: Option<(i64, String)> =
                sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
                    .bind(&item.sha256)
                    .fetch_optional(db)
                    .await?;

            let img_id = if let Some((id, _old_path)) = existing {
                let _ = sqlx::query(
                    "UPDATE images SET current_filepath = ?, mtime = ?, phash = ?, folder_id = COALESCE(folder_id, ?), deleted_at = NULL WHERE id = ?",
                )
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(&item.phash)
                .bind(folder_id)
                .bind(id)
                .execute(db)
                .await;

                let vec_exists: Option<(String,)> = sqlx::query_as(
                    "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
                )
                .bind(id)
                .bind(clip_source_id)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

                if vec_exists.is_none() {
                    let _ = sqlx::query(
                        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                    )
                    .bind(id)
                    .bind(clip_source_id)
                    .execute(db)
                    .await;
                }
                id
            } else {
                let id = sqlx::query(
                    "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&item.sha256)
                .bind(&item.phash)
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(Some(folder_id))
                .execute(db)
                .await?
                .last_insert_rowid();

                let _ = sqlx::query(
                    "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                )
                .bind(id)
                .bind(clip_source_id)
                .execute(db)
                .await;

                id
            };

            if !imported_any {
                first_id = img_id;
                first_sha = item.sha256;
                imported_any = true;
            }
        }

        if imported_any {
            Ok((first_id, first_sha, total_count, Some(folder_id)))
        } else {
            Err(anyhow::anyhow!(
                "Failed to import any images from directory: {}",
                path_str
            ))
        }
    } else {
        // For single file import, track the parent folder
        let parent_dir = path
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or(path_str);
        let folder_id = get_or_create_folder(parent_dir, db).await?;
        let (id, sha) = import_single_image(path_str, db, active, Some(folder_id)).await?;
        Ok((id, sha, 1, Some(folder_id)))
    }
}

/// Get or create a folder record, returning its ID.
async fn get_or_create_folder(folder_path: &str, db: &SqlitePool) -> Result<i64, Error> {
    // Try to find existing folder
    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE path = ? LIMIT 1")
        .bind(folder_path)
        .fetch_optional(db)
        .await?;

    if let Some((id,)) = existing {
        return Ok(id);
    }

    // Extract folder name from path
    let folder_name = Path::new(folder_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(folder_path)
        .to_string();

    // Insert new folder
    let id = sqlx::query("INSERT INTO folders (path, name) VALUES (?, ?)")
        .bind(folder_path)
        .bind(&folder_name)
        .execute(db)
        .await?
        .last_insert_rowid();

    info!("Created folder record: {} (id={})", folder_name, id);
    Ok(id)
}

async fn import_single_image(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
    folder_id: Option<i64>,
) -> Result<(i64, String), Error> {
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

    let source_name = match active {
        EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let clip_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
        .bind(source_name)
        .fetch_one(db)
        .await?;
    let clip_source_id = clip_row.0;

    let phash = match curator_core::vector::compute_ahash(path) {
        Ok(h) => Some(h),
        Err(e) => {
            warn!("Failed to compute aHash for image {:?}: {:?}", path, e);
            None
        }
    };

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
            .bind(&sha256)
            .fetch_optional(db)
            .await?;

    if let Some((id, _old_path)) = existing {
        sqlx::query(
            "UPDATE images SET current_filepath = ?, mtime = ?, phash = ?, folder_id = COALESCE(folder_id, ?), deleted_at = NULL WHERE id = ?",
        )
        .bind(path_str)
        .bind(mtime)
        .bind(&phash)
        .bind(folder_id)
        .bind(id)
        .execute(db)
        .await?;

        let vec_exists: Option<(String,)> = sqlx::query_as(
            "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
        )
        .bind(id)
        .bind(clip_source_id)
        .fetch_optional(db)
        .await
        .unwrap_or(None);

        if vec_exists.is_none() {
            let _ = sqlx::query(
                "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
            )
            .bind(id)
            .bind(clip_source_id)
            .execute(db)
            .await?;
        }
        return Ok((id, sha256));
    }

    let id = sqlx::query(
        "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&sha256)
    .bind(&phash)
    .bind(path_str)
    .bind(mtime)
    .bind(folder_id)
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

    let source_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = 'user' LIMIT 1")
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
    query_image_path: Option<String>,
    tag_filter: Option<String>,
    concept_id: Option<i64>,
    limit: usize,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<Vec<SearchMatch>, Error> {
    let mut candidate_ids: Option<std::collections::HashSet<i64>> = None;
    let mut vector_scores: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
    let mut exact_matches = std::collections::HashSet::new();
    let mut perceptual_matches = std::collections::HashMap::new();

    // Custom Concept Vector Prototype Search (matches both tagged & untagged candidate images)
    if let Some(c_id) = concept_id {
        if let Ok(concept) = get_custom_concept_by_id(db, c_id).await {
            let active_model = model_manager.active_model();
            let source_name = match active_model {
                EmbeddingModel::ClipVitB32 => curator_core::constants::SOURCE_CLIP,
                EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
            };
            let source_row: Option<(i64,)> = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
                .bind(source_name)
                .fetch_optional(db)
                .await?;
            if let Some((source_id,)) = source_row {
                let vec_row: Option<(Vec<u8>,)> = sqlx::query_as(
                    "SELECT vector FROM custom_concept_vectors WHERE concept_id = ? AND source_id = ? LIMIT 1",
                )
                .bind(c_id)
                .bind(source_id)
                .fetch_optional(db)
                .await?;

                if let Some((blob,)) = vec_row {
                    let proto_vec = bytes_to_vector(&blob);
                    if !proto_vec.is_empty() {
                        let mut ids = std::collections::HashSet::new();

                        // Fetch Camie Tagger V2 logit probability vector profile for this concept's ground-truth samples
                        let sample_camie_logits: Vec<(i64, f64)> = sqlx::query_as(
                            "SELECT it.tag_id, AVG(it.confidence) as avg_conf
                             FROM image_tags it
                             JOIN custom_concept_samples ccs ON it.image_id = ccs.image_id
                             JOIN sources s ON it.source_id = s.id
                             WHERE ccs.concept_id = ? AND s.name = 'ai:camie-tagger-v2' AND it.is_deleted = 0
                             GROUP BY it.tag_id",
                        )
                        .bind(c_id)
                        .fetch_all(db)
                        .await
                        .unwrap_or_default();

                        let results = vector_index.search(&proto_vec, limit.max(500))?;
                        for (id, dist) in results {
                            let image_id = id as i64;
                            let clip_sim = 1.0 - dist;

                            // Compute exact Cosine Similarity in Camie Logit Vector Space
                            let mut camie_logit_sim = 0.0f32;
                            let mut has_cand_camie = false;
                            if !sample_camie_logits.is_empty() {
                                let candidate_camie_tags: Vec<(i64, f64)> = sqlx::query_as(
                                    "SELECT it.tag_id, it.confidence
                                     FROM image_tags it
                                     JOIN sources s ON it.source_id = s.id
                                     WHERE it.image_id = ? AND s.name = 'ai:camie-tagger-v2' AND it.is_deleted = 0",
                                )
                                .bind(image_id)
                                .fetch_all(db)
                                .await
                                .unwrap_or_default();

                                if !candidate_camie_tags.is_empty() {
                                    has_cand_camie = true;
                                    let cand_map: std::collections::HashMap<i64, f64> = candidate_camie_tags.into_iter().collect();
                                    let mut dot_product = 0.0f64;
                                    let mut proto_norm_sq = 0.0f64;
                                    let mut cand_norm_sq = 0.0f64;

                                    for &(tag_id, proto_conf) in &sample_camie_logits {
                                        proto_norm_sq += proto_conf * proto_conf;
                                        if let Some(&cand_conf) = cand_map.get(&tag_id) {
                                            dot_product += proto_conf * cand_conf;
                                        }
                                    }

                                    for &cand_conf in cand_map.values() {
                                        cand_norm_sq += cand_conf * cand_conf;
                                    }

                                    if proto_norm_sq > 0.0 && cand_norm_sq > 0.0 {
                                        camie_logit_sim = (dot_product / (proto_norm_sq.sqrt() * cand_norm_sq.sqrt())) as f32;
                                    }
                                }
                            }

                            // Score candidate using Temperature-Scaled Linear SVM Decision Boundary Probability
                            let svm_score = if clip_sim > 0.55 { (clip_sim - 0.55) / 0.45 } else { 0.0 };

                            let (final_score, is_match) = if has_cand_camie {
                                if camie_logit_sim > 0.0 {
                                    let score = 0.50 * svm_score + 0.50 * camie_logit_sim;
                                    (score, score >= (concept.threshold * 0.60) || camie_logit_sim >= (concept.threshold * 0.60))
                                } else {
                                    // Candidate image HAS Camie tags, but 0% overlap with concept Camie tags: exclude!
                                    (0.0f32, false)
                                }
                            } else {
                                // Candidate image is UNTAGGED by Camie: evaluate using Linear SVM decision score!
                                (svm_score, svm_score >= (concept.threshold * 0.60))
                            };

                            if is_match {
                                ids.insert(image_id);
                                vector_scores.insert(image_id, final_score);
                            }
                        }

                        // Also include any images explicitly tagged with this concept name
                        let tagged_images: Vec<(i64,)> = sqlx::query_as(
                            "SELECT DISTINCT it.image_id FROM image_tags it
                             JOIN tags t ON it.tag_id = t.id
                             WHERE t.name = ? AND it.is_deleted = 0",
                        )
                        .bind(&concept.name)
                        .fetch_all(db)
                        .await
                        .unwrap_or_default();

                        for r in tagged_images {
                            ids.insert(r.0);
                            vector_scores.entry(r.0).or_insert(1.0);
                        }

                        candidate_ids = Some(ids);
                    }
                }
            }
        }
    }

    if let Some(img_path) = query_image_path {
        let path = std::path::Path::new(&img_path);
        if path.exists() {
            // 1. Exact Match via SHA256
            if let Ok(data) = std::fs::read(path) {
                let sha256 = format!("{:x}", sha2::Sha256::digest(&data));
                let rows: Vec<(i64,)> =
                    sqlx::query_as("SELECT id FROM images WHERE sha256 = ? AND deleted_at IS NULL")
                        .bind(&sha256)
                        .fetch_all(db)
                        .await
                        .unwrap_or_default();
                for r in rows {
                    exact_matches.insert(r.0);
                }
            }

            // 2. Perceptual Close Match via aHash
            if let Ok(query_ahash) = curator_core::vector::compute_ahash(path) {
                let query_val = u64::from_str_radix(&query_ahash, 16).unwrap_or(0);
                let rows: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT id, phash FROM images WHERE phash IS NOT NULL AND deleted_at IS NULL",
                )
                .fetch_all(db)
                .await
                .unwrap_or_default();
                for (id, db_phash) in rows {
                    let db_val = u64::from_str_radix(&db_phash, 16).unwrap_or(0);
                    let dist = (query_val ^ db_val).count_ones();
                    if dist <= 10 {
                        perceptual_matches.insert(id, dist);
                    }
                }
            }

            // 3. Semantic Vector Search
            let query_vector = model_manager.generate_image_embedding(path)?;
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

    if let Some(ref text) = query_text {
        if !text.trim().is_empty() {
            let query_vector = model_manager.generate_text_embedding(text)?;
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

    let mut target_set = std::collections::HashSet::new();
    if let Some(c_ids) = candidate_ids {
        target_set.extend(c_ids);
    }
    target_set.extend(exact_matches.iter().copied());
    target_set.extend(perceptual_matches.keys().copied());

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

            let tag_set: std::collections::HashSet<i64> =
                tagged_images.into_iter().map(|row| row.0).collect();

            if target_set.is_empty()
                && query_text.is_none()
                && exact_matches.is_empty()
                && perceptual_matches.is_empty()
            {
                target_set = tag_set;
            } else {
                target_set = target_set.intersection(&tag_set).cloned().collect();
            }
        }
    }

    let target_ids = if target_set.is_empty()
        && query_text.is_none()
        && exact_matches.is_empty()
        && perceptual_matches.is_empty()
    {
        let latest: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(db)
        .await?;
        latest.into_iter().map(|r| r.0).collect()
    } else {
        target_set.into_iter().collect::<Vec<i64>>()
    };

    let mut matches = Vec::new();
    for id in target_ids {
        if let Ok(details) = get_image_logic(id, db).await {
            let (match_type, score, hamming_distance) = if exact_matches.contains(&id) {
                ("exact".to_string(), 1.0, None)
            } else if let Some(&dist) = perceptual_matches.get(&id) {
                (
                    "perceptual".to_string(),
                    1.0 - (dist as f32 / 64.0),
                    Some(dist),
                )
            } else {
                let sem_score = vector_scores.get(&details.id).cloned().unwrap_or(0.0);
                ("semantic".to_string(), sem_score, None)
            };

            matches.push(SearchMatch {
                id: details.id,
                filepath: details.current_filepath,
                score,
                tags: details.tags,
                match_type,
                hamming_distance,
            });
        }
    }

    matches.sort_by(|a, b| {
        let priority = |m: &str| -> i32 {
            match m {
                "exact" => 0,
                "perceptual" => 1,
                _ => 2,
            }
        };
        let p_a = priority(&a.match_type);
        let p_b = priority(&b.match_type);
        if p_a != p_b {
            p_a.cmp(&p_b)
        } else {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });
    matches.truncate(limit);
    Ok(matches)
}

async fn list_images_logic(
    limit: usize,
    offset: usize,
    only_favorites: Option<bool>,
    db: &SqlitePool,
) -> Result<Vec<ImageDetails>, Error> {
    let only_favs = only_favorites.unwrap_or(false);
    // Single query: fetch images with their tags in one go (avoids N+1)
    // Subquery ensures LIMIT applies to distinct images, not JOINed rows
    let rows: Vec<ImageRow> = sqlx::query_as(
        r#"
            SELECT i.id, i.sha256, i.current_filepath, i.mtime, i.created_at, i.favorite,
                   t.name, t.category, it.confidence, s.name as source_name
            FROM (
                SELECT id FROM images 
                WHERE deleted_at IS NULL AND (?1 = 0 OR favorite = 1)
                ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3
            ) sub
            JOIN images i ON i.id = sub.id
            LEFT JOIN image_tags it ON it.image_id = i.id AND it.is_deleted = 0
            LEFT JOIN tags t ON it.tag_id = t.id
            LEFT JOIN sources s ON it.source_id = s.id
            ORDER BY i.created_at DESC, i.id DESC
            "#,
    )
    .bind(if only_favs { 1i64 } else { 0i64 })
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(db)
    .await?;

    // Group rows by image while preserving SQL sort order
    let mut image_order: Vec<i64> = Vec::new();
    let mut image_map: std::collections::HashMap<i64, ImageDetails> =
        std::collections::HashMap::new();
    for (
        id,
        sha256,
        current_filepath,
        mtime,
        created_at,
        favorite,
        tag_name,
        tag_category,
        confidence,
        source_name,
    ) in rows
    {
        if !image_map.contains_key(&id) {
            image_order.push(id);
        }
        let entry = image_map.entry(id).or_insert_with(|| ImageDetails {
            id,
            sha256,
            current_filepath,
            mtime,
            created_at,
            tags: Vec::new(),
            blacklisted_tags: Vec::new(),
            vector_state: String::new(),
            favorite,
        });
        if let (Some(name), Some(category)) = (tag_name, tag_category) {
            entry.tags.push(TagSummary {
                tag: name,
                category,
                confidence: confidence.unwrap_or(0.0),
                source_name: source_name.clone(),
                is_blacklisted: false,
            });
        }
    }

    // Fetch vector_state for each image in one query
    let ids: Vec<i64> = image_map.keys().copied().collect();
    if !ids.is_empty() {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT image_id, vector_state FROM image_vectors WHERE image_id IN ({})",
            placeholders
        );
        let mut q = sqlx::query_as::<_, (i64, String)>(&query);
        for id in &ids {
            q = q.bind(id);
        }
        if let Ok(vrows) = q.fetch_all(db).await {
            for (vid, state) in vrows {
                if let Some(img) = image_map.get_mut(&vid) {
                    img.vector_state = state;
                }
            }
        }
    }

    let mut images: Vec<ImageDetails> = Vec::with_capacity(image_order.len());
    for id in image_order {
        if let Some(mut img) = image_map.remove(&id) {
            // Sort tags: Rank #1 (custom concepts & user tags), followed by character, copyright, meta, then general.
            img.tags.sort_by(|a, b| {
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
            images.push(img);
        }
    }
    Ok(images)
}

async fn get_image_logic(image_id: i64, db: &SqlitePool) -> Result<ImageDetails, Error> {
    let img: curator_core::db::models::Image =
        sqlx::query_as("SELECT * FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(image_id)
            .fetch_one(db)
            .await?;

    let all_tag_rows: Vec<(String, String, f32, Option<String>, bool)> = sqlx::query_as(
        "SELECT t.name, t.category, it.confidence, s.name, (it.is_blacklisted = 1)
         FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         LEFT JOIN sources s ON it.source_id = s.id
         WHERE it.image_id = ? AND (it.is_deleted = 0 OR it.is_blacklisted = 1)",
    )
    .bind(image_id)
    .fetch_all(db)
    .await?;

    let mut active_tags = Vec::new();
    let mut blacklisted_tags = Vec::new();

    for (tag, category, confidence, source_name, is_blacklisted) in all_tag_rows {
        let summary = TagSummary {
            tag,
            category,
            confidence,
            source_name,
            is_blacklisted,
        };

        if is_blacklisted {
            blacklisted_tags.push(summary);
        } else {
            active_tags.push(summary);
        }
    }

    // Sort tags: Rank #1 (custom concepts & user tags), followed by character, copyright, meta, then general.
    let mut sorted_tags = active_tags;
    sorted_tags.sort_by(|a, b| {
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

    // Use fetch_optional to avoid panic if image_vectors row is missing
    let vector_state: String =
        sqlx::query_as("SELECT vector_state FROM image_vectors WHERE image_id = ? LIMIT 1")
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
        blacklisted_tags,
        vector_state,
        favorite: img.favorite,
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

async fn get_featured_image(db: &SqlitePool, data_dir: &Path) -> Option<ImageDetails> {
    let today_str = {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let day_number = secs / 86400;
        format!("day_{}", day_number)
    };

    let featured_file = data_dir.join("featured_of_the_day.txt");

    // 1. If today's featured image file exists and points to an active image, return it
    if let Ok(content) = fs::read_to_string(&featured_file) {
        let parts: Vec<&str> = content.trim().splitn(2, '|').collect();
        if parts.len() == 2 && parts[0] == today_str {
            if let Ok(id) = parts[1].parse::<i64>() {
                if let Ok(img) = get_image_logic(id, db).await {
                    return Some(img);
                }
            }
        }
    }

    // 2. Otherwise (file missing, expired, or saved image deleted), pick a random active image for today
    if let Ok(Some((rand_id,))) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY RANDOM() LIMIT 1",
    )
    .fetch_optional(db)
    .await
    {
        if let Ok(img) = get_image_logic(rand_id, db).await {
            let _ = fs::write(&featured_file, format!("{}|{}", today_str, rand_id));
            return Some(img);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Custom Concept Logic
// ---------------------------------------------------------------------------

async fn recompute_concept_prototype_logic(
    db: &SqlitePool,
    concept_id: i64,
    model_manager: &ModelManager,
) -> Result<Vec<f32>, Error> {
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ? AND is_negative = 0",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;

    let ids: Vec<i64> = sample_rows.into_iter().map(|(id,)| id).collect();
    let mut sample_vectors = Vec::new();

    if !ids.is_empty() {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query_str = format!("SELECT current_filepath FROM images WHERE id IN ({})", placeholders);
        let mut q = sqlx::query_as::<_, (String,)>(query_str.as_str());
        for id in &ids {
            q = q.bind(id);
        }
        if let Ok(image_paths) = q.fetch_all(db).await {
            for (path_str,) in image_paths {
                let path = Path::new(&path_str);
                if path.exists() {
                    if let Ok(vec) = model_manager.generate_image_embedding(path) {
                        sample_vectors.push(vec);
                    }
                }
            }
        }
    }

    // Generate CLIP text prompt embedding for semantic concept grounding
    let prompt_text = format!("anime artwork of {}", concept.name.replace('_', " "));
    let text_vec = model_manager.generate_text_embedding(&prompt_text).ok();

    // Fetch a sample of random background library image paths for Linear SVM negative training
    let neg_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT current_filepath FROM images WHERE deleted_at IS NULL AND id NOT IN (SELECT image_id FROM custom_concept_samples WHERE concept_id = ?) ORDER BY RANDOM() LIMIT 8",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mut negative_vectors = Vec::new();
    for (path_str,) in neg_rows {
        let path = Path::new(&path_str);
        if path.exists() {
            if let Ok(vec) = model_manager.generate_image_embedding(path) {
                negative_vectors.push(vec);
            }
        }
    }

    let (proto_vec, _bias) = curator_core::concept::train_linear_svm_decision_boundary(
        &sample_vectors,
        &negative_vectors,
        text_vec.as_deref(),
    );

    let blob = vector_to_bytes(&proto_vec);

    let active_model = model_manager.active_model();
    let source_name = match active_model {
        EmbeddingModel::ClipVitB32 => curator_core::constants::SOURCE_CLIP,
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let source_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
        .bind(source_name)
        .fetch_one(db)
        .await?;

    sqlx::query(
        "INSERT INTO custom_concept_vectors (concept_id, source_id, vector, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(concept_id, source_id) DO UPDATE SET vector = excluded.vector, updated_at = CURRENT_TIMESTAMP"
    )
    .bind(concept_id)
    .bind(source_row.0)
    .bind(blob)
    .execute(db)
    .await?;

    sqlx::query("UPDATE custom_concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(concept_id)
        .execute(db)
        .await?;

    Ok(proto_vec)
}

async fn get_custom_concept_by_id(db: &SqlitePool, concept_id: i64) -> Result<CustomConcept, Error> {
    let row: (i64, String, String, f64, i64, String, String) = sqlx::query_as(
        "SELECT c.id, c.name, c.category, c.threshold,
                (SELECT COUNT(*) FROM custom_concept_samples WHERE concept_id = c.id) as sample_count,
                c.created_at, c.updated_at
         FROM custom_concepts c
         WHERE c.id = ? LIMIT 1",
    )
    .bind(concept_id)
    .fetch_one(db)
    .await?;

    Ok(CustomConcept {
        id: row.0,
        name: row.1,
        category: row.2,
        threshold: row.3 as f32,
        sample_count: row.4 as usize,
        created_at: row.5,
        updated_at: row.6,
    })
}

async fn apply_concept_tags_to_samples(
    db: &SqlitePool,
    concept: &CustomConcept,
    sample_image_ids: &[i64],
) -> Result<(), Error> {
    let concept_source_row: (i64,) = sqlx::query_as(
        "SELECT id FROM sources WHERE name = 'ai:custom-concepts' LIMIT 1",
    )
    .fetch_one(db)
    .await?;
    let concept_source_id = concept_source_row.0;

    let tag_row: (i64,) = sqlx::query_as(
        "INSERT INTO tags (name, category) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET category = excluded.category
         RETURNING id",
    )
    .bind(&concept.name)
    .bind(&concept.category)
    .fetch_one(db)
    .await?;
    let tag_id = tag_row.0;

    for &img_id in sample_image_ids {
        let _ = sqlx::query(
            "INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted)
             VALUES (?, ?, ?, 1.0, 0)
             ON CONFLICT(image_id, tag_id, source_id, transaction_id) DO UPDATE SET is_deleted = 0, confidence = 1.0",
        )
        .bind(img_id)
        .bind(tag_id)
        .bind(concept_source_id)
        .execute(db)
        .await;
    }
    Ok(())
}

async fn create_concept_logic(
    db: &SqlitePool,
    name: &str,
    category: &str,
    threshold: f32,
    sample_image_ids: &[i64],
    model_manager: &ModelManager,
) -> Result<CustomConcept, Error> {
    let clean_name = sanitize_concept_name(name);
    if clean_name.is_empty() {
        return Err(anyhow::anyhow!("Concept name cannot be empty"));
    }

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM custom_concepts WHERE name = ? LIMIT 1")
        .bind(&clean_name)
        .fetch_optional(db)
        .await?;

    let concept_id = match existing {
        Some((id,)) => {
            sqlx::query("UPDATE custom_concepts SET category = ?, threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(category)
                .bind(threshold as f64)
                .bind(id)
                .execute(db)
                .await?;
            id
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO custom_concepts (name, category, threshold) VALUES (?, ?, ?)"
            )
            .bind(&clean_name)
            .bind(category)
            .bind(threshold as f64)
            .execute(db)
            .await?;
            res.last_insert_rowid()
        }
    };

    for &img_id in sample_image_ids {
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO custom_concept_samples (concept_id, image_id) VALUES (?, ?)"
        )
        .bind(concept_id)
        .bind(img_id)
        .execute(db)
        .await;
    }

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    // Tag all ground-truth sample images with this concept tag
    let _ = apply_concept_tags_to_samples(db, &concept, sample_image_ids).await;

    Ok(concept)
}

async fn list_concepts_logic(db: &SqlitePool) -> Result<Vec<CustomConcept>, Error> {
    let rows: Vec<(i64, String, String, f64, i64, String, String)> = sqlx::query_as(
        "SELECT c.id, c.name, c.category, c.threshold,
                (SELECT COUNT(*) FROM custom_concept_samples WHERE concept_id = c.id) as sample_count,
                c.created_at, c.updated_at
         FROM custom_concepts c
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| CustomConcept {
            id: r.0,
            name: r.1,
            category: r.2,
            threshold: r.3 as f32,
            sample_count: r.4 as usize,
            created_at: r.5,
            updated_at: r.6,
        })
        .collect())
}

async fn get_concept_samples_logic(
    db: &SqlitePool,
    concept_id: i64,
) -> Result<Vec<ImageDetails>, Error> {
    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;

    let mut samples = Vec::new();
    for (img_id,) in sample_rows {
        if let Ok(details) = get_image_logic(img_id, db).await {
            samples.push(details);
        }
    }
    Ok(samples)
}

async fn update_concept_logic(
    db: &SqlitePool,
    id: i64,
    threshold: Option<f32>,
    category: Option<String>,
) -> Result<CustomConcept, Error> {
    if let Some(th) = threshold {
        sqlx::query("UPDATE custom_concepts SET threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(th as f64)
            .bind(id)
            .execute(db)
            .await?;
    }

    if let Some(cat) = category {
        sqlx::query("UPDATE custom_concepts SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(&cat)
            .bind(id)
            .execute(db)
            .await?;
    }

    get_custom_concept_by_id(db, id).await
}

async fn delete_concept_logic(db: &SqlitePool, id: i64) -> Result<(), Error> {
    sqlx::query("DELETE FROM custom_concepts WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

async fn add_concept_samples_logic(
    db: &SqlitePool,
    concept_id: i64,
    image_ids: &[i64],
    model_manager: &ModelManager,
) -> Result<CustomConcept, Error> {
    for &img_id in image_ids {
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO custom_concept_samples (concept_id, image_id) VALUES (?, ?)"
        )
        .bind(concept_id)
        .bind(img_id)
        .execute(db)
        .await;
    }

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    // Tag the new ground-truth sample images with this concept tag
    let _ = apply_concept_tags_to_samples(db, &concept, image_ids).await;

    Ok(concept)
}

async fn remove_concept_sample_logic(
    db: &SqlitePool,
    concept_id: i64,
    image_id: i64,
    model_manager: &ModelManager,
) -> Result<CustomConcept, Error> {
    sqlx::query("DELETE FROM custom_concept_samples WHERE concept_id = ? AND image_id = ?")
        .bind(concept_id)
        .bind(image_id)
        .execute(db)
        .await?;

    recompute_concept_prototype_logic(db, concept_id, model_manager).await?;
    get_custom_concept_by_id(db, concept_id).await
}

async fn sync_all_custom_concept_tags(db: &SqlitePool) -> Result<(), Error> {
    let concepts = list_concepts_logic(db).await?;
    for concept in concepts {
        let sample_rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
        )
        .bind(concept.id)
        .fetch_all(db)
        .await?;

        let sample_ids: Vec<i64> = sample_rows.into_iter().map(|r| r.0).collect();
        if !sample_ids.is_empty() {
            let _ = apply_concept_tags_to_samples(db, &concept, &sample_ids).await;
        }
    }
    Ok(())
}

async fn rescan_concept_logic(
    db: &SqlitePool,
    concept_id: i64,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<usize, Error> {
    let concept = get_custom_concept_by_id(db, concept_id).await?;

    // Tag all ground-truth sample images with this concept tag
    let sample_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT image_id FROM custom_concept_samples WHERE concept_id = ?",
    )
    .bind(concept_id)
    .fetch_all(db)
    .await?;
    let sample_ids: Vec<i64> = sample_rows.into_iter().map(|r| r.0).collect();
    if !sample_ids.is_empty() {
        let _ = apply_concept_tags_to_samples(db, &concept, &sample_ids).await;
    }

    let active_model = model_manager.active_model();
    let source_name = match active_model {
        EmbeddingModel::ClipVitB32 => curator_core::constants::SOURCE_CLIP,
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let source_row: Option<(i64,)> = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
        .bind(source_name)
        .fetch_optional(db)
        .await?;
    let source_id = match source_row {
        Some((id,)) => id,
        None => return Ok(0),
    };

    let vec_row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT vector FROM custom_concept_vectors WHERE concept_id = ? AND source_id = ? LIMIT 1",
    )
    .bind(concept_id)
    .bind(source_id)
    .fetch_optional(db)
    .await?;

    let proto_vec = match vec_row {
        Some((blob,)) => bytes_to_vector(&blob),
        None => return Ok(0),
    };

    if proto_vec.is_empty() {
        return Ok(0);
    }

    let concept_source_row: (i64,) = sqlx::query_as(
        "SELECT id FROM sources WHERE name = 'ai:custom-concepts' LIMIT 1"
    )
    .fetch_one(db)
    .await?;
    let concept_source_id = concept_source_row.0;

    let tag_row: (i64,) = sqlx::query_as(
        "INSERT INTO tags (name, category) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET category = excluded.category
         RETURNING id",
    )
    .bind(&concept.name)
    .bind(&concept.category)
    .fetch_one(db)
    .await?;
    let tag_id = tag_row.0;

    let results = vector_index.search(&proto_vec, 10000)?;
    let mut match_count = 0usize;
    for (id, dist) in results {
        let image_id = id as i64;
        let sim = 1.0 - dist;
        if sim >= concept.threshold {
            let blacklisted: Option<(i64,)> = sqlx::query_as(
                "SELECT id FROM image_tags WHERE image_id = ? AND tag_id = ? AND is_blacklisted = 1 LIMIT 1",
            )
            .bind(image_id)
            .bind(tag_id)
            .fetch_optional(db)
            .await
            .unwrap_or_default();

            if blacklisted.is_none() {
                let _ = sqlx::query(
                    "INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted, is_blacklisted)
                     VALUES (?, ?, ?, ?, 0, 0)
                     ON CONFLICT(image_id, tag_id, source_id, transaction_id) DO UPDATE SET confidence = excluded.confidence"
                )
                .bind(image_id)
                .bind(tag_id)
                .bind(concept_source_id)
                .bind(sim as f64)
                .execute(db)
                .await;
                match_count += 1;
            }
        }
    }

    Ok(match_count)
}
