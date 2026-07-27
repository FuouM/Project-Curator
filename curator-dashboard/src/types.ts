// --- Request/Response Payloads (match curator-core::ipc) ---

export type RequestPayload =
  | { Ping: null }
  | { GetStatus: null }
  | { ImportImage: { path: string } }
  | { AddTag: { image_id: number; tag: string; category: string } }
  | { RemoveTag: { image_id: number; tag: string } }
  | { UnblacklistTag: { image_id: number; tag: string } }
  | { Search: { query_text: string | null; query_image_path: string | null; tag_filter: string | null; filename_filter: string | null; parse_filter: string | null; parse_type: string | null; concept_id: number | null; limit: number } }
  | { ListImages: { limit: number; offset: number; only_favorites?: boolean | null } }
  | { SetFavorite: { image_id: number; favorite: boolean } }
  | { GetImage: { image_id: number } }
  | { ValidatePlugin: { manifest_path: string } }
  | { TagImage: { image_id: number; threshold: number | null; force: boolean | null } }
  | { TagImageBatch: { image_ids: number[]; threshold: number | null; force: boolean | null } }
  | { GetTaggerStatus: null }
  | { RunBenchmark: { embedding_model: "clip-vit-b-32" | "mobileclip-s2" } }
  | { GetSettings: null }
  | { UpdateSettings: { clip_device: string | null; tagger_device: string | null; idle_timeout_secs: number | null; embedding_model: string | null } }
  | { ReindexVectors: null }
  | { GetTagStatistics: null }
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
  | { RunBatchFilenameParsing: { pattern_or_type: string; rule_type: string; token_config: TokenBlock[] | null; output_match_type?: string | null } };

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
  | { SearchResult: { matches: SearchMatch[] } }
  | { StatusResult: { image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number } }
  | { ImageResult: { image: ImageDetails } }
  | { ListResult: { images: ImageDetails[] } }
  | { ValidationResult: { name: string; version: string; valid: boolean; error: string | null } }
  | { TagImageResult: { image_id: number; tags_applied: number; skipped: boolean; tags: TagSummary[] } }
  | { BatchTagResult: { processed: number; failed: number; skipped: number } }
  | { TaggerStatusResult: { loaded: boolean; model_path: string; total_tags: number } }
  | { BenchmarkResult: { clip_cpu_time_ms: number; clip_gpu_time_ms: number | null; clip_gpu_error: string | null; tagger_cpu_time_ms: number | null; tagger_gpu_time_ms: number | null; tagger_gpu_error: string | null; has_gpu: boolean } }
  | { SettingsResult: { clip_device: string; tagger_device: string; idle_timeout_secs: number; embedding_model: string } }
  | { TagStatisticsResult: { tags: TagStat[] } }
  | { DashboardInitResult: {
      image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number;
      tagger_loaded: boolean; tagger_model_path: string; tagger_total_tags: number;
      clip_device: string; tagger_device: string; idle_timeout_secs: number; embedding_model: string;
      featured_images: ImageDetails[]; latest_images: ImageDetails[];
    } }
  | { ImportedFoldersResult: { folders: FolderDetails[] } }
  | { BackfillResult: { images_backfilled: number } }
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
  | { RunBatchFilenameParsingResult: { total_processed: number; matched_count: number; tags_created: number } };

// --- Card Rendering Data ---

export interface CardImageData {
  id: number;
  filepath: string;
  tags: TagSummary[];
  favorite?: boolean;
  badgeHtml?: string;
  emptyMessage?: string;
  parsedMetadata?: ParsedMetadata;
}
