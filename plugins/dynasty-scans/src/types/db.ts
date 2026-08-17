/**
 * SQLite record shapes returned by the plugin's domain repositories.
 */

export type Row = Record<string, unknown>;

export interface CachedMetadata {
  json_payload: string;
  cached_at: number;
  etag?: string;
}

export interface FollowedSeriesRow {
  permalink: string;
  name: string;
  cover: string | null;
  last_checked_at: number;
  latest_chapter_permalink: string | null;
  latest_chapter_title: string | null;
  created_at: number;
}

export interface FollowedSeriesPageResult {
  rows: FollowedSeriesRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export interface ReadingProgressRow {
  chapter_permalink: string;
  series_permalink: string;
  series_name: string;
  chapter_title: string;
  page_index: number;
  page_total: number;
  completed: number;
  updated_at: number;
}

export interface SeriesProgressRow {
  chapter_permalink: string;
  page_index: number;
  page_total: number;
  completed: number;
}

export interface HistoryRow {
  id: number;
  chapter_permalink: string;
  series_permalink: string;
  series_name: string;
  chapter_title: string;
  read_at: number;
}

export interface HistoryPageResult {
  rows: HistoryRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export interface BookmarkRow {
  chapter_permalink: string;
  series_permalink: string;
  series_name: string;
  chapter_title: string;
  page_index: number;
  created_at: number;
}

export interface BookmarkPageResult {
  rows: BookmarkRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export interface CachedPageRow {
  chapter_permalink: string;
  page_index: number;
  file_path: string;
  cached_at: number;
}

export interface ChapterCacheCount {
  chapter_permalink: string;
  n: number;
}

export interface CacheOverviewStats {
  totalCachedPages: number;
  totalCachedChapters: number;
  totalSizeBytes: number;
  totalMetadataEntries: number;
}

export interface CachedSeriesGroup {
  seriesPermalink: string;
  seriesName: string;
  isStandalone: boolean;
  coverPath: string | null;
  chapterCount: number;
  pageCount: number;
  totalSizeBytes: number;
  lastCachedAt: number;
  chapterPermalinks: string[];
}
