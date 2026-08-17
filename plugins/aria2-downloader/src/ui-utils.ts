/**
 * Pure formatting/path helpers shared by the aria2-downloader modules.
 *
 * No DOM or IPC access here - these are deterministic string/number
 * transforms used by the queue table, history table, and status banner.
 */

import { formatBytes } from "../../lib";

/** Join an absolute directory and a file name with the OS separator. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
  return `${dir}${sep}${name}`;
}

/**
 * Accept only real absolute paths from the backend (drive letter, UNC, or
 * leading-slash) so a garbage token such as a bare percent can never reach the
 * queue output path, history store, or Explorer reveal action.
 */
export function isAbsolutePath(p: string | null | undefined): boolean {
  if (!p) return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** Format seconds as `2h 3m`, `1m 15s`, or `38s`. */
export function formatEta(secs: number | null): string {
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format a byte rate as `1.5 MB/s`. */
export function formatRate(bps: number): string {
  if (!bps) return "0 B/s";
  return `${formatBytes(bps, "0 B", 1)}/s`;
}

/** Extract the hoster (hostname without `www.`) from a URL. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    const head = url.split(/[\\/]/)[0];
    return head || url;
  }
}

export function formatDateTime(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(startedAt: number, completedAt: number): string {
  const s = Math.max(0, Math.round((completedAt - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function clampNum(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}
