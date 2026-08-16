import { query, execute } from "./client";
import type {
  CachedPageRow,
  ChapterCacheCount,
  CacheOverviewStats,
  CachedSeriesGroup,
} from "../types/db";

const PH = window.PluginHost;

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