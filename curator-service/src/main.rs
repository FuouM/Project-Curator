use anyhow::{Context, Error};
use clap::Parser;
use curator_core::db::init_db;
use curator_core::ipc::{Request, Response};
use curator_core::tagger::TaggerEngine;
use curator_core::vector::{ModelManager, VectorIndex};
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

mod auth;
mod handlers;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AppSettings {
    clip_device: curator_core::ipc::DevicePreference,
    tagger_device: curator_core::ipc::DevicePreference,
    #[serde(default = "default_idle_timeout")]
    idle_timeout_secs: u64,
    #[serde(default)]
    embedding_model: curator_core::ipc::EmbeddingModel,
}

fn default_idle_timeout() -> u64 {
    300
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            clip_device: curator_core::ipc::DevicePreference::Auto,
            tagger_device: curator_core::ipc::DevicePreference::Auto,
            idle_timeout_secs: default_idle_timeout(),
            embedding_model: curator_core::ipc::EmbeddingModel::ClipVitB32,
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

pub(crate) fn save_settings(data_dir: &Path, settings: &AppSettings) -> Result<(), Error> {
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

    #[arg(long)]
    tagger_model_dir: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args = Args::parse();
    let data_dir = PathBuf::from(&args.data_dir);
    fs::create_dir_all(&data_dir)?;

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("curator.log"))
        .context("Failed to open log file")?;

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false);

    let console_layer = tracing_subscriber::fmt::layer();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(console_layer)
        .with(file_layer)
        .init();

    info!("Starting Project Curator Service...");

    let service_key = load_or_create_service_key(&data_dir)?;
    info!("Service Key authenticated successfully.");

    let db_path = data_dir.join("curator.db");
    let db = init_db(&db_path).await?;

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

    let _ = handlers::concepts::sync_all_custom_concept_tags(&db).await;

    let settings = load_settings(&data_dir);
    info!(
        "Settings loaded: clip_device={:?}, tagger_device={:?}, idle_timeout={}s",
        settings.clip_device, settings.tagger_device, settings.idle_timeout_secs
    );

    let model_dir = data_dir.join("models");
    let model_manager = ModelManager::new(&model_dir, settings.clip_device.clone());
    model_manager.set_active_model(settings.embedding_model);
    model_manager.init()?;
    let model_manager = Arc::new(model_manager);

    let index_path = data_dir.join("vector_index.usearch");
    let vector_index = Arc::new(VectorIndex::new(&index_path, 512)?);

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

    let worker = BackgroundWorker::new(db.clone(), model_manager.clone(), vector_index.clone());
    worker.start();

    let settings_arc = Arc::new(tokio::sync::Mutex::new(settings));

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

    let pipe_name = r"\\.\pipe\curator_ipc";
    info!("Listening on Named Pipe: {}", pipe_name);

    let db_arc = db.clone();
    let mm_arc = model_manager.clone();
    let vi_arc = vector_index.clone();
    let tagger_arc = tagger.clone();
    let key_arc = Arc::new(service_key);
    let data_dir_arc = Arc::new(data_dir);

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

    stream.write_all(b"AUTH_OK").await?;

    loop {
        let n = stream.read(&mut buffer).await?;
        if n == 0 {
            break;
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
        let response = handlers::handle_request(
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
