// --- Request/Response Payloads (match curator-core::ipc) ---

export type RequestPayload =
  | { Ping: null }
  | { GetStatus: null }
  | { ImportImage: { path: string } }
  | { AddTag: { image_id: number; tag: string; category: string } }
  | { RemoveTag: { image_id: number; tag: string } }
  | { Search: { query_text: string | null; query_image_path: string | null; tag_filter: string | null; limit: number } }
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
  | { BackfillImageFolders: null };

export interface SearchMatch {
  id: number;
  filepath: string;
  score: number;
  tags: TagSummary[];
  match_type: string;
  hamming_distance?: number;
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
}

export interface TagSummary {
  tag: string;
  category: string;
  confidence: number;
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
  | { BackfillResult: { images_backfilled: number } };

// --- Card Rendering Data ---

export interface CardImageData {
  id: number;
  filepath: string;
  tags: TagSummary[];
  favorite?: boolean;
  badgeHtml?: string;
  emptyMessage?: string;
}
