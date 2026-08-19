import { absUrl, COVERS_PREFIX, SITE_ROOT } from "../state";
import { getCached, setCached, deleteCached, updateFollowedSeriesCover } from "../db";
import { httpGetText, httpDownload, fileDelete, fileExists } from "./client";
import { fetchChapter } from "./chapter";
import type { Series } from "../types/api";

const PH = window.PluginHost;

/** Series / anthology / doujin / author / tag detail. `force` skips the cache (used by the Refresh button). */
export async function fetchSeries(
  permalink: string,
  force = false,
  preferredType?: string,
): Promise<Series> {
  const key = `series:${permalink}`;
  if (!force) {
    const cached = await getCached(key);
    if (cached) return JSON.parse(cached.json_payload) as Series;
  }

  const typeMap: Record<string, string> = {
    series: `${SITE_ROOT}/series/${encodeURIComponent(permalink)}.json`,
    anthology: `${SITE_ROOT}/anthologies/${encodeURIComponent(permalink)}.json`,
    doujin: `${SITE_ROOT}/doujins/${encodeURIComponent(permalink)}.json`,
    doujinshi: `${SITE_ROOT}/doujins/${encodeURIComponent(permalink)}.json`,
    issue: `${SITE_ROOT}/issues/${encodeURIComponent(permalink)}.json`,
    author: `${SITE_ROOT}/authors/${encodeURIComponent(permalink)}.json`,
    artist: `${SITE_ROOT}/authors/${encodeURIComponent(permalink)}.json`,
    scanlator: `${SITE_ROOT}/scanlators/${encodeURIComponent(permalink)}.json`,
    group: `${SITE_ROOT}/scanlators/${encodeURIComponent(permalink)}.json`,
    pairing: `${SITE_ROOT}/pairings/${encodeURIComponent(permalink)}.json`,
    tag: `${SITE_ROOT}/tags/${encodeURIComponent(permalink)}.json`,
    general: `${SITE_ROOT}/tags/${encodeURIComponent(permalink)}.json`,
  };

  const defaultEndpoints = [
    `${SITE_ROOT}/series/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/anthologies/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/doujins/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/issues/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/authors/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/tags/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/pairings/${encodeURIComponent(permalink)}.json`,
    `${SITE_ROOT}/scanlators/${encodeURIComponent(permalink)}.json`,
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

  throw lastErr ?? new Error(`Failed to load series for permalink "${permalink}"`);
}

/**
 * Returns the on-disk absolute path of a series cover, downloading + transcoding
 * once into a lightweight WebP thumbnail (bounded dimension + <=100KB budget via
 * the backend media engine). Feed rows render at 42x58 and the series header at
 * 90px, so a small thumbnail keeps decode cheap while scrolling.
 */
export async function getSeriesCover(
  permalink: string,
  coverUrl: string | null,
): Promise<string | null> {
  if (!coverUrl) return null;
  const key = `cover:${permalink}`;
  const cached = await getCached(key);
  if (cached && cached.json_payload) {
    // The cached path may point at a file that was purged (e.g. "Clear Cached
    // Covers"). Verify on disk before trusting it; purge + refetch when stale.
    try {
      if (await fileExists(cached.json_payload)) return cached.json_payload;
    } catch {}
    await deleteCached(key);
  }
  const extMatch = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(coverUrl);
  const ext = extMatch ? extMatch[1] : "jpg";
  const tmpOutPath = `${COVERS_PREFIX}/raw_${permalink}.${ext}`;
  const webpOutPath = `${COVERS_PREFIX}/${permalink}.webp`;

  // 1. Download the original cover.
  const absRawPath = await httpDownload(absUrl(coverUrl), tmpOutPath, 30000);

  // 2. Transcode to a bounded, size-capped WebP thumbnail via backend media engine.
  let finalPath = absRawPath;
  try {
    const convResp = await PH.callService("EphemeralConvertImages", {
      quality: 75,
      max_dimension: 256,
      max_bytes: 100_000,
      conversions: [[tmpOutPath, webpOutPath]],
    });
    const results = convResp?.ConvertImagesResult?.converted;
    if (results && results.length > 0 && results[0].output_path && !results[0].error) {
      finalPath = results[0].output_path;
      // Clean up the bulky raw download.
      try {
        await fileDelete(tmpOutPath);
      } catch {}
    }
  } catch (err) {
    console.warn("Failed to transcode series cover to WebP, keeping raw download:", err);
  }

  await setCached(key, "cover", finalPath);
  return finalPath;
}

/**
 * Ensures a followed series' stored cover path still points at a real file.
 * Cache clears delete the cover file but leave `followed_series.cover`
 * stale; when the path is gone, refetch the thumbnail and persist the new
 * path so the Library never renders a dead image.
 */
export async function refreshFollowedSeriesCover(
  permalink: string,
  currentCover: string | null,
): Promise<string | null> {
  if (currentCover) {
    try {
      if (await fileExists(currentCover)) return currentCover;
    } catch {}
  }
  const fresh = await getOrHydrateSeriesCover(permalink);
  if (fresh) {
    try {
      await updateFollowedSeriesCover(permalink, fresh);
    } catch {
      // The DB write must never break cover rendering; the fresh path still wins.
    }
  }
  return fresh;
}

/**
 * Checks local SQLite cache for an already-downloaded cover (series, doujin, or standalone chapter).
 * Also verifies the cached file actually exists on disk; if missing, purges the stale DB record.
 */
export async function getLocalCover(coverKey: string): Promise<string | null> {
  if (!coverKey) return null;
  const key = `cover:${coverKey}`;
  const cached = await getCached(key);
  if (!cached || !cached.json_payload) return null;

  // Verify file still exists on disk
  try {
    const resp = await PH.callService("FileExists", { path: cached.json_payload });
    if (resp?.FileExistsResult?.exists) {
      return cached.json_payload;
    }
  } catch {}

  // File is missing or deleted from disk; clean up stale database entry
  await deleteCached(key);
  return null;
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
export async function getChapterCover(
  permalink: string,
  firstPageUrl: string,
): Promise<string | null> {
  if (!firstPageUrl) return null;
  const key = `cover:chapter:${permalink}`;
  const cached = await getCached(key);
  if (cached && cached.json_payload) {
    try {
      if (await fileExists(cached.json_payload)) return cached.json_payload;
    } catch {}
    await deleteCached(key);
  }

  const extMatch = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(firstPageUrl);
  const ext = extMatch ? extMatch[1] : "jpg";
  const tmpOutPath = `${COVERS_PREFIX}/raw_ch_${permalink}.${ext}`;
  const webpOutPath = `${COVERS_PREFIX}/ch_${permalink}.webp`;

  // 1. Download raw first page
  const absRawPath = await httpDownload(absUrl(firstPageUrl), tmpOutPath, 30000);

  // 2. Transcode to WebP thumbnail via backend media engine (bounded + <=100KB)
  let finalPath = absRawPath;
  try {
    const convResp = await PH.callService("EphemeralConvertImages", {
      quality: 75,
      max_dimension: 256,
      max_bytes: 100_000,
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
export async function getOrHydrateSeriesCover(
  permalink: string,
  seriesType?: string | null,
): Promise<string | null> {
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
  seriesType?: string | null,
): Promise<string | null> {
  if (!coverKey) return null;
  const local = await getLocalCover(coverKey);
  if (local) return local;

  // 1. If it has a series cover key and series permalink, try fetching series cover
  if (coverKey.startsWith("series:") && seriesOrGroupPermalink) {
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
