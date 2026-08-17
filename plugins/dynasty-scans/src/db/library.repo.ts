import { query, execute } from "./client";
import type {
  FollowedSeriesRow,
  FollowedSeriesPageResult,
  ReadingProgressRow,
  SeriesProgressRow,
  HistoryRow,
  HistoryPageResult,
  BookmarkRow,
  BookmarkPageResult,
} from "../types/db";

export async function getFollowedSeries(): Promise<FollowedSeriesRow[]> {
  return query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series
     ORDER BY name COLLATE NOCASE`,
  );
}

export async function getFollowedSeriesCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM followed_series`);
  return rows[0]?.count ?? 0;
}

export async function getFollowedSeriesPage(
  page = 1,
  pageSize = 10,
): Promise<FollowedSeriesPageResult> {
  const totalCount = await getFollowedSeriesCount();
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = await query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series
     ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [pageSize, offset],
  );
  return { rows, totalPages, currentPage, totalCount };
}

export async function getFollowedSeriesRow(permalink: string): Promise<FollowedSeriesRow | null> {
  const rows = await query<FollowedSeriesRow>(
    `SELECT permalink, name, cover, last_checked_at, latest_chapter_permalink,
            latest_chapter_title, created_at
     FROM followed_series WHERE permalink = ?`,
    [permalink],
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
    ],
  );
}

export async function unfollowSeries(permalink: string): Promise<void> {
  await execute(`DELETE FROM followed_series WHERE permalink = ?`, [permalink]);
}

/**
 * Updates only the stored cover path of a followed series. Keeps the library
 * cover in sync after a cover cache clear re-downloads a fresh thumbnail.
 */
export async function updateFollowedSeriesCover(
  permalink: string,
  cover: string | null,
): Promise<void> {
  await execute(`UPDATE followed_series SET cover = ? WHERE permalink = ?`, [cover, permalink]);
}

export async function getReadingProgress(
  chapterPermalink: string,
): Promise<ReadingProgressRow | null> {
  const rows = await query<ReadingProgressRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, page_total, completed, updated_at
     FROM reading_progress WHERE chapter_permalink = ?`,
    [chapterPermalink],
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
    ],
  );
}

/** Reading progress for every chapter of a series (one query, no per-chapter calls). */
export async function getProgressForSeries(seriesPermalink: string): Promise<SeriesProgressRow[]> {
  return query<SeriesProgressRow>(
    `SELECT chapter_permalink, page_index, page_total, completed
     FROM reading_progress WHERE series_permalink = ?`,
    [seriesPermalink],
  );
}

export async function addHistory(p: {
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  chapterTitle: string;
}): Promise<void> {
  const lastRows = await query<HistoryRow>(
    `SELECT id, chapter_permalink FROM reading_history ORDER BY id DESC LIMIT 1`,
  );
  if (lastRows.length > 0 && lastRows[0].chapter_permalink === p.chapterPermalink) {
    await execute(
      `UPDATE reading_history
       SET series_permalink = ?, series_name = ?, chapter_title = ?, read_at = ?
       WHERE id = ?`,
      [p.seriesPermalink, p.seriesName, p.chapterTitle, Date.now(), lastRows[0].id],
    );
  } else {
    await execute(
      `INSERT INTO reading_history (chapter_permalink, series_permalink, series_name,
         chapter_title, read_at)
       VALUES (?, ?, ?, ?, ?)`,
      [p.chapterPermalink, p.seriesPermalink, p.seriesName, p.chapterTitle, Date.now()],
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
    [limit],
  );
}

export async function getHistoryCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM reading_history`);
  return rows[0]?.count ?? 0;
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
    [pageSize, offset],
  );
  return { rows, totalPages, currentPage, totalCount };
}

/** Returns a Set of chapter permalinks that have been recorded in history. */
export async function getHistoryPermalinks(permalinks: string[]): Promise<Set<string>> {
  if (permalinks.length === 0) return new Set();
  const placeholders = permalinks.map(() => "?").join(",");
  const rows = await query<{ chapter_permalink: string }>(
    `SELECT DISTINCT chapter_permalink FROM reading_history WHERE chapter_permalink IN (${placeholders})`,
    permalinks,
  );
  return new Set(rows.map((r) => r.chapter_permalink));
}

export async function getBookmarks(): Promise<BookmarkRow[]> {
  return query<BookmarkRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, created_at
     FROM bookmarks ORDER BY created_at DESC`,
  );
}

export async function getBookmarkCount(): Promise<number> {
  const rows = await query<{ count: number }>(`SELECT COUNT(*) as count FROM bookmarks`);
  return rows[0]?.count ?? 0;
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
    [pageSize, offset],
  );
  return { rows, totalPages, currentPage, totalCount };
}

export async function getBookmark(chapterPermalink: string): Promise<BookmarkRow | null> {
  const rows = await query<BookmarkRow>(
    `SELECT chapter_permalink, series_permalink, series_name, chapter_title,
            page_index, created_at
     FROM bookmarks WHERE chapter_permalink = ?`,
    [chapterPermalink],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Returns a Set of chapter permalinks that have been bookmarked. */
export async function getBookmarkPermalinks(permalinks: string[]): Promise<Set<string>> {
  if (permalinks.length === 0) return new Set();
  const placeholders = permalinks.map(() => "?").join(",");
  const rows = await query<{ chapter_permalink: string }>(
    `SELECT chapter_permalink FROM bookmarks WHERE chapter_permalink IN (${placeholders})`,
    permalinks,
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
    [p.chapterPermalink, p.seriesPermalink, p.seriesName, p.chapterTitle, p.pageIndex, Date.now()],
  );
}

export async function removeBookmark(chapterPermalink: string): Promise<void> {
  await execute(`DELETE FROM bookmarks WHERE chapter_permalink = ?`, [chapterPermalink]);
}
