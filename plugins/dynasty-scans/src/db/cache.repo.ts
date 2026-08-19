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
    [chapterPermalink],
  );
}

export async function setCachedPage(
  chapterPermalink: string,
  pageIndex: number,
  filePath: string,
  sizeBytes = 0,
): Promise<void> {
  await execute(
    `INSERT INTO cached_pages (chapter_permalink, page_index, file_path, size_bytes, cached_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chapter_permalink, page_index) DO UPDATE SET
       file_path = excluded.file_path,
       size_bytes = excluded.size_bytes,
       cached_at = excluded.cached_at`,
    [chapterPermalink, pageIndex, filePath, sizeBytes, Date.now()],
  );
}

export async function countCachedPages(chapterPermalink: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cached_pages WHERE chapter_permalink = ?`,
    [chapterPermalink],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Cached-page counts for a batch of chapters (one query). */
export async function getCachedPageCounts(
  chapterPermalinks: string[],
): Promise<ChapterCacheCount[]> {
  if (chapterPermalinks.length === 0) return [];
  const placeholders = chapterPermalinks.map(() => "?").join(",");
  return query<ChapterCacheCount>(
    `SELECT chapter_permalink, COUNT(*) AS n FROM cached_pages
     WHERE chapter_permalink IN (${placeholders}) GROUP BY chapter_permalink`,
    chapterPermalinks,
  );
}

export async function getCacheOverviewStats(): Promise<CacheOverviewStats> {
  const [pageRows, metaRows, diskStat] = await Promise.all([
    query<{ pages: number; chapters: number; total_bytes: number }>(
      `SELECT COUNT(*) as pages, COUNT(DISTINCT chapter_permalink) as chapters, SUM(COALESCE(size_bytes, 0)) as total_bytes FROM cached_pages`,
    ),
    query<{ count: number }>(`SELECT COUNT(*) as count FROM cached_metadata`),
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
     FROM cached_pages GROUP BY chapter_permalink`,
  );

  if (chapterRows.length === 0) return [];

  const permalinks = chapterRows.map((r) => r.chapter_permalink);
  const placeholders = permalinks.map(() => "?").join(",");

  const [progRows, histRows, metaRows, page0Rows] = await Promise.all([
    query<{
      chapter_permalink: string;
      series_permalink: string;
      series_name: string;
      chapter_title: string;
    }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title FROM reading_progress WHERE chapter_permalink IN (${placeholders})`,
      permalinks,
    ),
    query<{
      chapter_permalink: string;
      series_permalink: string;
      series_name: string;
      chapter_title: string;
    }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title FROM reading_history WHERE chapter_permalink IN (${placeholders})`,
      permalinks,
    ),
    query<{ cache_key: string; json_payload: string }>(
      `SELECT cache_key, json_payload FROM cached_metadata WHERE data_type = 'cover'`,
    ),
    query<{ chapter_permalink: string; file_path: string }>(
      `SELECT chapter_permalink, file_path FROM cached_pages WHERE page_index = 0 AND chapter_permalink IN (${placeholders})`,
      permalinks,
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

  const chapterInfoMap = new Map<
    string,
    { seriesPermalink: string; seriesName: string; chapterTitle: string }
  >();
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
        (seriesPermalink &&
          (coverMap.get(`series:${seriesPermalink}`) || coverMap.get(seriesPermalink))) ||
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

  // Exact disk footprint resolution. Directory stats for every group's candidate
  // paths are resolved in ONE `DirStatBatch` call instead of a per-group IPC
  // burst; the same applies to the exact-file fallback via `FileExistsBatch`.
  const dirProbe: { group: CachedSeriesGroup; candidates: string[] }[] = [];
  for (const g of groupMap.values()) {
    const clean = g.seriesPermalink.replace(/[^a-zA-Z0-9_-]/g, "_");
    dirProbe.push({
      group: g,
      candidates: g.isStandalone
        ? [`pages/_singles/${clean}`, `pages/${clean}`]
        : [`pages/${clean}`],
    });
  }

  const allDirPaths = [...new Set(dirProbe.flatMap((p) => p.candidates))];
  const dirResp = await PH.callService("DirStatBatch", { paths: allDirPaths });
  const dirBytesByPath = new Map<string, number>();
  for (const item of dirResp?.DirStatBatchResult?.items ?? []) {
    dirBytesByPath.set(item.path, Number(item.total_bytes ?? 0));
  }

  const fileProbe: { group: CachedSeriesGroup; filePaths: string[] }[] = [];
  for (const p of dirProbe) {
    let foundBytes = 0;
    for (const c of p.candidates) {
      const bytes = dirBytesByPath.get(c) ?? 0;
      if (bytes > 0) {
        foundBytes = bytes;
        break;
      }
    }
    if (foundBytes > 0) {
      p.group.totalSizeBytes = foundBytes;
      continue;
    }
    if (p.group.chapterPermalinks.length > 0) fileProbe.push({ group: p.group, filePaths: [] });
  }

  if (fileProbe.length > 0) {
    const filePathGroups = await Promise.all(
      fileProbe.map(async (p) => {
        const placeholders = p.group.chapterPermalinks.map(() => "?").join(",");
        const pathRows = await query<{ file_path: string }>(
          `SELECT file_path FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
          p.group.chapterPermalinks,
        );
        return { group: p.group, filePaths: pathRows.map((r) => r.file_path) };
      }),
    );
    const allFilePaths = [...new Set(filePathGroups.flatMap((f) => f.filePaths))];
    const fileResp = await PH.callService("FileExistsBatch", { paths: allFilePaths });
    const sizeByPath = new Map<string, number>();
    for (const item of fileResp?.FileExistsBatchResult?.items ?? []) {
      sizeByPath.set(item.path, Number(item.size_bytes ?? 0));
    }
    for (const f of filePathGroups) {
      f.group.totalSizeBytes = f.filePaths.reduce((sum, fp) => sum + (sizeByPath.get(fp) ?? 0), 0);
    }
  }

  return Array.from(groupMap.values()).sort((a, b) => b.lastCachedAt - a.lastCachedAt);
}

async function deleteFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await PH.callService("FileDelete", { path: p });
      } catch {}
    }),
  );
}

export async function clearCachedGroupPages(chapterPermalinks: string[]): Promise<void> {
  if (chapterPermalinks.length === 0) return;
  const placeholders = chapterPermalinks.map(() => "?").join(",");
  const rows = await query<{ file_path: string }>(
    `SELECT file_path FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
    chapterPermalinks,
  );
  await deleteFiles(rows.map((r) => r.file_path));
  await execute(
    `DELETE FROM cached_pages WHERE chapter_permalink IN (${placeholders})`,
    chapterPermalinks,
  );
}

export async function clearAllCachedPages(): Promise<void> {
  const rows = await query<{ file_path: string }>(`SELECT file_path FROM cached_pages`);
  await deleteFiles(rows.map((r) => r.file_path));
  await execute(`DELETE FROM cached_pages`);
}

export async function clearAllCachedCovers(): Promise<void> {
  const coverRows = await query<{ json_payload: string }>(
    `SELECT json_payload FROM cached_metadata WHERE data_type = 'cover'`,
  );
  await deleteFiles(coverRows.map((r) => r.json_payload));
  await execute(`DELETE FROM cached_metadata WHERE data_type = 'cover'`);
}

export async function clearAllCacheStorage(): Promise<void> {
  await clearAllCachedPages();
  await clearAllCachedCovers();
  await execute(`DELETE FROM cached_metadata`);
}

export interface FullyCachedChapterRow {
  chapterPermalink: string;
  chapterTitle: string;
  seriesPermalink: string | null;
  seriesName: string | null;
  pageCount: number;
  pageTotal: number;
  totalSizeBytes: number;
  lastCachedAt: number;
  coverPath: string | null;
  tags?: { type?: string; name?: string; permalink?: string }[];
}

export async function getFullyCachedChapters(): Promise<FullyCachedChapterRow[]> {
  const chapterRows = await query<{
    chapter_permalink: string;
    page_count: number;
    size_bytes: number;
    last_cached: number;
  }>(
    `SELECT chapter_permalink, COUNT(*) as page_count, SUM(COALESCE(size_bytes, 0)) as size_bytes, MAX(cached_at) as last_cached
     FROM cached_pages GROUP BY chapter_permalink`,
  );

  if (chapterRows.length === 0) return [];

  const permalinks = chapterRows.map((r) => r.chapter_permalink);
  const placeholders = permalinks.map(() => "?").join(",");

  const [progRows, histRows, metaChapterRows, page0Rows] = await Promise.all([
    query<{
      chapter_permalink: string;
      series_permalink: string;
      series_name: string;
      chapter_title: string;
      page_total: number;
    }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title, page_total FROM reading_progress WHERE chapter_permalink IN (${placeholders})`,
      permalinks,
    ),
    query<{
      chapter_permalink: string;
      series_permalink: string;
      series_name: string;
      chapter_title: string;
    }>(
      `SELECT chapter_permalink, series_permalink, series_name, chapter_title FROM reading_history WHERE chapter_permalink IN (${placeholders})`,
      permalinks,
    ),
    query<{ cache_key: string; json_payload: string }>(
      `SELECT cache_key, json_payload FROM cached_metadata WHERE data_type = 'chapter'`,
    ),
    query<{ chapter_permalink: string; file_path: string }>(
      `SELECT chapter_permalink, file_path FROM cached_pages WHERE page_index = 0 AND chapter_permalink IN (${placeholders})`,
      permalinks,
    ),
  ]);

  // Key-filtered cover lookup: only fetch the cover rows this page set can
  // actually use (series + chapter keys) instead of scanning every
  // `data_type='cover'` row in a table that also stores full cached bodies.
  const coverKeys = new Set<string>();
  for (const r of [...progRows, ...histRows]) {
    if (r.series_permalink) {
      coverKeys.add(`cover:series:${r.series_permalink}`);
      coverKeys.add(`cover:${r.series_permalink}`);
    }
  }
  for (const cp of permalinks) {
    coverKeys.add(`cover:chapter:${cp}`);
    coverKeys.add(`cover:${cp}`);
  }
  const coverKeyList = [...coverKeys];
  const metaCoverRows =
    coverKeyList.length === 0
      ? []
      : await query<{ cache_key: string; json_payload: string }>(
          `SELECT cache_key, json_payload FROM cached_metadata WHERE data_type = 'cover' AND cache_key IN (${coverKeyList
            .map(() => "?")
            .join(",")})`,
          coverKeyList,
        );

  const coverMap = new Map<string, string>();
  for (const m of metaCoverRows) {
    coverMap.set(m.cache_key.replace(/^cover:/, ""), m.json_payload);
  }

  const page0Map = new Map<string, string>();
  for (const p of page0Rows) {
    page0Map.set(p.chapter_permalink, p.file_path);
  }

  const chapterMetaMap = new Map<
    string,
    {
      title: string;
      pagesCount: number;
      seriesPermalink?: string;
      seriesName?: string;
      tags?: { type?: string; name?: string; permalink?: string }[];
    }
  >();
  for (const m of metaChapterRows) {
    try {
      const pl = m.cache_key.replace(/^chapter:/, "");
      const parsed = JSON.parse(m.json_payload);
      const seriesTag = (parsed.tags ?? []).find((t: any) => (t.type ?? "").toLowerCase() === "series");
      chapterMetaMap.set(pl, {
        title: parsed.title || pl,
        pagesCount: Array.isArray(parsed.pages) ? parsed.pages.length : 0,
        seriesPermalink: seriesTag?.permalink,
        seriesName: seriesTag?.name,
        tags: parsed.tags,
      });
    } catch {}
  }

  const progMap = new Map<
    string,
    { seriesPermalink: string; seriesName: string; chapterTitle: string; pageTotal: number }
  >();
  for (const r of progRows) {
    progMap.set(r.chapter_permalink, {
      seriesPermalink: r.series_permalink,
      seriesName: r.series_name,
      chapterTitle: r.chapter_title,
      pageTotal: Number(r.page_total || 0),
    });
  }

  const histMap = new Map<
    string,
    { seriesPermalink: string; seriesName: string; chapterTitle: string }
  >();
  for (const r of histRows) {
    histMap.set(r.chapter_permalink, {
      seriesPermalink: r.series_permalink,
      seriesName: r.series_name,
      chapterTitle: r.chapter_title,
    });
  }

  const result: FullyCachedChapterRow[] = [];

  for (const row of chapterRows) {
    const cp = row.chapter_permalink;
    const pageCount = Number(row.page_count);
    const meta = chapterMetaMap.get(cp);
    const prog = progMap.get(cp);
    const hist = histMap.get(cp);

    const totalPages = meta?.pagesCount || prog?.pageTotal || 0;
    const isFullyCached = totalPages > 0 ? pageCount >= totalPages : pageCount > 0;

    if (isFullyCached) {
      const seriesPermalink =
        meta?.seriesPermalink || prog?.seriesPermalink || hist?.seriesPermalink || null;
      const seriesName = meta?.seriesName || prog?.seriesName || hist?.seriesName || null;
      const chapterTitle = meta?.title || prog?.chapterTitle || hist?.chapterTitle || cp;
      const coverPath =
        (seriesPermalink &&
          (coverMap.get(`series:${seriesPermalink}`) || coverMap.get(seriesPermalink))) ||
        coverMap.get(`chapter:${cp}`) ||
        coverMap.get(cp) ||
        page0Map.get(cp) ||
        null;

      result.push({
        chapterPermalink: cp,
        chapterTitle,
        seriesPermalink,
        seriesName,
        pageCount,
        pageTotal: totalPages || pageCount,
        totalSizeBytes: Number(row.size_bytes),
        lastCachedAt: Number(row.last_cached),
        coverPath,
        tags: meta?.tags,
      });
    }
  }

  result.sort((a, b) => b.lastCachedAt - a.lastCachedAt);
  return result;
}

export async function getFullyCachedChapterPermalinks(): Promise<Set<string>> {
  const chapters = await getFullyCachedChapters();
  return new Set(chapters.map((c) => c.chapterPermalink));
}
