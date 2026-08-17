//! gRPC conversions for models defined in `curator-db`.

use crate::models::{
    AnimationSummary, CharacterIdentitySummary, DuplicateFolderGroup, DuplicateFolderInfo,
    FolderDetails, ImageDetails, StorageStats, StorageTypeStat, TagStat, TagSummary, VideoSummary,
};
use curator_proto::grpc::common as commonpb;

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
            safe_score: v.safe_score,
            hentai_score: v.hentai_score,
            porn_score: v.porn_score,
            sexy_score: v.sexy_score,
            drawing_score: v.drawing_score,
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
            safety_classified: v.safety_classified,
            safety_pending: v.safety_pending,
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
