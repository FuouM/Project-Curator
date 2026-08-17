/**
 * Date/time formatting helpers. `formatBytes` lives in the shared plugin
 * library (`plugins/lib/format.ts`) and is not re-implemented here.
 */

/** Formats a unix-ms timestamp as a short date. */
export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Formats a unix-ms timestamp as a full date and time. */
export function formatDateTime(ms?: number | null): string {
  if (!ms) return "Never";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
    2,
    "0",
  )}:${String(d.getSeconds()).padStart(2, "0")}`;
}
