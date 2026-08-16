// Shared kernel contracts live in `curator-proto` (leaf crate) and are
// re-exported here so `curator_core::ipc::DevicePreference` (and friends)
// keep resolving for all downstream consumers.
pub use curator_proto::contracts::{DevicePreference, EmbeddingModel, ModelPrecision, TaggerModel};

// Named-Pipe / UDS transport moved to `curator-proto::ipc`; re-export the
// module under its historical name so `curator_core::ipc::grpc_helper::*`
// continues to work.
pub mod grpc_helper {
    pub use curator_proto::ipc::*;
}

use serde::{Deserialize, Serialize};

/// Per-tagger CPU/GPU inference benchmark result. The benchmark runs every
/// configured tagger so the user can compare both models in one pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaggerBenchmarkInfo {
    pub key: String,
    pub name: String,
    pub input_size: u32,
    pub cpu_time_ms: Option<f64>,
    pub gpu_time_ms: Option<f64>,
    pub gpu_error: Option<String>,
}

pub use curator_filename_parser::ParsedMetadata;

// Canonical models from curator_db
pub use curator_db::models::{
    AnimationSummary, CharacterIdentitySummary, DuplicateFolderGroup, DuplicateFolderInfo,
    FolderDetails, ImageDetails, StorageStats, StorageTypeStat, TagStat, TagSummary, VideoSummary,
};


/// Metadata describing a discovered plugin (parsed from `manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<String>,
    /// `components.ui` relative path, when present.
    pub ui: Option<String>,
    pub hooks: Vec<String>,
    /// True when the manifest parsed successfully.
    pub loaded: bool,
    /// From `AppSettings.enabled_plugins`, default `true` when absent.
    pub enabled: bool,
    /// Absolute path to the plugin's `manifest.json` (for `ValidatePlugin`).
    pub manifest_path: String,
}

/// Per-file result of an ephemeral conversion. `error` is set when that item
/// failed; the batch continues for the remaining files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertedFileInfo {
    pub source_path: String,
    pub output_path: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub id: i64,
    pub filepath: String,
    pub score: f32,
    pub tags: Vec<TagSummary>,
    pub match_type: String,
    pub hamming_distance: Option<u32>,
    #[serde(default)]
    pub parsed_metadata: Option<ParsedMetadata>,
    #[serde(default)]
    pub ocr_text: Option<String>,
    #[serde(default)]
    pub character_identities: Vec<CharacterIdentitySummary>,
    #[serde(default)]
    pub animation: Option<AnimationSummary>,
    #[serde(default)]
    pub video: Option<VideoSummary>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub is_missing: bool,
    /// NSFW safety per-class probabilities (optional; `None` = unclassified).
    #[serde(default)]
    pub safe_score: Option<f32>,
    #[serde(default)]
    pub hentai_score: Option<f32>,
    #[serde(default)]
    pub porn_score: Option<f32>,
    #[serde(default)]
    pub sexy_score: Option<f32>,
    #[serde(default)]
    pub drawing_score: Option<f32>,
}


/// Stored OCR detection representation.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OcrResult {
    pub id: i64,
    pub image_id: i64,
    pub text: String,
    pub confidence: f32,
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
    pub x3: i32,
    pub y3: i32,
    pub is_from_bubble: bool,
}

/// YOLO bubble detection bounding box for overlay display.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BubbleBoxResult {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub confidence: f32,
}

/// Ephemeral OCR detection (no DB id/image_id) returned by the Toolbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EphemeralOcrDetection {
    pub text: String,
    pub confidence: f32,
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
    pub x3: i32,
    pub y3: i32,
    pub is_from_bubble: bool,
}

// ── Model Management Types ─────────────────────────────────────────

/// A single file in a model manifest entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFileInfo {
    pub url: String,
    pub dest: String,
    pub sha256: String,
}

/// Status of a single model from the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatusInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub optional: bool,
    pub url: String,
    pub files: Vec<ManifestFileInfo>,
    /// Relative paths of files that exist on disk.
    pub downloaded_files: Vec<String>,
    /// Total bytes of all files.
    pub total_size: u64,
    /// Bytes already on disk.
    pub downloaded_size: u64,
    /// "downloaded" | "partial" | "not_downloaded"
    pub status: String,
    /// Quantized variants present on disk (e.g. ["fp16", "int8"]).
    pub quantized_variants: Vec<String>,
    pub quantizable: Vec<String>,
    pub required_by: Vec<String>,
}

/// Progress of an active download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub model_id: String,
    /// "downloading" | "quantizing" | "completed" | "failed" | "cancelled"
    pub status: String,
    pub files_total: usize,
    pub files_completed: usize,
    pub bytes_total: u64,
    pub bytes_downloaded: u64,
    /// Rolling average download speed (bytes/sec).
    pub bytes_per_second: u64,
    /// Total elapsed time in seconds.
    pub elapsed_secs: f64,
    pub error: Option<String>,
}

