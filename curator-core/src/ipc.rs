pub mod grpc_helper;

use serde::{Deserialize, Serialize};

fn default_thumb_width() -> u32 {
    200
}

/// Device selection for ONNX model inference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum DevicePreference {
    /// Try GPU first, fall back to CPU if unavailable.
    #[default]
    Auto,
    /// Force CPU-only execution.
    Cpu,
    /// Force GPU execution (fails if no GPU provider available).
    Gpu,
}

/// Supported embedding models.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum EmbeddingModel {
    #[serde(rename = "clip-vit-b-32")]
    #[default]
    ClipVitB32,
    #[serde(rename = "mobileclip-s2")]
    MobileClipS2,
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
    UnblacklistTag {
        image_id: i64,
        tag: String,
    },
    Search {
        query_text: Option<String>,
        query_image_path: Option<String>,
        tag_filter: Option<String>,
        #[serde(default)]
        filename_filter: Option<String>,
        #[serde(default)]
        parse_filter: Option<String>,
        #[serde(default)]
        parse_type: Option<String>,
        #[serde(default)]
        concept_id: Option<i64>,
        #[serde(default)]
        character_identity_id: Option<i64>,
        limit: usize,
    },
    GetStatus,
    GetImage {
        image_id: i64,
    },
    ListImages {
        limit: usize,
        offset: usize,
        #[serde(default)]
        only_favorites: Option<bool>,
    },
    SetFavorite {
        image_id: i64,
        favorite: bool,
    },
    /// Get thumbnail bytes for an image (from cache or generated on demand).
    GetThumbnail {
        image_id: i64,
        #[serde(default = "default_thumb_width")]
        width: u32,
    },
    /// Purge cached thumbnails for images that no longer exist on disk.
    PurgeMissingThumbnails,
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
    RunBenchmark {
        embedding_model: EmbeddingModel,
        run_tagger: Option<bool>,
    },
    /// Run CPU vs GPU Tagger model benchmark.
    RunTaggerBenchmark,
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
        embedding_model: Option<EmbeddingModel>,
        detection_device: Option<DevicePreference>,
        detection_metrics_device: Option<DevicePreference>,
    },
    /// Reindex all vectors with the active model.
    ReindexVectors,
    /// Reindex only images that failed vectorization.
    ReindexFailedVectors,
    /// Get aggregate tag statistics: counts per tag grouped by category.
    GetTagStatistics,
    /// Get character suggestions (includes 0 count tags).
    GetCharacterSuggestions {
        query: Option<String>,
    },
    /// Batch call for dashboard init: returns status, tagger status, settings,
    /// and initial image lists all at once to minimize IPC round-trips.
    GetDashboardInit,
    /// Get all imported folders with their statistics.
    GetImportedFolders,
    /// Backfill existing images with their parent folder assignments.
    BackfillImageFolders,
    /// Update the path of an imported folder.
    UpdateFolderPath {
        id: i64,
        new_path: String,
    },
    /// Delete an imported folder record.
    DeleteFolder {
        id: i64,
    },
    /// Detect folders that share images (potential duplicates).
    DetectDuplicateFolders,
    /// Merge images from one folder into another and delete the source folder.
    MergeFolders {
        keep_folder_id: i64,
        merge_folder_id: i64,
    },
    /// Create a new custom concept from sample images.
    CreateConcept {
        name: String,
        category: String,
        threshold: f32,
        sample_image_ids: Vec<i64>,
    },
    /// List all defined custom concepts.
    ListConcepts,
    /// Update custom concept settings (threshold, category).
    UpdateConcept {
        id: i64,
        threshold: Option<f32>,
        category: Option<String>,
    },
    /// Delete a custom concept.
    DeleteConcept {
        id: i64,
    },
    /// Add support sample images to an existing custom concept.
    AddConceptSamples {
        concept_id: i64,
        image_ids: Vec<i64>,
    },
    /// Remove a sample image from a custom concept.
    RemoveConceptSample {
        concept_id: i64,
        image_id: i64,
    },
    /// Rescan existing library images against a custom concept.
    RescanConcept {
        concept_id: i64,
    },
    /// Get ground-truth sample images associated with a custom concept.
    GetConceptSamples {
        concept_id: i64,
    },
    /// Clean automatically applied concept tags from non-sample images.
    CleanAutoConceptTags {
        #[serde(default)]
        concept_id: Option<i64>,
    },
    /// Test filename parsing against a pattern or preset.
    TestFilenamePattern {
        filename: String,
        pattern_or_type: String,
        rule_type: String,
        token_config: Option<Vec<crate::filename_parser::TokenBlock>>,
    },
    /// Compile token blocks to regex string (for preview).
    CompileTokenBlocks {
        token_config: Vec<crate::filename_parser::TokenBlock>,
    },
    /// Preview batch filename parsing on library images.
    PreviewBatchFilenameParsing {
        limit: usize,
        pattern_or_type: String,
        rule_type: String,
        token_config: Option<Vec<crate::filename_parser::TokenBlock>>,
        #[serde(default)]
        output_match_type: Option<String>,
    },
    /// Run batch filename parsing and save results/tags to DB.
    RunBatchFilenameParsing {
        pattern_or_type: String,
        rule_type: String,
        token_config: Option<Vec<crate::filename_parser::TokenBlock>>,
        #[serde(default)]
        output_match_type: Option<String>,
    },

    // ── Character Detection ──────────────────────────────────────────
    /// Detect persons in a single image, extract CCIP embeddings, match identities.
    DetectCharacters {
        image_id: i64,
    },
    /// Batch detect persons across multiple images.
    DetectCharactersBatch {
        image_ids: Vec<i64>,
    },
    /// Get stored detections for an image.
    GetCharacterDetections {
        image_id: i64,
    },
    /// Get an on-the-fly crop thumbnail for a detection (webp bytes).
    GetDetectionCrop {
        detection_id: i64,
        max_size: Option<u32>,
    },
    /// Assign a detection to a character identity (or unassign if identity_id is null).
    AssignCharacterIdentity {
        detection_id: i64,
        identity_id: Option<i64>,
    },
    /// Create a new character identity with auto-incrementing name.
    CreateCharacterIdentity {
        name: Option<String>,
    },
    /// Rename a character identity.
    RenameCharacterIdentity {
        identity_id: i64,
        name: String,
    },
    /// Delete a character identity (detections become unassigned).
    DeleteCharacterIdentity {
        identity_id: i64,
    },
    /// List all character identities with detection counts.
    ListCharacterIdentities,
    /// Re-identify all detections against current identities.
    ReidentifyAllDetections,
    /// Search for all images containing a specific character identity.
    SearchByCharacter {
        identity_id: i64,
    },
    /// List all unassigned detections (identity_id IS NULL).
    ListUnassignedDetections,
    /// Delete a single detection by ID.
    DeleteDetection {
        detection_id: i64,
    },
    /// Update a detection's bounding box coordinates, clear its cache, and extract a new embedding.
    UpdateDetectionBoundingBox {
        detection_id: i64,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Run CPU vs GPU ONNX model benchmark for YOLO detector.
    RunYoloBenchmark,
    /// Run CPU vs GPU ONNX model benchmark for CCIP Feature extraction.
    RunCcipFeatBenchmark,
    /// Run CPU vs GPU ONNX model benchmark for CCIP Metrics.
    RunCcipMetricsBenchmark,
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
        #[serde(default)]
        imported_count: usize,
        #[serde(default)]
        folder_id: Option<i64>,
    },
    ThumbnailResult {
        #[serde(default)]
        data: Option<Vec<u8>>,
        is_missing: bool,
    },
    PurgeResult {
        deleted_count: i64,
    },
    SearchResult {
        matches: Vec<SearchMatch>,
    },
    StatusResult {
        image_count: i64,
        vector_count: i64,
        pending_jobs: i64,
        preprocessing_jobs: i64,
    },
    ImageResult {
        image: ImageDetails,
    },
    ListResult {
        images: Vec<ImageDetails>,
        total_count: i64,
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
        embedding_model: EmbeddingModel,
        detection_device: DevicePreference,
        detection_metrics_device: DevicePreference,
    },
    /// Results of preprocessing benchmark.
    PreprocessBenchmarkResult {
        report: String,
    },
    /// Aggregate tag statistics.
    TagStatisticsResult {
        tags: Vec<TagStat>,
    },
    /// All data needed for dashboard initialization in a single response.
    DashboardInitResult {
        image_count: i64,
        vector_count: i64,
        pending_jobs: i64,
        preprocessing_jobs: i64,
        tagger_loaded: bool,
        tagger_model_path: String,
        tagger_total_tags: usize,
        clip_device: DevicePreference,
        tagger_device: DevicePreference,
        idle_timeout_secs: u64,
        embedding_model: EmbeddingModel,
        detection_device: DevicePreference,
        detection_metrics_device: DevicePreference,
        featured_images: Vec<ImageDetails>,
        latest_images: Vec<ImageDetails>,
    },
    /// Imported folders with their statistics.
    ImportedFoldersResult {
        folders: Vec<FolderDetails>,
    },
    /// Result of backfilling image folder assignments.
    BackfillResult {
        images_backfilled: i64,
    },
    /// Result of reindexing failed vectors.
    ReindexFailedResult {
        requeued: i64,
    },
    /// Result of updating a folder path.
    UpdateFolderPathResult {
        success: bool,
    },
    /// Result of deleting a folder record.
    DeleteFolderResult {
        success: bool,
    },
    /// Detected duplicate folder groups (folders sharing images by SHA-256).
    DuplicateFoldersResult {
        groups: Vec<DuplicateFolderGroup>,
    },
    /// Result of merging two folders.
    MergeFoldersResult {
        success: bool,
        images_moved: i64,
    },
    /// List of custom concepts.
    ConceptListResult {
        concepts: Vec<crate::concept::CustomConcept>,
    },
    /// Custom concept creation/update result.
    ConceptResult {
        concept: crate::concept::CustomConcept,
    },
    /// Result of rescanning library against a custom concept.
    ConceptRescannedResult {
        concept_id: i64,
        tagged_count: usize,
    },
    /// Sample images associated with a custom concept.
    ConceptSamplesResult {
        concept_id: i64,
        samples: Vec<ImageDetails>,
    },
    /// Result of cleaning auto-concept tags from non-sample images.
    AutoConceptTagsCleanedResult {
        cleaned_count: u64,
    },
    /// Test filename pattern result.
    TestFilenamePatternResult {
        result: Option<crate::filename_parser::ParsedMetadata>,
    },
    /// Compiled regex from token blocks.
    CompileTokenBlocksResult {
        regex: String,
    },
    /// Preview batch filename parsing result.
    PreviewBatchFilenameParsingResult {
        items: Vec<crate::filename_parser::BatchPreviewItem>,
    },
    /// Batch filename parsing execution result.
    RunBatchFilenameParsingResult {
        total_processed: usize,
        matched_count: usize,
        tags_created: usize,
    },

    // ── Character Detection Results ──────────────────────────────────
    /// Result of detecting characters in a single image.
    DetectionResult {
        image_id: i64,
        detections: Vec<crate::detection::StoredDetection>,
    },
    /// Result of batch character detection.
    DetectionBatchResult {
        results: Vec<crate::detection::DetectionResult>,
    },
    /// Stored detections for an image.
    CharacterDetectionsResult {
        image_id: i64,
        detections: Vec<crate::detection::StoredDetection>,
    },
    /// On-the-fly crop thumbnail.
    DetectionCropResult {
        crop_webp_bytes: Vec<u8>,
    },
    /// List of character identities.
    CharacterIdentitiesList {
        identities: Vec<crate::detection::CharacterIdentity>,
    },
    /// Result of re-identifying all detections.
    ReidentifyResult {
        total_detections: i64,
        matched: i64,
        unmatched: i64,
    },
    /// Result of searching by character.
    CharacterSearchResult {
        image_ids: Vec<i64>,
    },
    /// List of unassigned detections.
    UnassignedDetectionsList {
        detections: Vec<crate::detection::StoredDetection>,
    },
    /// Detection model benchmark results.
    DetectionBenchmarkResult {
        yolo_cpu_time_ms: Option<f64>,
        yolo_gpu_time_ms: Option<f64>,
        yolo_gpu_error: Option<String>,
        ccip_feat_cpu_time_ms: Option<f64>,
        ccip_feat_gpu_time_ms: Option<f64>,
        ccip_feat_gpu_error: Option<String>,
        ccip_metrics_cpu_time_ms: Option<f64>,
        ccip_metrics_gpu_time_ms: Option<f64>,
        ccip_metrics_gpu_error: Option<String>,
        has_gpu: bool,
    },
}


#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TagStat {
    pub tag: String,
    pub category: String,
    pub count: i64,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDetails {
    pub id: i64,
    pub sha256: String,
    pub current_filepath: String,
    pub mtime: i64,
    pub created_at: String,
    pub tags: Vec<TagSummary>,
    #[serde(default)]
    pub blacklisted_tags: Vec<TagSummary>,
    pub vector_state: String,
    pub favorite: bool,
    #[serde(default)]
    pub parsed_metadata: Option<ParsedMetadata>,
    #[serde(default)]
    pub is_missing: bool,
}

// ParsedMetadata is defined in filename_parser and re-used here
pub use crate::filename_parser::ParsedMetadata;

/// A single predicted or user tag returned.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TagSummary {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
    #[serde(default)]
    #[sqlx(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub is_blacklisted: bool,
}

/// Folder details with statistics for the Imported Folders tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDetails {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub imported_at: String,
    pub image_count: i64,
    pub vector_ready: i64,
    pub vector_pending: i64,
    pub missing_image_count: i64,
    pub is_missing: bool,
}

/// A group of folders that share images (potential duplicates).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderGroup {
    /// The folders in this group, sorted by image count (largest first).
    pub folders: Vec<DuplicateFolderInfo>,
    /// Number of shared images between the folders in this group.
    pub shared_image_count: i64,
}

/// Info about a folder in a duplicate group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub image_count: i64,
    /// Number of images in this folder that overlap with other folders in the group.
    pub overlap_count: i64,
}
