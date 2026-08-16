import type {
  GetTextOptions,
  HttpResponseText,
  DirStatResult,
} from "../types/api";
import { getCached, setCached } from "../db";

const PH = window.PluginHost;

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

/** Cache-first JSON getter: returns a fresh non-expired copy or fetches + stores. */
export async function cachedJson<T>(key: string, url: string, ttlMs?: number): Promise<T> {
  const cached = await getCached(key);
  if (cached && (ttlMs === undefined || Date.now() - cached.cached_at < ttlMs)) {
    return JSON.parse(cached.json_payload) as T;
  }
  const { status, body, etag } = await httpGetText(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
  await setCached(key, key.split(":")[0], body, etag);
  return JSON.parse(body) as T;
}