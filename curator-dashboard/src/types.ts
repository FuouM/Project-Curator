// --- Request/Response Payloads (match curator-core::ipc) ---

export type RequestPayload =
  | { Ping: null }
  | { GetStatus: null }
  | { ImportImage: { path: string } }
  | { AddTag: { image_id: number; tag: string; category: string } }
  | { RemoveTag: { image_id: number; tag: string } }
  | { UnblacklistTag: { image_id: number; tag: string } }
  | { Search: { query_text: string | null; query_image_path: string | null; tag_filter: string | null; filename_filter: string | null; parse_filter: string | null; parse_type: string | null; concept_id: number | null; character_identity_id: number | null; ocr_filter: boolean | null; ocr_text_search: string | null; limit: number } }
  | { ListImages: { limit: number; offset: number; only_favorites?: boolean | null } }
  | { SetFavorite: { image_id: number; favorite: boolean } }
  | { GetImage: { image_id: number } }
  | { GetThumbnail: { image_id: number; width?: number } }
  | { PurgeMissingThumbnails: null }
  | { TagImage: { image_id: number; threshold: number | null; force: boolean | null } }
  | { TagImageBatch: { image_ids: number[]; threshold: number | null; force: boolean | null } }
  | { GetTaggerStatus: null }
  | { RunBenchmark: { embedding_model: "clip-vit-b-32" | "mobileclip-s2", run_tagger?: boolean | null } }
  | { RunTaggerBenchmark: null }
  | { GetSettings: null }
  | { ClearCropCache: null }
  | { UpdateSettings: { clip_device: string | null; tagger_device: string | null; idle_timeout_secs: number | null; embedding_model: string | null; detection_device: string | null; detection_metrics_device: string | null; ocr_device: string | null; model_precisions: Record<string, "original" | "int8"> | null } }
  | { ReindexVectors: null }
  | { ReindexFailedVectors: null }
  | { RunOcr: { image_id: number } }
  | { GetOcrDetections: { image_id: number } }
  | { GetTagStatistics: null }
  | { GetCharacterSuggestions: null }
  | { GetDashboardInit: null }
  | { GetImportedFolders: null }
  | { BackfillImageFolders: null }
  | { UpdateFolderPath: { id: number; new_path: string } }
  | { DeleteFolder: { id: number } }
  | { DetectDuplicateFolders: null }
  | { MergeFolders: { keep_folder_id: number; merge_folder_id: number } }
  | { CreateConcept: { name: string; category: string; threshold: number; sample_image_ids: number[] } }
  | { ListConcepts: null }
  | { UpdateConcept: { id: number; threshold: number | null; category: string | null } }
  | { DeleteConcept: { id: number } }
  | { AddConceptSamples: { concept_id: number; image_ids: number[] } }
  | { RemoveConceptSample: { concept_id: number; image_id: number } }
  | { RescanConcept: { concept_id: number } }
  | { GetConceptSamples: { concept_id: number } }
  | { TestFilenamePattern: { filename: string; pattern_or_type: string; rule_type: string; token_config: TokenBlock[] | null } }
  | { CompileTokenBlocks: { token_config: TokenBlock[] } }
  | { PreviewBatchFilenameParsing: { limit: number; pattern_or_type: string; rule_type: string; token_config: TokenBlock[] | null; output_match_type?: string | null } }
  | { RunBatchFilenameParsing: { pattern_or_type: string; rule_type: string; token_config: TokenBlock[] | null; output_match_type?: string | null } }
  | { DetectCharacters: { image_id: number } }
  | { DetectCharactersBatch: { image_ids: number[] } }
  | { GetCharacterDetections: { image_id: number } }
  | { GetCharacterDetectionsBatch: { image_ids: number[] } }
  | { GetDetectionCrop: { detection_id: number; max_size?: number } }
  | { GetDetectionCrops: { detection_ids: number[]; max_size?: number } }
  | { AssignCharacterIdentity: { detection_id: number; identity_id: number | null } }
  | { CreateCharacterIdentity: { name: string | null } }
  | { RenameCharacterIdentity: { identity_id: number; name: string } }
  | { DeleteCharacterIdentity: { identity_id: number } }
  | { ListCharacterIdentities: null }
  | { ReidentifyAllDetections: null }
  | { SearchByCharacter: { identity_id: number } }
  | { SearchByCharacterBatch: { identity_ids: number[] } }
  | { ListUnassignedDetections: null }
  | { DeleteDetection: { detection_id: number } }
  | { UpdateDetectionBoundingBox: { detection_id: number; x0: number; y0: number; x1: number; y1: number } }
  | { AddDetection: { image_id: number; x0: number; y0: number; x1: number; y1: number } }
  | { IdentifyDetection: { detection_id: number } }
  | { RunYoloBenchmark: null }
  | { RunCcipFeatBenchmark: null }
  | { RunCcipMetricsBenchmark: null }
  | { RunOcrDetBenchmark: null }
  | { RunOcrRecBenchmark: null }
  | { RunOcrClsBenchmark: null }
  | { RunMangaBubbleBenchmark: null }
  | { GetBenchmarkImages: { limit: number } }
  | { BenchmarkSingleImage: { filepath: string } }
  | { RunImageProcessingBenchmark: { filepaths: string[] } }
  | { GetImageProcessingBenchmarkProgress: null }
  | { GetRandomImage: null }
  | { GetModelStatus: null }
  | { DownloadModel: { model_id: string } }
  | { CancelDownload: { model_id: string } }
  | { RemoveModel: { model_id: string } }
  | { GetDownloadProgress: null }
  | { QuantizeModel: { model_id: string; format: string } };

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

export interface SearchMatch {
  id: number;
  filepath: string;
  score: number;
  tags: TagSummary[];
  match_type: string;
  hamming_distance?: number;
  parsed_metadata?: ParsedMetadata;
  ocr_text?: string;
  character_identities?: CharacterIdentitySummary[];
}

export interface ImageDetails {
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
  vector_ready: number;
  vector_pending: number;
  missing_image_count: number;
  is_missing: boolean;
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

export type ResponsePayload =
  | { Pong: null }
  | { Success: null }
  | { Error: { message: string } }
  | { ImportResult: { image_id: number; sha256: string; imported_count?: number; folder_id?: number | null } }
  | { ThumbnailResult: { data?: number[]; is_missing: boolean } }
  | { PurgeResult: { deleted_count: number } }
  | { SearchResult: { matches: SearchMatch[] } }
  | { StatusResult: { image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number } }
  | { ImageResult: { image: ImageDetails } }
  | { ListResult: { images: ImageDetails[]; total_count: number } }
  | { ValidationResult: { name: string; version: string; valid: boolean; error: string | null } }
  | { TagImageResult: { image_id: number; tags_applied: number; skipped: boolean; tags: TagSummary[] } }
  | { BatchTagResult: { processed: number; failed: number; skipped: number } }
  | { TaggerStatusResult: { loaded: boolean; model_path: string; total_tags: number } }
  | { BenchmarkResult: { clip_cpu_time_ms: number; clip_gpu_time_ms: number | null; clip_gpu_error: string | null; tagger_cpu_time_ms: number | null; tagger_gpu_time_ms: number | null; tagger_gpu_error: string | null; has_gpu: boolean } }
  | { SettingsResult: { clip_device: string; tagger_device: string; idle_timeout_secs: number; embedding_model: string; detection_device: string; detection_metrics_device: string; ocr_device: string; model_precisions: Record<string, "original" | "int8"> } }
  | { TagStatisticsResult: { tags: TagStat[] } }
  | { DashboardInitResult: {
      image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number;
      tagger_loaded: boolean; tagger_model_path: string; tagger_total_tags: number;
      clip_device: string; tagger_device: string; idle_timeout_secs: number; embedding_model: string;
      detection_device: string; detection_metrics_device: string; ocr_device: string;
      model_precisions: Record<string, "original" | "int8">;
      featured_images: ImageDetails[]; latest_images: ImageDetails[];
    } }
  | { ImportedFoldersResult: { folders: FolderDetails[] } }
  | { BackfillResult: { images_backfilled: number } }
  | { ReindexFailedResult: { requeued: number } }
  | { UpdateFolderPathResult: { success: boolean } }
  | { DeleteFolderResult: { success: boolean } }
  | { DuplicateFoldersResult: { groups: DuplicateFolderGroup[] } }
  | { MergeFoldersResult: { success: boolean; images_moved: number } }
  | { ConceptListResult: { concepts: CustomConcept[] } }
  | { ConceptResult: { concept: CustomConcept } }
  | { ConceptRescannedResult: { concept_id: number; tagged_count: number } }
  | { ConceptSamplesResult: { concept_id: number; samples: ImageDetails[] } }
  | { TestFilenamePatternResult: { result: ParsedMetadata | null } }
  | { CompileTokenBlocksResult: { regex: string } }
  | { PreviewBatchFilenameParsingResult: { items: BatchPreviewItem[] } }
  | { RunBatchFilenameParsingResult: { total_processed: number; matched_count: number; tags_created: number } }
  | { DetectionResult: { image_id: number; detections: CharacterDetection[] } }
  | { DetectionBatchResult: { results: DetectionBatchItem[] } }
  | { CharacterDetectionsResult: { image_id: number; detections: CharacterDetection[] } }
  | { AddDetectionResult: { detection: CharacterDetection } }
  | { IdentifyDetectionResult: { identity_id: number | null } }
  | { DetectionCropResult: { crop_webp_bytes: number[] } }
  | { DetectionCropsResult: { crops: DetectionCropEntry[] } }
  | { CharacterIdentitiesList: { identities: CharacterIdentity[] } }
  | { ReidentifyResult: { total_detections: number; matched: number; unmatched: number } }
  | { CharacterSearchResult: { image_ids: number[] } }
  | { CharacterSearchBatchResult: { results: CharacterSearchEntry[] } }
  | { UnassignedDetectionsList: { detections: CharacterDetection[] } }
  | { DetectionBenchmarkResult: {
      yolo_cpu_time_ms: number | null;
      yolo_gpu_time_ms: number | null;
      yolo_gpu_error: string | null;
      ccip_feat_cpu_time_ms: number | null;
      ccip_feat_gpu_time_ms: number | null;
      ccip_feat_gpu_error: string | null;
      ccip_metrics_cpu_time_ms: number | null;
      ccip_metrics_gpu_time_ms: number | null;
      ccip_metrics_gpu_error: string | null;
      ocr_det_cpu_time_ms: number | null;
      ocr_det_gpu_time_ms: number | null;
      ocr_det_gpu_error: string | null;
      ocr_rec_cpu_time_ms: number | null;
      ocr_rec_gpu_time_ms: number | null;
      ocr_rec_gpu_error: string | null;
      ocr_cls_cpu_time_ms: number | null;
      ocr_cls_gpu_time_ms: number | null;
      ocr_cls_gpu_error: string | null;
      manga_bubble_cpu_time_ms: number | null;
      manga_bubble_gpu_time_ms: number | null;
      manga_bubble_gpu_error: string | null;
      has_gpu: boolean;
    } }
  | { BenchmarkImagesResult: {
      filepaths: string[];
    } }
  | { SingleImageBenchmarkResult: {
      decode_time_ms: number;
      thumbnail_time_ms: number;
      clip_preprocess_time_ms: number;
      tagger_preprocess_time_ms: number;
      yolo_preprocess_time_ms: number;
      ccip_extract_preprocess_time_ms: number;
      ocr_det_preprocess_time_ms: number;
      ocr_rec_preprocess_time_ms: number;
    } }
  | { ImageProcessingBenchmarkProgress: {
      running: boolean;
      processed: number;
      total: number;
      decode_time_ms: number;
      thumbnail_time_ms: number;
      clip_preprocess_time_ms: number;
      tagger_preprocess_time_ms: number;
      yolo_preprocess_time_ms: number;
      ccip_extract_preprocess_time_ms: number;
      ocr_det_preprocess_time_ms: number;
      ocr_rec_preprocess_time_ms: number;
    } }
  | { OcrDetectionsResult: { image_id: number; detections: OcrResult[]; bubble_boxes: BubbleBoxResult[] } }
  | { RandomImageResult: { image: ImageDetails; index: number } }
  | { ModelStatusResult: { models: ModelStatusInfo[] } }
  | { DownloadProgressResult: { downloads: DownloadProgress[] } }
  | { ModelActionResult: { success: boolean; message: string } };

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
