import { query, execute } from "./client";
import type { CachedMetadata } from "../types/db";

export async function getCached(key: string): Promise<CachedMetadata | null> {
  const rows = await query<CachedMetadata & { cache_key: string }>(
    `SELECT json_payload, cached_at, etag FROM cached_metadata WHERE cache_key = ?`,
    [key],
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
    keys,
  );
  for (const r of rows) {
    result.set(r.cache_key, r.json_payload);
  }
  return result;
}

export async function setCached(
  key: string,
  dataType: string,
  jsonPayload: string,
  etag?: string,
): Promise<void> {
  await execute(
    `INSERT INTO cached_metadata (cache_key, data_type, json_payload, cached_at, etag)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       data_type = excluded.data_type,
       json_payload = excluded.json_payload,
       cached_at = excluded.cached_at,
       etag = COALESCE(excluded.etag, cached_metadata.etag)`,
    [key, dataType, jsonPayload, Date.now(), etag ?? null],
  );
}

/** Updates the cached_at timestamp for a key without rewriting its payload or etag. */
export async function touchCached(key: string): Promise<void> {
  await execute(`UPDATE cached_metadata SET cached_at = ? WHERE cache_key = ?`, [Date.now(), key]);
}

/** Deletes a cached metadata record by key. */
export async function deleteCached(key: string): Promise<void> {
  await execute(`DELETE FROM cached_metadata WHERE cache_key = ?`, [key]);
}
