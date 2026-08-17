import { PAGES_PREFIX } from "../state";
import type { ParsedDynastyUrl } from "../types/api";

/**
 * Opens a URL in the user's default browser via the dashboard's
 * `PluginHost.system.openUrl` bridge (which delegates to the Tauri opener).
 */
export async function openExternal(url: string): Promise<void> {
  try {
    await window.PluginHost.system.openUrl(url);
    return;
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** Extracts a series/chapter permalink from a dynasty-scans.com URL. */
export function parseDynastyUrl(input: string): ParsedDynastyUrl | null {
  const t = input.trim().replace(/\/+$/, "");
  const m =
    /^https?:\/\/(?:www\.)?dynasty-scans\.com\/(series|chapters|anthologies|doujins|issues)\/([^\/?#]+)$/i.exec(
      t,
    );
  if (!m) return null;
  let permalink = m[2];
  if (permalink.toLowerCase().endsWith(".json")) permalink = permalink.slice(0, -5);
  return { kind: m[1].toLowerCase() === "chapters" ? "chapter" : "series", permalink };
}

/** Builds the on-disk output path for a chapter page image. */
export function pageOutputPath(
  seriesPermalink: string,
  chapterPermalink: string,
  pageIndex: number,
  pageUrl: string,
): string {
  const cleanSeries = (seriesPermalink || "_singles").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanChapter = (chapterPermalink || "chapter").replace(/[^a-zA-Z0-9_-]/g, "_");
  const ext = pageUrl.split(".").pop()?.split("?")[0] || "webp";
  const pad = String(pageIndex + 1).padStart(4, "0");
  return `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/page_${pad}.${ext}`;
}
