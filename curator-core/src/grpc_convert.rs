//! Conversions between the domain DTOs (`crate::ipc`) and the prost-generated
//! protobuf structs (`crate::grpc`).
//!
//! Conversions whose source types live in child crates are implemented inside those crates:
//!   * `curator-db/src/grpc_convert.rs` — ImageDetails, TagSummary, FolderDetails, StorageStats, etc.
//!   * `curator-ml/src/grpc_convert.rs`  — detection, tagger, concept types
//!   * `curator-filename-parser/src/grpc_convert.rs` — ParsedMetadata/TokenBlock

use crate::grpc::common as commonpb;
use crate::ipc::{
    BubbleBoxResult, ConvertedFileInfo, DownloadProgress, EphemeralOcrDetection,
    ManifestFileInfo, ModelStatusInfo, OcrResult, PluginInfo, SearchMatch, TaggerBenchmarkInfo,
};

impl From<SearchMatch> for commonpb::SearchMatch {
    fn from(v: SearchMatch) -> Self {
        commonpb::SearchMatch {
            id: v.id,
            filepath: v.filepath,
            score: v.score,
            tags: v.tags.into_iter().map(Into::into).collect(),
            match_type: v.match_type,
            hamming_distance: v.hamming_distance,
            parsed_metadata: v.parsed_metadata.map(Into::into),
            ocr_text: v.ocr_text,
            character_identities: v.character_identities.into_iter().map(Into::into).collect(),
            animation: v.animation.map(Into::into),
            video: v.video.map(Into::into),
            favorite: v.favorite,
            is_missing: v.is_missing,
            safe_score: v.safe_score,
            hentai_score: v.hentai_score,
            porn_score: v.porn_score,
            sexy_score: v.sexy_score,
            drawing_score: v.drawing_score,
        }
    }
}

impl From<TaggerBenchmarkInfo> for commonpb::TaggerBenchmarkInfo {
    fn from(v: TaggerBenchmarkInfo) -> Self {
        commonpb::TaggerBenchmarkInfo {
            key: v.key,
            name: v.name,
            input_size: v.input_size,
            cpu_time_ms: v.cpu_time_ms,
            gpu_time_ms: v.gpu_time_ms,
            gpu_error: v.gpu_error,
        }
    }
}

impl From<PluginInfo> for commonpb::PluginInfo {
    fn from(v: PluginInfo) -> Self {
        commonpb::PluginInfo {
            name: v.name,
            version: v.version,
            description: v.description,
            permissions: v.permissions,
            ui: v.ui,
            hooks: v.hooks,
            loaded: v.loaded,
            enabled: v.enabled,
            manifest_path: v.manifest_path,
        }
    }
}

impl From<ConvertedFileInfo> for commonpb::ConvertedFileInfo {
    fn from(v: ConvertedFileInfo) -> Self {
        commonpb::ConvertedFileInfo {
            source_path: v.source_path,
            output_path: v.output_path,
            error: v.error,
        }
    }
}

impl From<ManifestFileInfo> for commonpb::ManifestFileInfo {
    fn from(v: ManifestFileInfo) -> Self {
        commonpb::ManifestFileInfo {
            url: v.url,
            dest: v.dest,
            sha256: v.sha256,
        }
    }
}

impl From<ModelStatusInfo> for commonpb::ModelStatusInfo {
    fn from(v: ModelStatusInfo) -> Self {
        commonpb::ModelStatusInfo {
            id: v.id,
            name: v.name,
            description: v.description,
            category: v.category,
            optional: v.optional,
            url: v.url,
            files: v.files.into_iter().map(Into::into).collect(),
            downloaded_files: v.downloaded_files,
            total_size: v.total_size,
            downloaded_size: v.downloaded_size,
            status: v.status,
            quantized_variants: v.quantized_variants,
            quantizable: v.quantizable,
            required_by: v.required_by,
        }
    }
}

impl From<DownloadProgress> for commonpb::DownloadProgress {
    fn from(v: DownloadProgress) -> Self {
        commonpb::DownloadProgress {
            model_id: v.model_id,
            status: v.status,
            files_total: v.files_total as u32,
            files_completed: v.files_completed as u32,
            bytes_total: v.bytes_total,
            bytes_downloaded: v.bytes_downloaded,
            bytes_per_second: v.bytes_per_second,
            elapsed_secs: v.elapsed_secs,
            error: v.error,
        }
    }
}

impl From<OcrResult> for commonpb::OcrResult {
    fn from(v: OcrResult) -> Self {
        commonpb::OcrResult {
            id: v.id,
            image_id: v.image_id,
            text: v.text,
            confidence: v.confidence,
            x0: v.x0,
            y0: v.y0,
            x1: v.x1,
            y1: v.y1,
            x2: v.x2,
            y2: v.y2,
            x3: v.x3,
            y3: v.y3,
            is_from_bubble: v.is_from_bubble,
        }
    }
}


impl From<BubbleBoxResult> for commonpb::BubbleBoxResult {
    fn from(v: BubbleBoxResult) -> Self {
        commonpb::BubbleBoxResult {
            x1: v.x1,
            y1: v.y1,
            x2: v.x2,
            y2: v.y2,
            confidence: v.confidence,
        }
    }
}

impl From<EphemeralOcrDetection> for commonpb::EphemeralOcrDetection {
    fn from(v: EphemeralOcrDetection) -> Self {
        commonpb::EphemeralOcrDetection {
            text: v.text,
            confidence: v.confidence,
            x0: v.x0,
            y0: v.y0,
            x1: v.x1,
            y1: v.y1,
            x2: v.x2,
            y2: v.y2,
            x3: v.x3,
            y3: v.y3,
            is_from_bubble: v.is_from_bubble,
        }
    }
}