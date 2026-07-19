use serde::{Deserialize, Serialize};

/// Device selection for ONNX model inference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DevicePreference {
    /// Try GPU first, fall back to CPU if unavailable.
    Auto,
    /// Force CPU-only execution.
    Cpu,
    /// Force GPU execution (fails if no GPU provider available).
    Gpu,
}

impl Default for DevicePreference {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Request {
    Ping,
    ImportImage {
        path: String,
    },
    AddTag {
        image_id: i64,
        tag: String,
        category: String,
    },
    RemoveTag {
        image_id: i64,
        tag: String,
    },
    Search {
        query_text: Option<String>,
        query_image_path: Option<String>,
        tag_filter: Option<String>,
        limit: usize,
    },
    GetStatus,
    GetImage {
        image_id: i64,
    },
    ListImages {
        limit: usize,
        offset: usize,
    },
    ValidatePlugin {
        manifest_path: String,
    },
    /// Run Camie Tagger v2 on a single image (on-demand, lazy-loads model).
    TagImage {
        image_id: i64,
        /// Confidence threshold. None uses the balanced default (0.50).
        threshold: Option<f32>,
        /// If true, wipes existing Camie tags before tagging again.
        force: Option<bool>,
    },
    /// Run Camie Tagger v2 on a batch of image IDs.
    TagImageBatch {
        image_ids: Vec<i64>,
        threshold: Option<f32>,
        /// If true, wipes existing Camie tags before tagging again.
        force: Option<bool>,
    },
    /// Query whether the Camie Tagger model is currently loaded.
    GetTaggerStatus,
    /// Run CPU vs GPU ONNX model benchmark.
    RunBenchmark,
    /// Benchmark image preprocessing (decode + resize + normalize) across methods.
    BenchmarkPreprocess {
        image_path: String,
    },
    /// Get current settings (device preferences, etc.).
    GetSettings,
    /// Update settings. Partial update — only provided fields are changed.
    UpdateSettings {
        clip_device: Option<DevicePreference>,
        tagger_device: Option<DevicePreference>,
        idle_timeout_secs: Option<u64>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Response {
    Pong,
    Success,
    Error {
        message: String,
    },
    BenchmarkResult {
        clip_cpu_time_ms: f64,
        clip_gpu_time_ms: Option<f64>,
        clip_gpu_error: Option<String>,
        tagger_cpu_time_ms: Option<f64>,
        tagger_gpu_time_ms: Option<f64>,
        tagger_gpu_error: Option<String>,
        has_gpu: bool,
    },
    ImportResult {
        image_id: i64,
        sha256: String,
    },
    SearchResult {
        matches: Vec<SearchMatch>,
    },
    StatusResult {
        image_count: i64,
        vector_count: i64,
        pending_jobs: i64,
    },
    ImageResult {
        image: ImageDetails,
    },
    ListResult {
        images: Vec<ImageDetails>,
    },
    ValidationResult {
        name: String,
        version: String,
        valid: bool,
        error: Option<String>,
    },
    /// Result of a single-image auto-tag operation.
    TagImageResult {
        image_id: i64,
        tags_applied: usize,
        /// True when the image already had Camie tags and was not re-tagged.
        skipped: bool,
        tags: Vec<TagSummary>,
    },
    /// Result of a batch auto-tag operation.
    BatchTagResult {
        processed: usize,
        failed: usize,
        skipped: usize,
    },
    /// Current state of the Camie Tagger engine.
    TaggerStatusResult {
        loaded: bool,
        model_path: String,
        total_tags: usize,
    },
    /// Current application settings.
    SettingsResult {
        clip_device: DevicePreference,
        tagger_device: DevicePreference,
        idle_timeout_secs: u64,
    },
    /// Results of preprocessing benchmark.
    PreprocessBenchmarkResult {
        report: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub id: i64,
    pub filepath: String,
    pub score: f32,
    pub tags: Vec<TagSummary>,
    pub match_type: String,
    pub hamming_distance: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDetails {
    pub id: i64,
    pub sha256: String,
    pub current_filepath: String,
    pub mtime: i64,
    pub created_at: String,
    pub tags: Vec<TagSummary>,
    pub vector_state: String,
}

/// A single predicted or user tag returned.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TagSummary {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
}
