import { SITE_ROOT } from "../state";
import { getCached, setCached, touchCached } from "../db";
import { httpGetText } from "./client";
import { recordCacheHit } from "./traffic";
import type { Feed, FeedRevalidationResult, RevalidateOnlineResult } from "../types/api";

export const FEED_TTL_MS = 60 * 60 * 1000;

/**
 * Checks Dynasty Scans online using ETag If-None-Match.
 * Returns 304 (unchanged) or 200 (fresh data).
 */
export async function checkFeedOnline(
  urlPath: string,
  key: string,
  etag?: string,
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
  key: string,
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
      recordCacheHit(cached.json_payload.length);
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
