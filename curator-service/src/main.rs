use anyhow::{Context, Error};
use clap::Parser;
use curator_core::constants::resolve_data_dir;
use curator_core::db::init_db;
use curator_core::detection::{CCIPModel, DetectionPipeline, YoloDetector};
use curator_core::ipc::TaggerModel;
use curator_core::tagger::TaggerManager;
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
use curator_core::grpc::{
    benchmarks::benchmarks_service_server::BenchmarksServiceServer,
    characters::characters_service_server::CharactersServiceServer,
    concepts::concepts_service_server::ConceptsServiceServer,
    folders::folders_service_server::FoldersServiceServer,
    gallery::gallery_service_server::GalleryServiceServer,
    import::import_service_server::ImportServiceServer,
    models::models_service_server::ModelsServiceServer,
    ocr::ocr_service_server::OcrServiceServer,
    parser::filename_parser_service_server::FilenameParserServiceServer,
    plugins::plugins_service_server::PluginsServiceServer,
    search::search_service_server::SearchServiceServer,
    system::system_service_server::SystemServiceServer,
    tagging::tagging_service_server::TaggingServiceServer,
    tags::tags_service_server::TagsServiceServer,
    tools::tools_service_server::ToolsServiceServer,
};



mod auth;
mod handlers;
mod server;
mod worker;

use auth::load_or_create_service_key;
use worker::BackgroundWorker;

struct ClientContext {
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
    taggers: Arc<TaggerManager>,
    detection: Arc<DetectionPipeline>,
    ocr: Arc<curator_core::OcrDetector>,
    data_dir: Arc<PathBuf>,
    settings: Arc<tokio::sync::Mutex<AppSettings>>,
    thumbnail_cache: Arc<ThumbnailCache>,
    download_progress: handlers::models::DownloadProgressMap,
    cancel_tokens: handlers::models::CancelTokens,
    benchmark_progress: handlers::BenchmarkProgressMap,
    transcode_progress: curator_core::transcode::TranscodeProgressMap,
    plugin_runtime_progress: handlers::plugin_runtime::PluginRuntimeProgressMap,

    /// Generic download-job state, engine registry, and per-job cancel handles
    /// (aria2 now; future yt-dlp is additive). Plugins drive downloads through
    /// the generic `DownloadStart` / `DownloadProgress` / `DownloadCancel`.
    download_jobs: handlers::download::DownloadJobsMap,
    download_cancels: handlers::download::DownloadCancelMap,
    download_path_claims: handlers::download::DownloadPathClaims,
    engines: handlers::download::EngineRegistry,
    /// Generic tool install progress (aria2 portable binary, future tools).
    tool_install_progress: handlers::tools::ToolInstallProgressMap,
    /// Service-side safety classifier and its coalescing import batch queue.
    safety: handlers::safety::SafetyService,
    import_controller: handlers::import::ImportController,
    import_lock: tokio::sync::Mutex<()>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AppSettings {
    clip_device: curator_core::ipc::DevicePreference,
    tagger_device: curator_core::ipc::DevicePreference,
    #[serde(default)]
    tagger_wd_device: curator_core::ipc::DevicePreference,
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
    /// Preferred tagger whose tags are surfaced in the UI.
    #[serde(default)]
    preferred_tagger: TaggerModel,
    /// Enable/disable state of discovered plugins, keyed by plugin name.
    #[serde(default)]
    enabled_plugins: std::collections::HashMap<String, bool>,
    /// Explicit FFmpeg executable path, if the user configured one.
    #[serde(default)]
    ffmpeg_path: Option<String>,
    /// Explicit executable paths for auxiliary tools, keyed by tool id
    /// (`"ffmpeg"`, `"aria2"`, …), written via the generic `SetToolPath`.
    #[serde(default)]
    tool_paths: std::collections::HashMap<String, Option<String>>,
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
            tagger_wd_device: curator_core::ipc::DevicePreference::Auto,
            idle_timeout_secs: default_idle_timeout(),
            embedding_model: curator_core::ipc::EmbeddingModel::ClipVitB32,
            detection_device: curator_core::ipc::DevicePreference::Auto,
            detection_metrics_device: curator_core::ipc::DevicePreference::Cpu,
            ocr_device: curator_core::ipc::DevicePreference::Auto,
            model_precisions: std::collections::HashMap::new(),
            preferred_tagger: TaggerModel::Camie,
            enabled_plugins: std::collections::HashMap::new(),
            ffmpeg_path: None,
            tool_paths: std::collections::HashMap::new(),
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
    /// Path to the curator data directory. Defaults to `.curator` in the workspace root.
    #[arg(short, long)]
    data_dir: Option<String>,

    #[arg(long)]
    tagger_model_dir: Option<String>,
}



#[tokio::main]
async fn main() -> Result<(), Error> {
    let args = Args::parse();
    let data_dir = match &args.data_dir {
        Some(p) => PathBuf::from(p),
        None => resolve_data_dir(),
    };
    fs::create_dir_all(&data_dir)?;

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("curator.log"))
        .context("Failed to open log file")?;

    struct LocalTimer;

    impl tracing_subscriber::fmt::time::FormatTime for LocalTimer {
        fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> std::fmt::Result {
            write!(w, "{}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"))
        }
    }

    let file_layer = tracing_subscriber::fmt::layer()
        .with_timer(LocalTimer)
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false);

    let console_layer = tracing_subscriber::fmt::layer().with_timer(LocalTimer);

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(console_layer)
        .with(file_layer)
        .init();

    info!("Starting Project Curator Service...");

    let _service_key = load_or_create_service_key(&data_dir)?;
    info!("Service Key authenticated successfully.");

    let db_path = data_dir.join("curator.db");
    let db = init_db(&db_path).await?;

    // Seed the built-in tag sources; each row is idempotent.
    for (name, source_type) in [
        (curator_core::constants::SOURCE_CLIP, "AI_MODEL"),
        (curator_core::constants::SOURCE_CAMIE, "AI_MODEL"),
        (curator_core::constants::SOURCE_WD_EVA02, "AI_MODEL"),
        (curator_core::constants::SOURCE_MOBILECLIP, "AI_MODEL"),
        (curator_core::constants::SOURCE_USER, "USER"),
        (curator_core::constants::SOURCE_CUSTOM_CONCEPTS, "AI_MODEL"),
    ] {
        sqlx::query(
            "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES (?, ?, '{}')",
        )
        .bind(name)
        .bind(source_type)
        .execute(&db)
        .await?;
    }

    let _ = handlers::concepts::sync_all_custom_concept_tags(&db).await;

    let settings = load_settings(&data_dir);
    info!(
        "Settings loaded: clip_device={:?}, tagger_device={:?}, tagger_wd_device={:?}, detection_device={:?}, detection_metrics_device={:?}, idle_timeout={}s",
        settings.clip_device, settings.tagger_device, settings.tagger_wd_device, settings.detection_device, settings.detection_metrics_device, settings.idle_timeout_secs
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
    let taggers = Arc::new(TaggerManager::new(
        &tagger_dir,
        settings.tagger_device.clone(),
        settings.tagger_wd_device.clone(),
    ));
    info!(
        "Tagger engines configured at {:?} with devices: camie={:?}, wd={:?} (models load on first use)",
        tagger_dir, settings.tagger_device, settings.tagger_wd_device
    );
    info!(
        "Preferred tagger: {:?}",
        settings.preferred_tagger
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
    info!("OCR detector configured (PP-OCRv6 medium, models load on first use)");

    let data_dir_arc = Arc::new(data_dir);
    let safety = Arc::new(handlers::safety::SafetyService::new((*data_dir_arc).clone()));

    let worker = BackgroundWorker::new(db.clone(), model_manager.clone(), vector_index.clone(), safety.clone());
    worker.start();


    let settings_arc = Arc::new(tokio::sync::Mutex::new(settings));

    {
        let mm = model_manager.clone();
        let tgs = taggers.clone();
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
                for tg in tgs.all() {
                    if tg.is_loaded() && tg.idle_secs() >= timeout {
                        tg.unload();
                    }
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
    let benchmark_progress: handlers::BenchmarkProgressMap = Arc::new(tokio::sync::Mutex::new(None));
    let transcode_progress: curator_core::transcode::TranscodeProgressMap =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let plugin_runtime_progress: handlers::plugin_runtime::PluginRuntimeProgressMap =

        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    let download_jobs: handlers::download::DownloadJobsMap =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let download_cancels: handlers::download::DownloadCancelMap =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let download_path_claims: handlers::download::DownloadPathClaims =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let engines: handlers::download::EngineRegistry = Arc::new(
        std::collections::HashMap::from([(
            "aria2",
            Arc::new(handlers::download::aria2::Aria2Engine) as Arc<dyn handlers::download::DownloadEngine>,
        )]),
    );
    let tool_install_progress: handlers::tools::ToolInstallProgressMap =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    let ctx = Arc::new(ClientContext {
        db,
        model_manager,
        vector_index,
        taggers,
        detection,
        ocr,
        data_dir: data_dir_arc,
        settings: settings_arc,
        thumbnail_cache,
        download_progress,
        cancel_tokens,
        benchmark_progress,
        transcode_progress,
        plugin_runtime_progress,
        download_jobs,
        download_cancels,
        download_path_claims,
        engines,
        tool_install_progress,
        safety: (*safety).clone(),
        import_controller: handlers::import::ImportController::new(),
        import_lock: tokio::sync::Mutex::new(()),
    });



    info!("Starting Tonic gRPC Service...");
    let server = tonic::transport::Server::builder()
        .add_service(SystemServiceServer::new(server::system::SystemServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(ImportServiceServer::new(server::import::ImportServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(GalleryServiceServer::new(server::gallery::GalleryServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(SearchServiceServer::new(server::search::SearchServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(TagsServiceServer::new(server::tags::TagsServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(TaggingServiceServer::new(
            server::tagging::TaggingServiceImpl::new(ctx.clone()),
        ))
        .add_service(CharactersServiceServer::new(
            server::characters::CharactersServiceImpl::new(ctx.clone()),
        ))
        .add_service(OcrServiceServer::new(server::ocr::OcrServiceImpl::new(ctx.clone())))
        .add_service(ConceptsServiceServer::new(
            server::concepts::ConceptsServiceImpl::new(ctx.clone()),
        ))
        .add_service(ModelsServiceServer::new(
            server::models::ModelsServiceImpl::new(ctx.clone()),
        ))
        .add_service(ToolsServiceServer::new(server::tools::ToolsServiceImpl::new(
            ctx.clone(),
        )))
        .add_service(FoldersServiceServer::new(
            server::folders::FoldersServiceImpl::new(ctx.clone()),
        ))
        .add_service(BenchmarksServiceServer::new(
            server::benchmarks::BenchmarksServiceImpl::new(ctx.clone()),
        ))
        .add_service(PluginsServiceServer::new(
            server::plugins::PluginsServiceImpl::new(ctx.clone()),
        ))
        .add_service(FilenameParserServiceServer::new(
            server::parser::FilenameParserServiceImpl::new(ctx.clone()),
        ))
        .serve_with_incoming(incoming);
    server.await?;

    Ok(())
}

