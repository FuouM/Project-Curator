import { execute } from "./client";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS followed_series (
    permalink TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cover TEXT,
    last_checked_at INTEGER NOT NULL,
    latest_chapter_permalink TEXT,
    latest_chapter_title TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_progress (
    chapter_permalink TEXT PRIMARY KEY,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    page_index INTEGER NOT NULL DEFAULT 0,
    page_total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_permalink TEXT NOT NULL,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    read_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    chapter_permalink TEXT PRIMARY KEY,
    series_permalink TEXT NOT NULL,
    series_name TEXT NOT NULL,
    chapter_title TEXT NOT NULL,
    page_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cached_metadata (
    cache_key TEXT PRIMARY KEY,
    data_type TEXT NOT NULL,
    json_payload TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    etag TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cached_pages (
    chapter_permalink TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (chapter_permalink, page_index)
  )`,
];

let initDbPromise: Promise<void> | null = null;

/** Creates all tables. Idempotent; safe to call on every load. */
export async function initDb(): Promise<void> {
  if (!initDbPromise) {
    initDbPromise = (async () => {
      for (const sql of SCHEMA) {
        await execute(sql, []);
      }
      try {
        await execute("ALTER TABLE cached_pages ADD COLUMN size_bytes INTEGER DEFAULT 0", []);
      } catch {}
      try {
        await execute("ALTER TABLE cached_metadata ADD COLUMN etag TEXT", []);
      } catch {}
      try {
        await execute("DROP INDEX IF EXISTS idx_reading_history_chapter", []);
      } catch {}
    })();
  }
  return initDbPromise;
}
