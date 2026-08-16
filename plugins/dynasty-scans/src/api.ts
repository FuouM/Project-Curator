/**
 * Transport + cache-first data access for the dynasty-scans plugin.
 *
 * All network traffic goes through the two generic service commands added for
 * plugins (`HttpGet` / `HttpDownload`); the WebView never fetches the site
 * directly (no CORS headers, hotlink-protected images). Metadata hits are
 * pure SQLite reads via db.ts.
 */

import {
  absUrl,
  COVERS_PREFIX,
  PAGES_PREFIX,
  SITE_ROOT,
} from "./state";
import { getCached, setCached, touchCached } from "./db";

const PH = window.PluginHost;

// ---------------------------------------------------------------------------
// Remote JSON shapes (verified live 2026-08-16)
// ---------------------------------------------------------------------------

export interface ChapterTag {
  type: string;
  name: string;
  permalink: string;
}

export interface ChapterPage {
  name: string;
  url: string;
}

export interface Chapter {
  title: string;
  long_title: string;
  permalink: string;
  tags: ChapterTag[];
  pages: ChapterPage[];
  released_on?: string;
  added_on?: string;
}

export interface SeriesTag {
  type: string;
  name: string;
  permalink: string;
}

export interface SeriesTaggings {
  header?: string;
  title?: string;
  permalink?: string;
  released_on?: string;
  tags?: SeriesTag[];
}

export interface Series {
  name: string;
  type: string;
  permalink: string;
  tags: SeriesTag[];
  cover: string | null;
  link: string | null;
  description: string | null;
  aliases: string[];
  taggings: SeriesTaggings[];
}

export interface FeedChapter {
  title: string;
  series: string;
  permalink: string;
  tags: SeriesTag[];
}

export interface Feed {
  chapters: FeedChapter[];
  current_page: number;
  total_pages: number;
}

export interface DirectoryEntry {
  name: string;
  permalink: string;
}

export interface Directory {
  tags: Record<string, DirectoryEntry[]>[];
  current_page: number;
  total_pages: number;
}

export interface SuggestResult {
  id: number;
  name: string;
  type: string;
}

/** Normalized, ordered letter → entries groups from a directory payload. */
export interface DirectoryGroup {
  letter: string;
  entries: DirectoryEntry[];
}

export function directoryGroups(d: Directory): DirectoryGroup[] {
  return (d?.tags ?? []).map((obj) => {
    const letter = Object.keys(obj)[0] ?? "?";
    return { letter, entries: obj[letter] ?? [] };
  });
}

// ---------------------------------------------------------------------------
// Raw transport
// ---------------------------------------------------------------------------

export interface GetTextOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface HttpResponseText {
  status: number;
  body: string;
  etag?: string;
}

/** Fetches a text/JSON payload via the service. Throws on service error. */
export async function httpGetText(url: string, opts: GetTextOptions = {}): Promise<HttpResponseText> {
  const params: Record<string, unknown> = {
    url,
    timeout_ms: opts.timeoutMs ?? 15000,
  };
  if (opts.method === "POST") {
    params.method = "POST";
    params.body = opts.body ?? "";
    params.content_type = opts.contentType ?? "application/x-www-form-urlencoded";
  }
  if (opts.headers) {
    params.headers = opts.headers;
  }
  const resp = await PH.callService("HttpGet", params);
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return {
    status: Number(resp?.HttpGetResult?.status ?? 0),
    body: String(resp?.HttpGetResult?.body ?? ""),
    etag: resp?.HttpGetResult?.etag ? String(resp.HttpGetResult.etag) : undefined,
  };
}

/** Fetches and JSON-parses a service response; non-200 throws. */
export async function httpGetJson<T>(url: string, opts: GetTextOptions = {}): Promise<T> {
  const { status, body } = await httpGetText(url, opts);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  return JSON.parse(body) as T;
}

/**
 * Downloads a binary payload to the plugin's on-disk cache and returns the
 * resolved absolute path (suitable for `PluginHost.convertFileSrc`).
 */
export async function httpDownload(
  url: string,
  outputPath: string,
  timeoutMs = 30000
): Promise<string> {
  const resp = await PH.callService("HttpDownload", {
    url,
    output_path: outputPath,
    timeout_ms: timeoutMs,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return String(resp?.HttpDownloadResult?.absolute_path ?? "");
}

/**
 * Downloads a binary payload to the plugin's on-disk cache and returns both the
 * resolved absolute path and the exact written size in bytes.
 */
export async function httpDownloadFull(
  url: string,
  outputPath: string,
  timeoutMs = 30000
): Promise<{ absolutePath: string; sizeBytes: number }> {
  const resp = await PH.callService("HttpDownload", {
    url,
    output_path: outputPath,
    timeout_ms: timeoutMs,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return {
    absolutePath: String(resp?.HttpDownloadResult?.absolute_path ?? ""),
    sizeBytes: Number(resp?.HttpDownloadResult?.size_bytes ?? 0),
  };
}

export interface DirStatResult {
  totalBytes: number;
  fileCount: number;
}

/**
 * Calculates recursive on-disk byte footprint and file count for a directory
 * in the plugin's data folder.
 */
export async function dirStat(path = ""): Promise<DirStatResult> {
  try {
    const resp = await PH.callService("DirStat", { path });
    if (resp?.DirStatResult) {
      return {
        totalBytes: Number(resp.DirStatResult.total_bytes ?? 0),
        fileCount: Number(resp.DirStatResult.file_count ?? 0),
      };
    }
  } catch {}
  return { totalBytes: 0, fileCount: 0 };
}

/**
 * Resolves a plugin-relative path to its absolute path if the file exists and is non-empty.
 * Returns null if the file is absent, empty, or the path escapes the plugin data dir.
 */
export async function fileResolve(path: string): Promise<string | null> {
  const resp = await PH.callService("FileExists", { path });
  if (resp?.Error || !resp?.FileExistsResult?.exists) return null;
  return String(resp.FileExistsResult.absolute_path);
}

/** Returns true if the file exists on disk in the plugin's data dir and is non-empty. */
export async function fileExists(path: string): Promise<boolean> {
  return (await fileResolve(path)) !== null;
}

/** Renames/moves a file within the plugin's data dir. Returns the new absolute path. */
export async function fileMove(src: string, dst: string): Promise<string> {
  const resp = await PH.callService("FileMove", { src, dst });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return String(resp?.FileMoveResult?.absolute_path ?? "");
}

/** Deletes a file within the plugin's data dir. */
export async function fileDelete(path: string): Promise<void> {
  const resp = await PH.callService("FileDelete", { path });
  if (resp?.Error) throw new Error(String(resp.Error.message));
}

// ---------------------------------------------------------------------------
// Domain data (cache-first)
// ---------------------------------------------------------------------------

async function cachedJson<T>(key: string, url: string, ttlMs?: number): Promise<T> {
  const cached = await getCached(key);
  if (cached && (ttlMs === undefined || Date.now() - cached.cached_at < ttlMs)) {
    return JSON.parse(cached.json_payload) as T;
  }
  const { status, body, etag } = await httpGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  await setCached(key, key.split(":")[0], body, etag);
  return JSON.parse(body) as T;
}

/** Chapter detail (pages + tags). Cached forever; refreshed manually if needed. */
export function fetchChapter(permalink: string): Promise<Chapter> {
  return cachedJson<Chapter>(`chapter:${permalink}`, `${SITE_ROOT}/chapters/${permalink}.json`);
}

/** Series / anthology / doujin detail. `force` skips the cache (used by the Refresh button). */
export async function fetchSeries(permalink: string, force = false, preferredType?: string): Promise<Series> {
  const key = `series:${permalink}`;
  if (!force) {
    const cached = await getCached(key);
    if (cached) return JSON.parse(cached.json_payload) as Series;
  }
  const typeMap: Record<string, string> = {
    series: `${SITE_ROOT}/series/${permalink}.json`,
    anthology: `${SITE_ROOT}/anthologies/${permalink}.json`,
    doujin: `${SITE_ROOT}/doujins/${permalink}.json`,
    doujinshi: `${SITE_ROOT}/doujins/${permalink}.json`,
    issue: `${SITE_ROOT}/issues/${permalink}.json`,
  };

  const defaultEndpoints = [
    `${SITE_ROOT}/series/${permalink}.json`,
    `${SITE_ROOT}/anthologies/${permalink}.json`,
    `${SITE_ROOT}/doujins/${permalink}.json`,
    `${SITE_ROOT}/issues/${permalink}.json`,
  ];

  const preferredUrl = preferredType ? typeMap[preferredType.toLowerCase()] : undefined;
  const endpoints = preferredUrl
    ? [preferredUrl, ...defaultEndpoints.filter((u) => u !== preferredUrl)]
    : defaultEndpoints;

  let lastErr: Error | null = null;
  for (const url of endpoints) {
    try {
      const { status, body, etag } = await httpGetText(url);
      if (status === 200 && body) {
        await setCached(key, "series", body, etag);
        return JSON.parse(body) as Series;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error(`Failed to load ${permalink}`);
}

const FEED_TTL_MS = 60 * 60 * 1000;

export interface FeedRevalidationResult {
  data: Feed;
  isStale: boolean;
  cachedAt?: number;
  etag?: string;
  source: "sqlite" | "network";
  revalidatePromise?: Promise<{ data: Feed; isNew: boolean; etag?: string } | null>;
}

export interface RevalidateOnlineResult {
  status: number;
  data?: Feed;
  etag?: string;
  isNew: boolean;
}

/**
 * Checks Dynasty Scans online using ETag If-None-Match.
 * Returns 304 (unchanged) or 200 (fresh data).
 */
export async function checkFeedOnline(
  urlPath: string,
  key: string,
  etag?: string
): Promise<RevalidateOnlineResult> {
  const url = SITE_ROOT + urlPath;
  const headers: Record<string, string> = {};
  if (etag) {
    headers["If-None-Match"] = etag;
  }
  const resp = await httpGetText(url, { headers });
  if (resp.status === 304) {
    await touchCached(key);
    return { status: 304, isNew: false, etag };
  }
  if (resp.status === 200 && resp.body) {
    const freshData = JSON.parse(resp.body) as Feed;
    await setCached(key, "feed", resp.body, resp.etag);
    return { status: 200, data: freshData, isNew: true, etag: resp.etag };
  }
  return { status: resp.status, isNew: false };
}

/**
 * Stale-While-Revalidate feed fetcher:
 * 1. Returns cached SQLite feed data immediately (0ms blocking).
 * 2. If data is stale, silently dispatches a background ETag request (`If-None-Match`).
 * 3. If server returns 304 Not Modified, updates timestamp with 0 bytes transferred.
 * 4. If server returns 200 OK with new chapters, resolves revalidatePromise with new Feed.
 */
export async function fetchFeedWithRevalidation(
  urlPath: string,
  key: string
): Promise<FeedRevalidationResult> {
  const url = SITE_ROOT + urlPath;
  const cached = await getCached(key);
  const isStale = !cached || Date.now() - cached.cached_at >= FEED_TTL_MS;

  if (cached) {
    let parsed: Feed | null = null;
    try {
      parsed = JSON.parse(cached.json_payload) as Feed;
    } catch {}

    if (parsed) {
      if (!isStale) {
        return {
          data: parsed,
          isStale: false,
          cachedAt: cached.cached_at,
          etag: cached.etag,
          source: "sqlite",
        };
      }

      const revalidatePromise = (async () => {
        try {
          const res = await checkFeedOnline(urlPath, key, cached.etag);
          if (res.status === 200 && res.data) {
            return { data: res.data, isNew: true, etag: res.etag };
          }
        } catch (err) {
          console.warn("Background feed revalidation failed:", err);
        }
        return null;
      })();

      return {
        data: parsed,
        isStale: true,
        cachedAt: cached.cached_at,
        etag: cached.etag,
        source: "sqlite",
        revalidatePromise,
      };
    }
  }

  // No cache present: fetch directly
  const resp = await httpGetText(url);
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status} for ${url}`);
  const freshData = JSON.parse(resp.body) as Feed;
  await setCached(key, "feed", resp.body, resp.etag);
  return {
    data: freshData,
    isStale: false,
    cachedAt: Date.now(),
    etag: resp.etag,
    source: "network",
  };
}

/** Recent releases / recently added feeds, cached for one hour. */
export function fetchFeed(urlPath: string, key: string): Promise<Feed> {
  return cachedJson<Feed>(key, SITE_ROOT + urlPath, FEED_TTL_MS);
}

/** Series / tag directories, cached for one hour. */
export function fetchDirectory(urlPath: string, key: string): Promise<Directory> {
  return cachedJson<Directory>(key, SITE_ROOT + urlPath, FEED_TTL_MS);
}

/** Search typeahead suggestions. */
export async function suggest(query: string): Promise<SuggestResult[]> {
  const { status, body } = await httpGetText(`${SITE_ROOT}/tags/suggest`, {
    method: "POST",
    body: `query=${encodeURIComponent(query)}`,
  });
  if (status !== 200) throw new Error(`HTTP ${status} for /tags/suggest`);
  return JSON.parse(body) as SuggestResult[];
}

/** Returns the on-disk absolute path of a series cover, downloading once. */
export async function getSeriesCover(permalink: string, coverUrl: string | null): Promise<string | null> {
  if (!coverUrl) return null;
  const key = `cover:${permalink}`;
  const cached = await getCached(key);
  if (cached && cached.json_payload) return cached.json_payload;
  const extMatch = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(coverUrl);
  const ext = extMatch ? extMatch[1] : "jpg";
  const outPath = `${COVERS_PREFIX}/${permalink}.${ext}`;
  const absPath = await httpDownload(absUrl(coverUrl), outPath, 30000);
  await setCached(key, "cover", absPath);
  return absPath;
}

/**
 * Checks local SQLite cache for an already-downloaded cover (series, doujin, or standalone chapter).
 */
export async function getLocalCover(coverKey: string): Promise<string | null> {
  if (!coverKey) return null;
  const key = `cover:${coverKey}`;
  const cached = await getCached(key);
  return cached?.json_payload ?? null;
}

/**
 * Checks local SQLite cache for an already-downloaded series cover. Zero network traffic.
 */
export async function getLocalSeriesCover(permalink: string): Promise<string | null> {
  return getLocalCover(`series:${permalink}`);
}

/**
 * Downloads page 1 of a standalone chapter as its cover, automatically
 * optimizing and compressing it into a lightweight WebP thumbnail via the backend media engine.
 */
export async function getChapterCover(permalink: string, firstPageUrl: string): Promise<string | null> {
  if (!firstPageUrl) return null;
  const key = `cover:chapter:${permalink}`;
  const cached = await getCached(key);
  if (cached && cached.json_payload) return cached.json_payload;

  const extMatch = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(firstPageUrl);
  const ext = extMatch ? extMatch[1] : "jpg";
  const tmpOutPath = `${COVERS_PREFIX}/raw_ch_${permalink}.${ext}`;
  const webpOutPath = `${COVERS_PREFIX}/ch_${permalink}.webp`;

  // 1. Download raw first page
  const absRawPath = await httpDownload(absUrl(firstPageUrl), tmpOutPath, 30000);

  // 2. Transcode to WebP thumbnail via backend media engine
  let finalPath = absRawPath;
  try {
    const convResp = await PH.callService("EphemeralConvertImages", {
      quality: 75,
      conversions: [[tmpOutPath, webpOutPath]],
    });
    const results = convResp?.ConvertImagesResult?.converted;
    if (results && results.length > 0 && results[0].output_path && !results[0].error) {
      finalPath = results[0].output_path;
      // Clean up bulky raw download
      try {
        await fileDelete(tmpOutPath);
      } catch {}
    }
  } catch (err) {
    console.warn("Failed to transcode cover to WebP, keeping raw download:", err);
  }

  await setCached(key, "cover", finalPath);
  return finalPath;
}

/**
 * Opportunistic local-first + lazy background cover hydration for a series.
 */
export async function getOrHydrateSeriesCover(permalink: string, seriesType?: string | null): Promise<string | null> {
  if (!permalink) return null;
  const local = await getLocalSeriesCover(permalink);
  if (local) return local;

  // Check if series metadata is already cached
  const seriesCached = await getCached(`series:${permalink}`);
  let coverUrl: string | null = null;
  if (seriesCached?.json_payload) {
    try {
      const s = JSON.parse(seriesCached.json_payload) as Series;
      coverUrl = s.cover;
    } catch {}
  }

  if (!coverUrl) {
    try {
      const s = await fetchSeries(permalink, false, seriesType || undefined);
      coverUrl = s.cover;
    } catch {
      return null;
    }
  }

  if (!coverUrl) return null;
  return getSeriesCover(permalink, coverUrl);
}

/**
 * Opportunistic local-first + lazy background cover hydration for any feed item.
 * 1. Checks SQLite for existing cover.
 * 2. If series/doujin permalink provided, downloads series cover.
 * 3. Fallback for standalone chapters / oneshots: loads chapter page 1 as cover art.
 */
export async function getOrHydrateItemCover(
  coverKey: string,
  chapterPermalink: string,
  seriesOrGroupPermalink?: string | null,
  seriesType?: string | null
): Promise<string | null> {
  if (!coverKey) return null;
  const local = await getLocalCover(coverKey);
  if (local) return local;

  // 1. If it has a series or doujin/anthology permalink, try fetching series cover
  if (seriesOrGroupPermalink) {
    const seriesCover = await getOrHydrateSeriesCover(seriesOrGroupPermalink, seriesType);
    if (seriesCover) {
      await setCached(`cover:${coverKey}`, "cover", seriesCover);
      return seriesCover;
    }
  }

  // 2. Standalone chapter / oneshot fallback: fetch chapter metadata and use Page 1
  try {
    const ch = await fetchChapter(chapterPermalink);
    if (ch?.pages && ch.pages.length > 0 && ch.pages[0].url) {
      const page1Cover = await getChapterCover(chapterPermalink, ch.pages[0].url);
      if (page1Cover) {
        await setCached(`cover:${coverKey}`, "cover", page1Cover);
        return page1Cover;
      }
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// Browser delegation + direct URL parsing
// ---------------------------------------------------------------------------

/** Opens a URL in the user's default browser via the Tauri opener plugin. */
export async function openExternal(url: string): Promise<void> {
  const api = window.__TAURI__?.core;
  if (api?.invoke) {
    try {
      await api.invoke("plugin:opener|open_url", { url });
      return;
    } catch {
      // fall through to window.open below
    }
  }
  window.open(url, "_blank", "noopener");
}

export interface ParsedDynastyUrl {
  kind: "series" | "chapter";
  permalink: string;
}

/** Extracts a series/chapter permalink from a dynasty-scans.com URL. */
export function parseDynastyUrl(input: string): ParsedDynastyUrl | null {
  const t = input.trim().replace(/\/+$/, "");
  const m = /^https?:\/\/(?:www\.)?dynasty-scans\.com\/(series|chapters|anthologies|doujins|issues)\/([^\/?#]+)$/i.exec(t);
  if (!m) return null;
  let permalink = m[2];
  if (permalink.toLowerCase().endsWith(".json")) permalink = permalink.slice(0, -5);
  return { kind: m[1].toLowerCase() === "chapters" ? "chapter" : "series", permalink };
}

/** Builds the on-disk output path for a chapter page image. */
export function pageOutputPath(
  seriesPermalink: string,
  chapterPermalink: string,
  pageIndex: number,
  pageUrl: string
): string {
  const cleanSeries = (seriesPermalink || "_singles").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanChapter = (chapterPermalink || "chapter").replace(/[^a-zA-Z0-9_-]/g, "_");
  const ext = pageUrl.split(".").pop()?.split("?")[0] || "webp";
  const pad = String(pageIndex + 1).padStart(4, "0");
  return `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/page_${pad}.${ext}`;
}