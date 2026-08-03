use anyhow::{Context, Error};
use clap::Parser;
use curator_core::db::init_db;
use curator_core::detection::{CCIPModel, DetectionPipeline, YoloDetector};
use curator_core::ipc::{Request, Response};
use curator_core::tagger::TaggerEngine;
use curator_core::thumbnail::ThumbnailCache;
use curator_core::vector::{ModelManager, VectorIndex};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use curator_core::grpc::curator_server::{Curator, CuratorServer};
use curator_core::grpc::{CuratorRequest, CuratorResponse};
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};


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
    detection: Arc<DetectionPipeline>,
    ocr: Arc<curator_core::OcrDetector>,
    service_key: Arc<String>,
    data_dir: Arc<PathBuf>,
    settings: Arc<tokio::sync::Mutex<AppSettings>>,
    thumbnail_cache: Arc<ThumbnailCache>,
    download_progress: handlers::models::DownloadProgressMap,
    cancel_tokens: handlers::models::CancelTokens,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AppSettings {
    clip_device: curator_core::ipc::DevicePreference,
    tagger_device: curator_core::ipc::DevicePreference,
    #[serde(default = "default_idle_timeout")]
    idle_timeout_secs: u64,
    #[serde(default)]
    embedding_model: curator_core::ipc::EmbeddingModel,
    #[serde(default)]
    detection_device: curator_core::ipc::DevicePreference,
    #[serde(default = "default_detection_metrics_device")]
    detection_metrics_device: curator_core::ipc::DevicePreference,
    #[serde(default)]
    ocr_device: curator_core::ipc::DevicePreference,
    #[serde(default)]
    model_precisions: std::collections::HashMap<String, curator_core::ipc::ModelPrecision>,
}

fn default_idle_timeout() -> u64 {
    5 * 60
}

fn default_detection_metrics_device() -> curator_core::ipc::DevicePreference {
    curator_core::ipc::DevicePreference::Cpu
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            clip_device: curator_core::ipc::DevicePreference::Auto,
            tagger_device: curator_core::ipc::DevicePreference::Auto,
            idle_timeout_secs: default_idle_timeout(),
            embedding_model: curator_core::ipc::EmbeddingModel::ClipVitB32,
            detection_device: curator_core::ipc::DevicePreference::Auto,
            detection_metrics_device: curator_core::ipc::DevicePreference::Cpu,
            ocr_device: curator_core::ipc::DevicePreference::Auto,
            model_precisions: std::collections::HashMap::new(),
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
        "Settings loaded: clip_device={:?}, tagger_device={:?}, detection_device={:?}, detection_metrics_device={:?}, idle_timeout={}s",
        settings.clip_device, settings.tagger_device, settings.detection_device, settings.detection_metrics_device, settings.idle_timeout_secs
    );

    let model_dir = data_dir.join("models");
    let model_manager = ModelManager::new(&model_dir, settings.clip_device.clone());
    model_manager.set_active_model(settings.embedding_model);
    model_manager.init()?;

    // Validate required models exist (models are in subdirectories under model_dir)
    let required_model_files = [
        "clip-vit-b32/vision_model.onnx",
        "clip-vit-b32/text_model.onnx",
        "clip-vit-b32/tokenizer.json",
    ];
    for model_file in &required_model_files {
        let path = model_dir.join(model_file);
        if !path.exists() {
            warn!(
                "Required model file missing: {:?}. Download models via Settings > Models.",
                path
            );
        }
    }

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

    let prefer_quantized_yolo = settings
        .model_precisions
        .get("yolo-person")
        .copied()
        .unwrap_or(curator_core::ipc::ModelPrecision::Original)
        == curator_core::ipc::ModelPrecision::Int8;

    let detection_yolo = YoloDetector::new(
        &model_dir,
        settings.detection_device.clone(),
        prefer_quantized_yolo,
    );
    let detection_ccip = CCIPModel::new(&model_dir, settings.detection_device.clone(), settings.detection_metrics_device.clone());

    let thumb_db_path = data_dir.join("thumbnail-cache.db");
    let thumbnail_cache = ThumbnailCache::open(&thumb_db_path)
        .await
        .context("Failed to open thumbnail cache")?;
    let crop_cache = curator_core::CropCache::open(&thumb_db_path)
        .await
        .context("Failed to open crop cache")?;

    let detection = Arc::new(DetectionPipeline::new(detection_yolo, detection_ccip, db.clone(), crop_cache));
    info!("Detection pipeline configured (YOLO + CCIP, models load on first use)");

    let prefer_quantized_ocr = settings
        .model_precisions
        .get("pp-ocrv6-medium")
        .copied()
        .unwrap_or(curator_core::ipc::ModelPrecision::Original)
        == curator_core::ipc::ModelPrecision::Int8;

    let prefer_quantized_bubble = settings
        .model_precisions
        .get("manga-bubble-yolo")
        .copied()
        .unwrap_or(curator_core::ipc::ModelPrecision::Original)
        == curator_core::ipc::ModelPrecision::Int8;

    let ocr = Arc::new(curator_core::OcrDetector::new(
        &model_dir,
        settings.ocr_device.clone(),
        prefer_quantized_ocr,
        prefer_quantized_bubble,
    ));
    info!("OCR detector configured (PP-OCRv6 small, models load on first use)");

    // Build the node registry with all system nodes
    let mut node_registry = curator_core::NodeRegistry::new();
    node_registry.register(model_manager.clone());
    node_registry.register(tagger.clone());
    node_registry.register(ocr.clone());
    info!("Node registry initialized with {} system nodes", node_registry.len());
    let _node_registry = Arc::new(node_registry);

    let worker = BackgroundWorker::new(db.clone(), model_manager.clone(), vector_index.clone());
    worker.start();

    let settings_arc = Arc::new(tokio::sync::Mutex::new(settings));

    {
        let mm = model_manager.clone();
        let tg = tagger.clone();
        let ocr_timeout = ocr.clone();
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
                if ocr_timeout.is_loaded() && ocr_timeout.idle_secs() >= timeout {
                    ocr_timeout.unload();
                }
            }
        });
    }

    let incoming = curator_core::ipc::grpc_helper::server_incoming()?;
    info!("gRPC Transport Server configured (Named Pipe on Windows, UDS on Unix).");

    let download_progress: handlers::models::DownloadProgressMap = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let cancel_tokens: handlers::models::CancelTokens = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    let service_impl = CuratorServiceImpl {
        ctx: Arc::new(ClientContext {
            db,
            model_manager,
            vector_index,
            tagger,
            detection,
            ocr,
            service_key: Arc::new(service_key),
            data_dir: Arc::new(data_dir),
            settings: settings_arc,
            thumbnail_cache,
            download_progress,
            cancel_tokens,
        }),
    };

    info!("Starting Tonic gRPC Service...");
    tonic::transport::Server::builder()
        .add_service(CuratorServer::new(service_impl))
        .serve_with_incoming(incoming)
        .await?;

    Ok(())
}

pub struct CuratorServiceImpl {
    ctx: Arc<ClientContext>,
}

#[tonic::async_trait]
impl Curator for CuratorServiceImpl {
    async fn call(
        &self,
        request: TonicRequest<CuratorRequest>,
    ) -> Result<TonicResponse<CuratorResponse>, Status> {
        let req_payload = request.into_inner();
        let request_str = req_payload.request_json;

        info!("Received gRPC Request: {}", request_str);

        let request_parsed: Request = match serde_json::from_str(&request_str) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = Response::Error {
                    message: format!("Failed to parse request JSON: {:?}", e),
                };
                let resp_json = serde_json::to_string(&err_resp).map_err(|e| Status::internal(e.to_string()))?;
                return Ok(TonicResponse::new(CuratorResponse { response_json: resp_json }));
            }
        };
        
        let response = handlers::handle_request(
            request_parsed,
            &self.ctx.db,
            &self.ctx.model_manager,
            &self.ctx.vector_index,
            &self.ctx.tagger,
            &self.ctx.detection,
            &self.ctx.ocr,
            &self.ctx.data_dir,
            &self.ctx.settings,
            &self.ctx.thumbnail_cache,
            &self.ctx.download_progress,
            &self.ctx.cancel_tokens,
        )
        .await;

        let response_json = serde_json::to_string(&response).map_err(|e| Status::internal(e.to_string()))?;
        info!("Sending gRPC Response: {}", response_json);
        Ok(TonicResponse::new(CuratorResponse { response_json }))
    }
}

