//! Conversions between the domain types (`crate::ipc`, `crate::detection`, ...) and the
//! prost-generated protobuf structs (`crate::grpc`).
//!
//! These `From` impls must live in `curator-core` because the orphan rule requires at least one
//! of the impl'd types to be local to the crate. Both the domain DTOs and the generated protobuf
//! structs are defined here, so converting between them is a local trait impl.

use crate::concept::CustomConcept;
use crate::detection::{
    CharacterIdentity, CharacterSearchEntry, DetectionCropEntry, DetectionResult, ReidentifyResult,
    StoredDetection,
};
use crate::filename_parser::{BatchPreviewItem, ParsedMetadata, TokenBlock};
use crate::grpc::common as commonpb;
use crate::ipc::{
    AnimationSummary, BubbleBoxResult, CharacterIdentitySummary, ConvertedFileInfo,
    DownloadProgress, DuplicateFolderGroup, DuplicateFolderInfo, EphemeralOcrDetection, FolderDetails,
    ImageDetails, ManifestFileInfo, ModelStatusInfo, OcrResult, PluginInfo, SearchMatch, StorageStats,
    StorageTypeStat, TaggerBenchmarkInfo, TagStat, TagSummary, VideoSummary,
};
use crate::tagger::TaggerStatusInfo;

impl From<TagSummary> for commonpb::TagSummary {
    fn from(v: TagSummary) -> Self {
        commonpb::TagSummary {
            tag: v.tag,
            category: v.category,
            confidence: v.confidence,
            source_name: v.source_name,
            is_blacklisted: v.is_blacklisted,
        }
    }
}

impl From<ParsedMetadata> for commonpb::ParsedMetadata {
    fn from(v: ParsedMetadata) -> Self {
        commonpb::ParsedMetadata {
            match_type: v.match_type,
            raw_matched: v.raw_matched,
            artist: v.artist,
            pixiv_id: v.pixiv_id,
            twitter_id: v.twitter_id,
            timestamp_4chan: v.timestamp_4chan,
            datetime_iso: v.datetime_iso,
            extracted_tags: v.extracted_tags,
            partial: v.partial,
        }
    }
}

impl From<commonpb::TokenBlock> for TokenBlock {
    fn from(v: commonpb::TokenBlock) -> Self {
        TokenBlock {
            token_type: v.token_type,
            value: v.value,
            label: v.label,
            enabled: v.enabled,
            optional_prefix: v.optional_prefix,
        }
    }
}

impl From<TokenBlock> for commonpb::TokenBlock {
    fn from(v: TokenBlock) -> Self {
        commonpb::TokenBlock {
            token_type: v.token_type,
            value: v.value,
            label: v.label,
            enabled: v.enabled,
            optional_prefix: v.optional_prefix,
        }
    }
}

impl From<BatchPreviewItem> for commonpb::BatchPreviewItem {
    fn from(v: BatchPreviewItem) -> Self {
        commonpb::BatchPreviewItem {
            image_id: v.image_id,
            filename: v.filename,
            filepath: v.filepath,
            match_result: v.match_result.map(Into::into),
        }
    }
}

impl From<CharacterIdentitySummary> for commonpb::CharacterIdentitySummary {
    fn from(v: CharacterIdentitySummary) -> Self {
        commonpb::CharacterIdentitySummary {
            id: v.id,
            name: v.name,
        }
    }
}

impl From<AnimationSummary> for commonpb::AnimationSummary {
    fn from(v: AnimationSummary) -> Self {
        commonpb::AnimationSummary {
            format: v.format,
            frame_count: v.frame_count,
            duration_ms: v.duration_ms,
            loop_count: v.loop_count,
            is_animated: v.is_animated,
        }
    }
}

impl From<VideoSummary> for commonpb::VideoSummary {
    fn from(v: VideoSummary) -> Self {
        commonpb::VideoSummary {
            format: v.format,
            duration_ms: v.duration_ms,
            fps: v.fps,
            video_codec: v.video_codec,
            audio_codec: v.audio_codec,
            bitrate: v.bitrate,
            width: v.width,
            height: v.height,
        }
    }
}

impl From<ImageDetails> for commonpb::ImageDetails {
    fn from(v: ImageDetails) -> Self {
        commonpb::ImageDetails {
            id: v.id,
            sha256: v.sha256,
            current_filepath: v.current_filepath,
            mtime: v.mtime,
            created_at: v.created_at,
            tags: v.tags.into_iter().map(Into::into).collect(),
            blacklisted_tags: v.blacklisted_tags.into_iter().map(Into::into).collect(),
            vector_state: v.vector_state,
            favorite: v.favorite,
            parsed_metadata: v.parsed_metadata.map(Into::into),
            is_missing: v.is_missing,
            character_identities: v.character_identities.into_iter().map(Into::into).collect(),
            ocr_text: v.ocr_text,
            width: v.width,
            height: v.height,
            animation: v.animation.map(Into::into),
            video: v.video.map(Into::into),
            note: v.note,
        }
    }
}

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
        }
    }
}

impl From<TaggerStatusInfo> for commonpb::TaggerStatusInfo {
    fn from(v: TaggerStatusInfo) -> Self {
        commonpb::TaggerStatusInfo {
            key: v.key,
            name: v.name,
            source_name: v.source_name,
            loaded: v.loaded,
            model_path: v.model_path,
            total_tags: v.total_tags as u32,
            default_threshold: v.default_threshold,
            input_size: v.input_size,
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

impl From<StorageTypeStat> for commonpb::StorageTypeStat {
    fn from(v: StorageTypeStat) -> Self {
        commonpb::StorageTypeStat {
            category: v.category,
            extension: v.extension,
            size_bytes: v.size_bytes,
            count: v.count,
        }
    }
}

impl From<StorageStats> for commonpb::StorageStats {
    fn from(v: StorageStats) -> Self {
        commonpb::StorageStats {
            stats: v.stats.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TagStat> for commonpb::TagStat {
    fn from(v: TagStat) -> Self {
        commonpb::TagStat {
            tag: v.tag,
            category: v.category,
            count: v.count,
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

impl From<FolderDetails> for commonpb::FolderDetails {
    fn from(v: FolderDetails) -> Self {
        commonpb::FolderDetails {
            id: v.id,
            path: v.path,
            name: v.name,
            imported_at: v.imported_at,
            image_count: v.image_count,
            video_count: v.video_count,
            vector_ready: v.vector_ready,
            vector_pending: v.vector_pending,
            missing_image_count: v.missing_image_count,
            missing_video_count: v.missing_video_count,
            is_missing: v.is_missing,
        }
    }
}

impl From<DuplicateFolderInfo> for commonpb::DuplicateFolderInfo {
    fn from(v: DuplicateFolderInfo) -> Self {
        commonpb::DuplicateFolderInfo {
            id: v.id,
            path: v.path,
            name: v.name,
            image_count: v.image_count,
            overlap_count: v.overlap_count,
        }
    }
}

impl From<DuplicateFolderGroup> for commonpb::DuplicateFolderGroup {
    fn from(v: DuplicateFolderGroup) -> Self {
        commonpb::DuplicateFolderGroup {
            folders: v.folders.into_iter().map(Into::into).collect(),
            shared_image_count: v.shared_image_count,
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

impl From<CustomConcept> for commonpb::CustomConcept {
    fn from(v: CustomConcept) -> Self {
        commonpb::CustomConcept {
            id: v.id,
            name: v.name,
            category: v.category,
            threshold: v.threshold,
            sample_count: v.sample_count as u32,
            created_at: v.created_at,
            updated_at: v.updated_at,
        }
    }
}

impl From<StoredDetection> for commonpb::StoredDetection {
    fn from(v: StoredDetection) -> Self {
        commonpb::StoredDetection {
            id: v.id,
            image_id: v.image_id,
            x0: v.x0,
            y0: v.y0,
            x1: v.x1,
            y1: v.y1,
            confidence: v.confidence,
            has_embedding: v.has_embedding,
            identity_id: v.identity_id,
        }
    }
}

impl From<DetectionResult> for commonpb::DetectionResult {
    fn from(v: DetectionResult) -> Self {
        commonpb::DetectionResult {
            image_id: v.image_id,
            detections: v.detections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<DetectionCropEntry> for commonpb::DetectionCropEntry {
    fn from(v: DetectionCropEntry) -> Self {
        commonpb::DetectionCropEntry {
            detection_id: v.detection_id,
            crop_webp_bytes: v.crop_webp_bytes,
        }
    }
}

impl From<CharacterSearchEntry> for commonpb::CharacterSearchEntry {
    fn from(v: CharacterSearchEntry) -> Self {
        commonpb::CharacterSearchEntry {
            identity_id: v.identity_id,
            image_ids: v.image_ids,
        }
    }
}

impl From<CharacterIdentity> for commonpb::CharacterIdentity {
    fn from(v: CharacterIdentity) -> Self {
        commonpb::CharacterIdentity {
            id: v.id,
            name: v.name,
            detection_count: v.detection_count,
            created_at: v.created_at,
        }
    }
}

impl From<ReidentifyResult> for commonpb::ReidentifyResult {
    fn from(v: ReidentifyResult) -> Self {
        commonpb::ReidentifyResult {
            total_detections: v.total_detections,
            matched: v.matched,
            unmatched: v.unmatched,
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
