export interface TokenBlock {
  token_type: string;
  value?: string;
  label?: string;
  enabled?: boolean;
  optional_prefix?: string;
}

export interface ParsedMetadata {
  match_type: string;
  raw_matched: string;
  artist?: string;
  pixiv_id?: string;
  twitter_id?: string;
  timestamp_4chan?: string;
  datetime_iso?: string;
  extracted_tags: string[];
  partial?: boolean;
}

export interface BatchPreviewItem {
  image_id: number;
  filename: string;
  filepath: string;
  match_result?: ParsedMetadata;
}

/** Per-class probabilities from the safety classifier (undefined = not yet classified). */
export interface SafetyScores {
  safe_score?: number;
  hentai_score?: number;
  porn_score?: number;
  sexy_score?: number;
  drawing_score?: number;
}

export interface SearchMatch extends SafetyScores {
  id: number;
  filepath: string;
  score: number;
  tags: TagSummary[];
  match_type: string;
  hamming_distance?: number;
  parsed_metadata?: ParsedMetadata;
  ocr_text?: string;
  character_identities?: CharacterIdentitySummary[];
  animation?: AnimationSummary | null;
  video?: VideoSummary | null;
  favorite: boolean;
  is_missing?: boolean;
  width?: number;
  height?: number;
  mtime?: number;
}

export interface ImageDetails extends SafetyScores {
  id: number;
  sha256: string;
  current_filepath: string;
  mtime: number;
  created_at: string;
  tags: TagSummary[];
  vector_state: string;
  favorite: boolean;
  parsed_metadata?: ParsedMetadata;
  is_missing: boolean;
  character_identities: CharacterIdentitySummary[];
  ocr_text?: string;
  width?: number | null;
  height?: number | null;
  animation?: AnimationSummary | null;
  video?: VideoSummary | null;
  note?: string | null;
}

export interface AnimationSummary {
  format: string;
  frame_count: number;
  duration_ms: number;
  loop_count?: number | null;
  is_animated: boolean;
}

export interface VideoSummary {
  format: string;
  duration_ms: number;
  fps: number;
  video_codec: string;
  audio_codec?: string | null;
  bitrate?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface StorageTypeStat {
  category: string;
  extension: string;
  size_bytes: number;
  count: number;
}

export interface StorageStats {
  stats: StorageTypeStat[];
}

export interface CharacterIdentitySummary {
  id: number;
  name: string;
}

export interface TagSummary {
  tag: string;
  category: string;
  confidence: number;
  source_name?: string;
  is_blacklisted?: boolean;
}

export interface TagStat {
  tag: string;
  category: string;
  count: number;
}

export interface FolderDetails {
  id: number;
  path: string;
  name: string;
  imported_at: string;
  image_count: number;
  video_count: number;
  vector_ready: number;
  vector_pending: number;
  missing_image_count: number;
  missing_video_count: number;
  is_missing: boolean;
  safety_classified: number;
  safety_pending: number;
}


export interface DuplicateFolderInfo {
  id: number;
  path: string;
  name: string;
  image_count: number;
  overlap_count: number;
}

export interface DuplicateFolderGroup {
  folders: DuplicateFolderInfo[];
  shared_image_count: number;
}

export interface CustomConcept {
  id: number;
  name: string;
  category: string;
  threshold: number;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

export interface CharacterDetection {
  id: number;
  image_id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  has_embedding: boolean;
  identity_id: number | null;
}

export interface DetectionCropEntry {
  detection_id: number;
  crop_webp_bytes: number[];
}

export interface CharacterSearchEntry {
  identity_id: number;
  image_ids: number[];
}

export interface CharacterIdentity {
  id: number;
  name: string;
  detection_count: number;
  created_at: string;
}

export interface DetectionBatchItem {
  image_id: number;
  detections: CharacterDetection[];
}

// --- Card Rendering Data ---

export interface CardImageData {
  id: number;
  filepath: string;
  tags: TagSummary[];
  favorite?: boolean;
  badgeHtml?: string;
  emptyMessage?: string;
  parsedMetadata?: ParsedMetadata;
  isMissing?: boolean;
  characterIdentities?: CharacterIdentitySummary[];
  ocrText?: string;
  animation?: AnimationSummary | null;
  video?: VideoSummary | null;
  width?: number;
  height?: number;
  mtime?: number;
  safety?: SafetyScores;
}

export interface OcrResult {
  id: number;
  image_id: number;
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  is_from_bubble: boolean;
}

export interface BubbleBoxResult {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

export interface ManifestFileInfo {
  url: string;
  dest: string;
  sha256: string;
}

export interface ModelStatusInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  optional: boolean;
  url: string;
  files: ManifestFileInfo[];
  downloaded_files: string[];
  total_size: number;
  downloaded_size: number;
  status: "downloaded" | "partial" | "not_downloaded";
  quantized_variants: string[];
  quantizable: string[];
  required_by: string[];
}

export interface DownloadProgress {
  model_id: string;
  status: "downloading" | "quantizing" | "completed" | "failed" | "cancelled";
  files_total: number;
  files_completed: number;
  bytes_total: number;
  bytes_downloaded: number;
  bytes_per_second: number;
  elapsed_secs: number;
  error: string | null;
}

// --- Plugin System Types (match curator-core::ipc) ---

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  ui: string | null;
  hooks: string[];
  loaded: boolean;
  enabled: boolean;
  manifest_path: string;
}

export interface ConvertedFileInfo {
  source_path: string;
  output_path: string;
  error: string | null;
}

export interface TagContext {
  name: string;
  category: string;
  source_id: string;
  confidence: number | null;
}

export interface TaggerStatusInfo {
  loaded: boolean;
  model_path: string;
  total_tags: number;
}

export interface AssetContext {
  asset_id: number;
  path: string;
  hash: string;
  mime_type?: string;
  width?: number;
  height?: number;
  tags: TagContext[];
  indexed_at?: string;
}
