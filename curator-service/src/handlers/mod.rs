pub mod benchmarks;
pub mod common;
pub mod concepts;
pub mod convert;
pub mod dashboard;
pub mod download;
pub mod ffmpeg;
pub mod image;
pub mod import;
pub mod misc;
pub mod models;
pub mod ocr;
pub mod plugin_db;
pub mod plugins;
pub mod plugin_runtime;
pub mod safety;
pub mod search;
pub mod settings;
pub mod tags;
pub mod tagging;
pub mod tools;
pub mod transcode;
pub mod gif;

use std::path::Path;
use std::sync::Arc;

use crate::AppSettings;

/// Shared live state for a background image-processing benchmark running
/// cross many images. `None` means no benchmark is currently running.
#[derive(Clone, Default)]
pub(crate) struct ImageProcessingBenchmarkProgress {
    pub running: bool,
    pub processed: usize,
    pub total: usize,
    pub read_time_ms: f64,
    pub decode_time_ms: f64,
    pub thumbnail_time_ms: f64,
    pub clip_preprocess_time_ms: f64,
    pub tagger_preprocess_time_ms: f64,
    pub yolo_preprocess_time_ms: f64,
    pub ccip_extract_preprocess_time_ms: f64,
    pub ocr_det_preprocess_time_ms: f64,
    pub ocr_rec_preprocess_time_ms: f64,
}

pub(crate) type BenchmarkProgressMap =
    Arc<tokio::sync::Mutex<Option<ImageProcessingBenchmarkProgress>>>;

/// Resolve the FFmpeg executable honoring the persisted explicit path. Returns
/// `Ok(path)` when found; callers decide whether missing FFmpeg is an error
/// (import/transcode) or reported status (Settings UI).
pub(crate) async fn resolve_ffmpeg_path(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> anyhow::Result<std::path::PathBuf> {
    let explicit = { settings.lock().await.ffmpeg_path.clone() };
    curator_core::video::resolve_ffmpeg_path(data_dir, explicit.as_deref().map(Path::new))
}

pub(crate) fn resolve_relative_path(data_dir: &Path, path_str: &str) -> String {
    let path = Path::new(path_str);
    if path.is_relative() {
        if let Ok(stripped) = path.strip_prefix(".curator") {
            return data_dir.join(stripped).to_string_lossy().to_string();
        }
        if let Some(parent) = data_dir.parent() {
            return parent.join(path).to_string_lossy().to_string();
        }
    }
    path_str.to_string()
}
