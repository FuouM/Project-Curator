import type {
  AnimationSummary as PAnimationSummary,
  BatchPreviewItem as PBatchPreviewItem,
  CharacterIdentitySummary as PCharacterIdentitySummary,
  DuplicateFolderInfo as PDuplicateFolderInfo,
  FolderDetails as PFolderDetails,
  ImageDetails as PImageDetails,
  ParsedMetadata as PParsedMetadata,
  PluginInfo as PPluginInfo,
  SearchMatch as PSearchMatch,
  TagStat as PTagStat,
  TagSummary as PTagSummary,
  TaggerStatusInfo as PTaggerStatusInfo,
  VideoSummary as PVideoSummary,
} from "./gen/common_pb";
import type {
  AnimationSummary,
  BatchPreviewItem,
  CharacterIdentitySummary,
  DuplicateFolderInfo,
  FolderDetails,
  ImageDetails,
  ParsedMetadata,
  PluginInfo,
  SearchMatch,
  TagStat,
  TagSummary,
  TaggerStatusInfo,
  VideoSummary,
} from "./types";

const n = (v: bigint | undefined | null): number => (v === undefined || v === null ? 0 : Number(v));

export function tagSummaryFromProto(p: PTagSummary): TagSummary {
  return {
    tag: p.tag,
    category: p.category,
    confidence: p.confidence,
    source_name: p.sourceName,
    is_blacklisted: p.isBlacklisted,
  };
}

export function parsedMetadataFromProto(p: PParsedMetadata): ParsedMetadata {
  return {
    match_type: p.matchType,
    raw_matched: p.rawMatched,
    artist: p.artist,
    pixiv_id: p.pixivId,
    twitter_id: p.twitterId,
    timestamp_4chan: p.timestamp4chan,
    datetime_iso: p.datetimeIso,
    extracted_tags: p.extractedTags,
    partial: p.partial,
  };
}

export function characterIdentitySummaryFromProto(p: PCharacterIdentitySummary): CharacterIdentitySummary {
  return {
    id: n(p.id),
    name: p.name,
  };
}

export function animationSummaryFromProto(p: PAnimationSummary): AnimationSummary {
  return {
    format: p.format,
    frame_count: n(p.frameCount),
    duration_ms: n(p.durationMs),
    loop_count: p.loopCount === undefined ? null : n(p.loopCount),
    is_animated: p.isAnimated,
  };
}

export function videoSummaryFromProto(p: PVideoSummary): VideoSummary {
  return {
    format: p.format,
    duration_ms: n(p.durationMs),
    fps: p.fps,
    video_codec: p.videoCodec,
    audio_codec: p.audioCodec ?? null,
    bitrate: p.bitrate === undefined ? null : n(p.bitrate),
    width: p.width === undefined ? null : n(p.width),
    height: p.height === undefined ? null : n(p.height),
  };
}

export function imageDetailsFromProto(p: PImageDetails): ImageDetails {
  return {
    id: n(p.id),
    sha256: p.sha256,
    current_filepath: p.currentFilepath,
    mtime: n(p.mtime),
    created_at: p.createdAt,
    tags: p.tags.map(tagSummaryFromProto),
    vector_state: p.vectorState,
    favorite: p.favorite,
    parsed_metadata: p.parsedMetadata ? parsedMetadataFromProto(p.parsedMetadata) : undefined,
    is_missing: p.isMissing,
    character_identities: p.characterIdentities.map(characterIdentitySummaryFromProto),
    ocr_text: p.ocrText,
    width: p.width === undefined ? null : n(p.width),
    height: p.height === undefined ? null : n(p.height),
    animation: p.animation ? animationSummaryFromProto(p.animation) : null,
    video: p.video ? videoSummaryFromProto(p.video) : null,
    note: p.note ?? null,
  };
}

export function searchMatchFromProto(p: PSearchMatch): SearchMatch {
  return {
    id: n(p.id),
    filepath: p.filepath,
    score: p.score,
    tags: p.tags.map(tagSummaryFromProto),
    match_type: p.matchType,
    hamming_distance: p.hammingDistance,
    parsed_metadata: p.parsedMetadata ? parsedMetadataFromProto(p.parsedMetadata) : undefined,
    ocr_text: p.ocrText,
    character_identities: p.characterIdentities.map(characterIdentitySummaryFromProto),
    animation: p.animation ? animationSummaryFromProto(p.animation) : null,
    video: p.video ? videoSummaryFromProto(p.video) : null,
    favorite: p.favorite,
    is_missing: p.isMissing,
  };
}

export function batchPreviewItemFromProto(p: PBatchPreviewItem): BatchPreviewItem {
  return {
    image_id: n(p.imageId),
    filename: p.filename,
    filepath: p.filepath,
    match_result: p.matchResult ? parsedMetadataFromProto(p.matchResult) : undefined,
  };
}

export function tagStatFromProto(p: PTagStat): TagStat {
  return {
    tag: p.tag,
    category: p.category,
    count: n(p.count),
  };
}

export function folderDetailsFromProto(p: PFolderDetails): FolderDetails {
  return {
    id: n(p.id),
    path: p.path,
    name: p.name,
    imported_at: p.importedAt,
    image_count: n(p.imageCount),
    video_count: n(p.videoCount),
    vector_ready: n(p.vectorReady),
    vector_pending: n(p.vectorPending),
    missing_image_count: n(p.missingImageCount),
    missing_video_count: n(p.missingVideoCount),
    is_missing: p.isMissing,
  };
}

export function duplicateFolderInfoFromProto(p: PDuplicateFolderInfo): DuplicateFolderInfo {
  return {
    id: n(p.id),
    path: p.path,
    name: p.name,
    image_count: n(p.imageCount),
    overlap_count: n(p.overlapCount),
  };
}

export function pluginInfoFromProto(p: PPluginInfo): PluginInfo {
  return {
    name: p.name,
    version: p.version,
    description: p.description,
    permissions: p.permissions,
    ui: p.ui ?? null,
    hooks: p.hooks,
    loaded: p.loaded,
    enabled: p.enabled,
    manifest_path: p.manifestPath,
  };
}

export function taggerStatusInfoFromProto(p: PTaggerStatusInfo): TaggerStatusInfo {
  return {
    loaded: p.loaded,
    model_path: p.modelPath,
    total_tags: p.totalTags,
  };
}
