/**
 * Thin localStorage persistence helpers for plugin settings.
 *
 * Several plugins (image-converter, ffmpeg-transcoder, minipaint) carried
 * near-identical `localStorage.getItem(key) || ""` reads and
 * `localStorage.setItem(key, value)` writes for their persisted output
 * directory. These two functions are the canonical shared version; they add
 * nothing beyond explicit names and a safe fallback.
 */

/**
 * Reads a persisted string value, falling back to `fallback` when the key is
 * absent (or localStorage is unavailable).
 */
export function loadPersisted(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

/** Persists a string value (no-op when localStorage is unavailable). */
export function savePersisted(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable (e.g. sandboxed webview); the in-memory value
    // still lives in the plugin's state object for the session.
  }
}
