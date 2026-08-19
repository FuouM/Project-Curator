import type { GetTextOptions, HttpResponseText } from "../types/api";
import { getCached, setCached } from "../db";
import { recordNetworkTraffic, recordCacheHit } from "./traffic";

const PH = window.PluginHost;

/** Fetches a text/JSON payload via the service. Throws on service error. */
export async function httpGetText(
  url: string,
  opts: GetTextOptions = {},
): Promise<HttpResponseText> {
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
  const status = Number(resp?.HttpGetResult?.status ?? 0);
  const body = String(resp?.HttpGetResult?.body ?? "");
  const etag = resp?.HttpGetResult?.etag ? String(resp.HttpGetResult.etag) : undefined;
  if (status === 200 && body) {
    recordNetworkTraffic(body.length);
  }
  return { status, body, etag };
}

/**
 * Downloads a binary payload to the plugin's on-disk cache and returns the
 * resolved absolute path (suitable for `PluginHost.convertFileSrc`).
 */
export async function httpDownload(
  url: string,
  outputPath: string,
  timeoutMs = 30000,
): Promise<string> {
  const resp = await PH.callService("HttpDownload", {
    url,
    output_path: outputPath,
    timeout_ms: timeoutMs,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  const sizeBytes = Number(resp?.HttpDownloadResult?.size_bytes ?? 0);
  if (sizeBytes > 0) recordNetworkTraffic(sizeBytes);
  return String(resp?.HttpDownloadResult?.absolute_path ?? "");
}

/**
 * Downloads a binary payload to the plugin's on-disk cache and returns both the
 * resolved absolute path and the exact written size in bytes.
 */
export async function httpDownloadFull(
  url: string,
  outputPath: string,
  timeoutMs = 30000,
): Promise<{ absolutePath: string; sizeBytes: number }> {
  const resp = await PH.callService("HttpDownload", {
    url,
    output_path: outputPath,
    timeout_ms: timeoutMs,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  const sizeBytes = Number(resp?.HttpDownloadResult?.size_bytes ?? 0);
  if (sizeBytes > 0) recordNetworkTraffic(sizeBytes);
  return {
    absolutePath: String(resp?.HttpDownloadResult?.absolute_path ?? ""),
    sizeBytes,
  };
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

/** Cache-first JSON getter: returns a fresh non-expired copy or fetches + stores. */
export async function cachedJson<T>(key: string, url: string, ttlMs?: number): Promise<T> {
  const cached = await getCached(key);
  if (cached && (ttlMs === undefined || Date.now() - cached.cached_at < ttlMs)) {
    recordCacheHit(cached.json_payload.length);
    return JSON.parse(cached.json_payload) as T;
  }
  const { status, body, etag } = await httpGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  await setCached(key, key.split(":")[0], body, etag);
  return JSON.parse(body) as T;
}
