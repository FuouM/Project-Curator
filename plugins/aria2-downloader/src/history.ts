/**
 * Download history store + duplicate-URL detector for the aria2-downloader
 * plugin.
 *
 * Persists completed downloads to the plugin's isolated SQLite database
 * (`.curator/plugin_data/aria2-downloader/download_history.db`) through the
 * curator-provided generic `PluginDbQuery` / `PluginDbExecute` primitives
 * (§3.4 C) - completely decoupled from Curator's core `curator.db`. The
 * frontend never touches SQLite directly.
 *
 * `normalized_url` = lowercase scheme+host+path with the fragment stripped and
 * tracking params removed, so dedup is deterministic regardless of the URL
 * variant pasted.
 *
 * Ported from `ff8fd40:plugins/pyload-downloader/src/history.ts`.
 */

import { dbExecute, dbQuery } from "./ipc";

export interface HistoryRecord {
  id: number;
  url: string;
  normalized_url: string;
  filename: string;
  file_path: string;
  file_size: number;
  status: "completed" | "failed" | "cancelled";
  error_message: string | null;
  completed_at: number;
  package_name: string | null;
}

/** Tracking query params stripped from URLs before dedup comparison. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "referrer",
  "spm",
]);

export function normalizeUrl(rawUrl: string): string {
  let out: string;
  try {
    const u = new URL(rawUrl.trim());
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    out = u.toString();
  } catch {
    out = rawUrl.trim();
  }
  return out.toLowerCase();
}

export async function ensureHistorySchema(): Promise<void> {
  await dbExecute(`CREATE TABLE IF NOT EXISTS download_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_message TEXT,
    completed_at INTEGER NOT NULL,
    package_name TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbExecute(
    `CREATE INDEX IF NOT EXISTS idx_download_history_url ON download_history(normalized_url)`
  );
  await dbExecute(
    `CREATE INDEX IF NOT EXISTS idx_download_history_completed ON download_history(completed_at DESC)`
  );
  await dbExecute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_download_history_url_path ON download_history(normalized_url, file_path)`
  );
}

export async function recordDownload(
  rec: Omit<HistoryRecord, "id" | "created_at">
): Promise<void> {
  await dbExecute(
    `INSERT OR IGNORE INTO download_history
      (url, normalized_url, filename, file_path, file_size, status, error_message, completed_at, package_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.url,
      rec.normalized_url,
      rec.filename,
      rec.file_path,
      rec.file_size,
      rec.status,
      rec.error_message,
      rec.completed_at || Math.floor(Date.now() / 1000),
      rec.package_name,
    ]
  );
}

export async function queryHistory(
  limit = 200,
  offset = 0
): Promise<HistoryRecord[]> {
  const res = await dbQuery(
    `SELECT * FROM download_history ORDER BY completed_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return (res.rows as unknown as HistoryRecord[]) ?? [];
}

export async function searchHistory(term: string, limit = 200): Promise<HistoryRecord[]> {
  const res = await dbQuery(
    `SELECT * FROM download_history
     WHERE url LIKE ? OR filename LIKE ? OR package_name LIKE ?
     ORDER BY completed_at DESC LIMIT ?`,
    [`%${term}%`, `%${term}%`, `%${term}%`, limit]
  );
  return (res.rows as unknown as HistoryRecord[]) ?? [];
}

/**
 * Returns the subset of `urls` already recorded. Used by the dedup engine to
 * flag "Already Downloaded" before a URL is re-submitted.
 */
export async function findDuplicateUrls(urls: string[]): Promise<string[]> {
  const normalized = urls.map(normalizeUrl);
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => "?").join(",");
  const res = await dbQuery(
    `SELECT normalized_url FROM download_history WHERE normalized_url IN (${placeholders})`,
    normalized
  );
  const seen = new Set(res.rows.map((r) => String(r.normalized_url)));
  return normalized.filter((n) => seen.has(n));
}

export async function removeHistoryEntry(id: number): Promise<void> {
  await dbExecute(`DELETE FROM download_history WHERE id = ?`, [id]);
}
