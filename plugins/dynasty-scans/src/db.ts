/**
 * SQLite access for the dynasty-scans plugin.
 *
 * All queries go through the two generic plugin service commands
 * (`PluginDbExecute` / `PluginDbQuery`) with the plugin-owned database
 * `dynasty_reader.db`. The backend opens a fresh single-connection pool per
 * call, so schema bootstrap runs one `PluginDbExecute` per statement at load.
 */

import { DB_NAME } from "./state";

const PH = window.PluginHost;

export type Row = Record<string, unknown>;

/** Runs a write query; returns rows affected. */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const resp = await PH.callService("PluginDbExecute", {
    db: DB_NAME,
    sql,
    params,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return Number(resp?.PluginDbExecuteResult?.rows_affected ?? 0);
}

/** Runs a read query; returns rows as plain objects. */
export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const resp = await PH.callService("PluginDbQuery", { db: DB_NAME, sql, params });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return (resp?.PluginDbQueryResult?.rows ?? []) as T[];
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS followed_series (
    permalink TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cover TEXT,
    last_checked_at INTEGER NOT NULL,
    latest_chapter_permalink TEXT,
    latest_chapter_title TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_progress (
    chapter_permalink TEXT PRIMARY KEY,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    page_index INTEGER NOT NULL DEFAULT 0,
    page_total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_permalink TEXT NOT NULL,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    read_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    chapter_permalink TEXT PRIMARY KEY,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    page_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cached_metadata (
    cache_key TEXT PRIMARY KEY,
    data_type TEXT NOT NULL,
    json_payload TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    etag TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cached_pages (
    chapter_permalink TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (chapter_permalink, page_index)
  )`,
];

let initDbPromise: Promise<void> | null = null;

/** Creates all tables. Idempotent; safe to call on every load. */
export async function initDb(): Promise<void> {
  if (!initDbPromise) {
    initDbPromise = (async () => {
      for (const sql of SCHEMA) {
        await execute(sql, []);
      }
      try {
        await execute("ALTER TABLE cached_pages ADD COLUMN size_bytes INTEGER DEFAULT 0", []);
      } catch {}
      try {
        await execute("ALTER TABLE cached_metadata ADD COLUMN etag TEXT", []);
      } catch {}
      try {
        await execute("DROP INDEX IF EXISTS idx_reading_history_chapter", []);
      } catch {}
    })();
  }
  return initDbPromise;
}

// ---------------------------------------------------------------------------
// Metadata cache (series / chapter / feed / directory / cover)
// ---------------------------------------------------------------------------

export interface CachedMetadata {
  json_payload: string;
  cached_at: number;
  etag?: string;
}

export async function getCached(key: string): Promise<CachedMetadata | null> {
  const rows = await query<CachedMetadata & { cache_key: string }>(
    `SELECT json_payload, cached_at, etag FROM cached_metadata WHERE cache_key = ?`,
    [key]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Batch retrieves multiple cached metadata records in a single fast SQL query.
 */
export async function getBatchCached(keys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (keys.length === 0) return result;
  const placeholders = keys.map(() => "?").join(",");
  const rows = await query<{ cache_key: string; json_payload: string }>(
    `SELECT cache_key, json_payload FROM cached_metadata WHERE cache_key IN (${placeholders})`,
    keys
  );
  for (const r of rows) {
    result.set(r.cache_key, r.json_payload);
  }
  return result;
}

export async function setCached(key: string, dataType: string, jsonPayload: string, etag?: string): Promise<void> {
  await execute(
    `INSERT INTO cached_metadata (cache_key, data_type, json_payload, cached_at, etag)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       data_type = excluded.data_type,
       json_payload = excluded.json_payload,
       cached_at = excluded.cached_at,
       etag = COALESCE(excluded.etag, cached_metadata.etag)`,
    [key, dataType, jsonPayload, Date.now(), etag ?? null]
  );
}

/** Updates the cached_at timestamp for a key without rewriting its payload or etag. */
export async function touchCached(key: string): Promise<void> {
  await execute(
    `UPDATE cached_metadata SET cached_at = ? WHERE cache_key = ?`,
    [Date.now(), key]
  );
}

// ---------------------------------------------------------------------------
// Followed series
// ---------------------------------------------------------------------------

export interface FollowedSeriesRow {
  permalink: string;
  name: string;
  cover: string | null;
  last_checked_at: number;
  latest_chapter_permalink: string | null;
  latest_chapter_title: string | null;
  created_at: number;
}

export async function getFollowedSeries(): Promise<FollowedSeriesRow[]> {
  return query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series
     ORDER BY name COLLATE NOCASE`
  );
}

export async function getFollowedSeriesCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM followed_series`);
  return rows[0]?.count ?? 0;
}

export interface FollowedSeriesPageResult {
  rows: FollowedSeriesRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export async function getFollowedSeriesPage(page = 1, pageSize = 10): Promise<FollowedSeriesPageResult> {
  const totalCount = await getFollowedSeriesCount();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = await query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series
     ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  return { rows, totalPages, currentPage, totalCount };
}

export async function getFollowedSeriesRow(permalink: string): Promise<FollowedSeriesRow | null> {
  const rows = await query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series WHERE permalink = ?`,
    [permalink]
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function followSeries(row: {
  permalink: string;
  name: string;
  cover: string | null;
  latestChapterPermalink: string | null;
  latestChapterTitle: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO followed_series (permalink, name, cover, last_checked_at,
       latest_chapter_permalink, latest_chapter_title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(permalink) DO UPDATE SET
       name = excluded.name,
       cover = excluded.cover,
       last_checked_at = excluded.last_checked_at,
       latest_chapter_permalink = excluded.latest_chapter_permalink,
       latest_chapter_title = excluded.latest_chapter_title`,
    [
      row.permalink,
      row.name,
      row.cover,
      Date.now(),
      row.latestChapterPermalink,
      row.latestChapterTitle,
      Date.now(),
    ]
  );
}

export async function unfollowSeries(permalink: string): Promise<void> {
  await execute(`DELETE FROM followed_series WHERE permalink = ?`, [permalink]);
}

// ---------------------------------------------------------------------------
// Reading progress / history / bookmarks
// ---------------------------------------------------------------------------

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

export async function getReadingProgress(chapterPermalink: string): Promise<ReadingProgressRow | null> {
  const rows = await query<ReadingProgressRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, page_total, completed, updated_at
     FROM reading_progress WHERE chapter_permalink = ?`,
    [chapterPermalink]
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function setReadingProgress(p: {
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  chapterTitle: string;
  pageIndex: number;
  pageTotal: number;
  completed: boolean;
}): Promise<void> {
  await execute(
    `INSERT INTO reading_progress (chapter_permalink, series_permalink, series_name,
       chapter_title, page_index, page_total, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chapter_permalink) DO UPDATE SET
       series_permalink = excluded.series_permalink,
       series_name = excluded.series_name,
       chapter_title = excluded.chapter_title,
       page_index = excluded.page_index,
       page_total = excluded.page_total,
       completed = excluded.completed,
       updated_at = excluded.updated_at`,
    [
      p.chapterPermalink,
      p.seriesPermalink,
      p.seriesName,
      p.chapterTitle,
      p.pageIndex,
      p.pageTotal,
      p.completed ? 1 : 0,
      Date.now(),
    ]
  );
}

export interface HistoryRow {
  id: number;
  chapter_permalink: string;
  series_permalink: string;
  series_name: string;
  chapter_title: string;
  read_at: number;
}

export async function addHistory(p: {
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  chapterTitle: string;
}): Promise<void> {
  // Check the most recent history record
  const lastRows = await query<HistoryRow>(
    `SELECT id, chapter_permalink FROM reading_history ORDER BY id DESC LIMIT 1`
  );
  if (lastRows.length > 0 && lastRows[0].chapter_permalink === p.chapterPermalink) {
    // Consecutive re-read of the same chapter: update timestamp and info in-place
    await execute(
      `UPDATE reading_history
       SET series_permalink = ?, series_name = ?, chapter_title = ?, read_at = ?
       WHERE id = ?`,
      [p.seriesPermalink, p.seriesName, p.chapterTitle, Date.now(), lastRows[0].id]
    );
  } else {
    // New chapter or returning to a series after reading another: insert new history entry
    await execute(
      `INSERT INTO reading_history (chapter_permalink, series_permalink, series_name,
         chapter_title, read_at)
       VALUES (?, ?, ?, ?, ?)`,
      [p.chapterPermalink, p.seriesPermalink, p.seriesName, p.chapterTitle, Date.now()]
    );
  }
}

export async function removeHistory(id: number): Promise<void> {
  await execute(`DELETE FROM reading_history WHERE id = ?`, [id]);
}

export async function clearHistory(): Promise<void> {
  await execute(`DELETE FROM reading_history`);
}

export async function getHistory(limit = 100): Promise<HistoryRow[]> {
  return query<HistoryRow>(
    `SELECT id, chapter_permalink, series_permalink, series_name, chapter_title, read_at
     FROM reading_history
     ORDER BY read_at DESC, id DESC LIMIT ?`,
    [limit]
  );
}

export async function getHistoryCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM reading_history`);
  return rows[0]?.count ?? 0;
}

export interface HistoryPageResult {
  rows: HistoryRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export async function getHistoryPage(page = 1, pageSize = 15): Promise<HistoryPageResult> {
  const totalCount = await getHistoryCount();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = await query<HistoryRow>(
    `SELECT id, chapter_permalink, series_permalink, series_name, chapter_title, read_at
     FROM reading_history
     ORDER BY read_at DESC, id DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  return { rows, totalPages, currentPage, totalCount };
}

/** Returns a Set of chapter permalinks that have been recorded in history. */
export async function getHistoryPermalinks(permalinks: string[]): Promise<Set<string>> {
  if (permalinks.length === 0) return new Set();
  const placeholders = permalinks.map(() => "?").join(",");
  const rows = await query<{ chapter_permalink: string }>(
    `SELECT DISTINCT chapter_permalink FROM reading_history WHERE chapter_permalink IN (${placeholders})`,
    permalinks
  );
  return new Set(rows.map((r) => r.chapter_permalink));
}

export interface BookmarkRow {
  chapter_permalink: string;
  series_permalink: string;
  series_name: string;
  chapter_title: string;
  page_index: number;
  created_at: number;
}

export async function getBookmarks(): Promise<BookmarkRow[]> {
  return query<BookmarkRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, created_at
     FROM bookmarks ORDER BY created_at DESC`
  );
}

export async function getBookmarkCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM bookmarks`);
  return rows[0]?.count ?? 0;
}

export interface BookmarkPageResult {
  rows: BookmarkRow[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export async function getBookmarksPage(page = 1, pageSize = 15): Promise<BookmarkPageResult> {
  const totalCount = await getBookmarkCount();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = await query<BookmarkRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, created_at
     FROM bookmarks ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  return { rows, totalPages, currentPage, totalCount };
}

export async function getBookmark(chapterPermalink: string): Promise<BookmarkRow | null> {
  const rows = await query<BookmarkRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, created_at
     FROM bookmarks WHERE chapter_permalink = ?`,
    [chapterPermalink]
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Returns a Set of chapter permalinks that have been bookmarked. */
export async function getBookmarkPermalinks(permalinks: string[]): Promise<Set<string>> {
  if (permalinks.length === 0) return new Set();
  const placeholders = permalinks.map(() => "?").join(",");
  const rows = await query<{ chapter_permalink: string }>(
    `SELECT chapter_permalink FROM bookmarks WHERE chapter_permalink IN (${placeholders})`,
    permalinks
  );
  return new Set(rows.map((r) => r.chapter_permalink));
}

export async function addBookmark(p: {
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  chapterTitle: string;
  pageIndex: number;
}): Promise<void> {
  await execute(
    `INSERT INTO bookmarks (chapter_permalink, series_permalink, series_name,
       chapter_title, page_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chapter_permalink) DO UPDATE SET
       page_index = excluded.page_index,
       created_at = excluded.created_at`,
    [p.chapterPermalink, p.seriesPermalink, p.seriesName, p.chapterTitle, p.pageIndex, Date.now()]
  );
}

export async function removeBookmark(chapterPermalink: string): Promise<void> {
  await execute(`DELETE FROM bookmarks WHERE chapter_permalink = ?`, [chapterPermalink]);
}

// ---------------------------------------------------------------------------
// On-disk page cache index
// ---------------------------------------------------------------------------

export interface CachedPageRow {
  chapter_permalink: string;
  page_index: number;
  file_path: string;
  cached_at: number;
}

export async function getCachedPages(chapterPermalink: string): Promise<CachedPageRow[]> {
  return query<CachedPageRow>(
    `SELECT chapter_permalink, page_index, file_path, cached_at
     FROM cached_pages WHERE chapter_permalink = ?`,
    [chapterPermalink]
  );
}

export async function setCachedPage(
  chapterPermalink: string,
  pageIndex: number,
  filePath: string,
  sizeBytes = 0
): Promise<void> {
  await execute(
    `INSERT INTO cached_pages (chapter_permalink, page_index, file_path, size_bytes, cached_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chapter_permalink, page_index) DO UPDATE SET
       file_path = excluded.file_path,
       size_bytes = excluded.size_bytes,
       cached_at = excluded.cached_at`,
    [chapterPermalink, pageIndex, filePath, sizeBytes, Date.now()]
  );
}

export async function countCachedPages(chapterPermalink: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cached_pages WHERE chapter_permalink = ?`,
    [chapterPermalink]
  );
  return Number(rows[0]?.n ?? 0);
}

export interface SeriesProgressRow {
  chapter_permalink: string;
  page_index: number;
  page_total: number;
  completed: number;
}

/** Reading progress for every chapter of a series (one query, no per-chapter calls). */
export async function getProgressForSeries(seriesPermalink: string): Promise<SeriesProgressRow[]> {
  return query<SeriesProgressRow>(
    `SELECT chapter_permalink, page_index, page_total, completed
     FROM reading_progress WHERE series_permalink = ?`,
    [seriesPermalink]
  );
}

export interface ChapterCacheCount {
  chapter_permalink: string;
  n: number;
}

/** Cached-page counts for a batch of chapters (one query). */
export async function getCachedPageCounts(chapterPermalinks: string[]): Promise<ChapterCacheCount[]> {
  if (chapterPermalinks.length === 0) return [];
  const placeholders = chapterPermalinks.map(() => "?").join(",");
  return query<ChapterCacheCount>(
    `SELECT chapter_permalink, COUNT(*) AS n FROM cached_pages
     WHERE chapter_permalink IN (${placeholders}) GROUP BY chapter_permalink`,
    chapterPermalinks
  );
}

// ---------------------------------------------------------------------------
// Cache Management & Statistics
// ---------------------------------------------------------------------------

export interface CacheOverviewStats {
  totalCachedPages: number;
  totalCachedChapters: number;
  totalSizeBytes: number;
  totalMetadataEntries: number;
}

export async function getCacheOverviewStats(): Promise<CacheOverviewStats> {
  const [pageRows, metaRows, diskStat] = await Promise.all([
    query<{ pages: number; chapters: number; total_bytes: number }>(
      `SELECT COUNT(*) as pages, COUNT(DISTINCT chapter_permalink) as chapters, SUM(COALESCE(size_bytes, 0)) as total_bytes FROM cached_pages`
    ),
    query<{ count: number }>(
      `SELECT COUNT(*) as count FROM cached_metadata`
    ),
    (async () => {
      try {
        const resp = await PH.callService("DirStat", { path: "" });
        return Number(resp?.DirStatResult?.total_bytes ?? 0);
      } catch {
        return 0;
      }
    })(),
  ]);

  const pages = Number(pageRows[0]?.pages ?? 0);
  const bytes = diskStat > 0 ? diskStat : Number(pageRows[0]?.total_bytes ?? 0);

  return {
    totalCachedPages: pages,
    totalCachedChapters: Number(pageRows[0]?.chapters ?? 0),
    totalSizeBytes: bytes,
    totalMetadataEntries: Number(metaRows[0]?.count ?? 0),
  };
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

export async function getCachedSeriesGroups(): Promise<CachedSeriesGroup[]> {
  const chapterRows = await query<{
    chapter_permalink: string;
    page_count: number;
    size_bytes: number;
    last_cached: number;
  }>(
    `SELECT chapter_permalink, COUNT(*) as page_count, SUM(COALESCE(size_bytes, 0)) as size_bytes, MAX(cached_at) as last_cached
     FROM cached_pages GROUP BY chapter_permalink`
  );

  if (chapterRows.length === 0) return [];

  const permalinks = chapterRows.map((r) => r.chapter_permalink);
  const placeholders = permalinks.map(() => "?").join(",");

  const [progRows, histRows, metaRows, page0Rows] = await Promise.all([
    query<{ chapter_permalink: string; series_permalink: string; series_name: string; chapter_title: string }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title FROM reading_progress WHERE chapter_permalink IN (${placeholders})`,
      permalinks
    ),
    query<{ chapter_permalink: string; series_permalink: string; series_name: string; chapter_title: string }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title FROM reading_history WHERE chapter_permalink IN (${placeholders})`,
      permalinks
    ),
    query<{ cache_key: string; json_payload: string }>(
      `SELECT cache_key, json_payload FROM cached_metadata WHERE data_type = 'cover'`
    ),
    query<{ chapter_permalink: string; file_path: string }>(
      `SELECT chapter_permalink, file_path FROM cached_pages WHERE page_index = 0 AND chapter_permalink IN (${placeholders})`,
      permalinks
    ),
  ]);

  const coverMap = new Map<string, string>();
  for (const m of metaRows) {
    coverMap.set(m.cache_key.replace(/^cover:/, ""), m.json_payload);
  }

  const page0Map = new Map<string, string>();
  for (const p of page0Rows) {
    page0Map.set(p.chapter_permalink, p.file_path);
  }

  const chapterInfoMap = new Map<string, { seriesPermalink: string; seriesName: string; chapterTitle: string }>();
  for (const r of histRows) {
    chapterInfoMap.set(r.chapter_permalink, {
      seriesPermalink: r.series_permalink,
      seriesName: r.series_name,
      chapterTitle: r.chapter_title,
    });
  }
  for (const r of progRows) {
    chapterInfoMap.set(r.chapter_permalink, {
      seriesPermalink: r.series_permalink,
      seriesName: r.series_name,
      chapterTitle: r.chapter_title,
    });
  }

  const groupMap = new Map<string, CachedSeriesGroup>();
  for (const row of chapterRows) {
    const cp = row.chapter_permalink;
    const info = chapterInfoMap.get(cp);
    const seriesPermalink = info?.seriesPermalink || "";
    const seriesName = info?.seriesName || "";

    const groupKey = seriesPermalink ? `series:${seriesPermalink}` : `chapter:${cp}`;
    let g = groupMap.get(groupKey);
    if (!g) {
      const coverPath =
        (seriesPermalink && (coverMap.get(`series:${seriesPermalink}`) || coverMap.get(seriesPermalink))) ||
        coverMap.get(`chapter:${cp}`) ||
        coverMap.get(cp) ||
        page0Map.get(cp) ||
        null;

      g = {
        seriesPermalink: seriesPermalink || cp,
        seriesName: seriesName || info?.chapterTitle || cp,
        isStandalone: !seriesPermalink,
        coverPath,
        chapterCount: 0,
        pageCount: 0,
        totalSizeBytes: 0,
        lastCachedAt: 0,
        chapterPermalinks: [],
      };
      groupMap.set(groupKey, g);
    }
    const pageCount = Number(row.page_count);
    const sizeBytes = Number(row.size_bytes);
    g.chapterCount += 1;
    g.pageCount += pageCount;
    g.totalSizeBytes += sizeBytes;
    g.lastCachedAt = Math.max(g.lastCachedAt, Number(row.last_cached));
    g.chapterPermalinks.push(cp);
  }

  // Exact disk footprint resolution via DirStat and exact file path check
  await Promise.all(
    Array.from(groupMap.values()).map(async (g) => {
      try {
        const clean = g.seriesPermalink.replace(/[^a-zA-Z0-9_-]/g, "_");
        const candidatePaths = g.isStandalone
          ? [`pages/_singles/${clean}`, `pages/${clean}`]
          : [`pages/${clean}`];

        let foundBytes = 0;
        for (const p of candidatePaths) {
          const resp = await PH.callService("DirStat", { path: p });
          const bytes = Number(resp?.DirStatResult?.total_bytes ?? 0);
          if (bytes > 0) {
            foundBytes = bytes;
            break;
          }
        }

        // If directory matching didn't yield bytes, check exact registered file paths
        if (foundBytes === 0 && g.chapterPermalinks.length > 0) {
          const placeholders = g.chapterPermalinks.map(() => "?").join(",");
          const pathRows = await query<{ file_path: string }>(
            `SELECT file_path FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
            g.chapterPermalinks
          );
          for (const row of pathRows) {
            const resp = await PH.callService("FileExists", { path: row.file_path });
            foundBytes += Number(resp?.FileExistsResult?.size_bytes ?? 0);
          }
        }

        g.totalSizeBytes = foundBytes;
      } catch {}
    })
  );

  return Array.from(groupMap.values()).sort((a, b) => b.lastCachedAt - a.lastCachedAt);
}

async function deleteFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await PH.callService("FileDelete", { path: p });
      } catch {}
    })
  );
}

export async function clearCachedGroupPages(chapterPermalinks: string[]): Promise<void> {
  if (chapterPermalinks.length === 0) return;
  const placeholders = chapterPermalinks.map(() => "?").join(",");
  const rows = await query<{ file_path: string }>(
    `SELECT file_path FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
    chapterPermalinks
  );
  await deleteFiles(rows.map((r) => r.file_path));
  await execute(
    `DELETE FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
    chapterPermalinks
  );
}

export async function clearAllCachedPages(): Promise<void> {
  const rows = await query<{ file_path: string }>(`SELECT file_path FROM cached_pages`);
  await deleteFiles(rows.map((r) => r.file_path));
  await execute(`DELETE FROM cached_pages`);
}

export async function clearAllCachedCovers(): Promise<void> {
  const coverRows = await query<{ json_payload: string }>(
    `SELECT json_payload FROM cached_metadata WHERE data_type = 'cover'`
  );
  await deleteFiles(coverRows.map((r) => r.json_payload));
  await execute(`DELETE FROM cached_metadata WHERE data_type = 'cover'`);
}

export async function clearAllCacheStorage(): Promise<void> {
  await clearAllCachedPages();
  await clearAllCachedCovers();
  await execute(`DELETE FROM cached_metadata`);
}