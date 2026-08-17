/**
 * Human-readable file size formatting.
 *
 * Converts a raw byte count into a string with the appropriate unit suffix.
 * All three existing plugins (ffmpeg-transcoder, image-compare, gif-maker)
 * carried near-identical copies of this function with minor guard and
 * precision differences. This is the unified canonical version.
 *
 * @param bytes    - Raw byte count. null / undefined / NaN are treated as
 *                   missing and return `fallback`.
 * @param fallback - Returned when bytes is missing or negative. Defaults to
 *                   an empty string. Pass "unknown size" where a label is
 *                   required even when metadata is absent.
 * @param decimals - Number of decimal places. Defaults to 2.
 *
 * @example
 * formatBytes(0)                    // "0 B"
 * formatBytes(1536)                 // "1.50 KB"
 * formatBytes(null, "unknown size") // "unknown size"
 * formatBytes(2097152, "", 1)       // "2.0 MB"
 */
export function formatBytes(bytes: number | null | undefined, fallback = "", decimals = 2): string {
  if (bytes == null || isNaN(bytes) || bytes < 0) return fallback;
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(decimals)} ${units[i] ?? "B"}`;
}
