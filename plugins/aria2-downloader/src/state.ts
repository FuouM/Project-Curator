/**
 * Shared reactive state for the aria2-downloader plugin.
 */

import { getPluginDirs } from "../../lib";
import type { HistoryRecord } from "./history";

export const TAB_ID = "aria2-downloader" as const;

/** Aggregate download view derived from the generic `DownloadProgressResult`. */
export interface QueueItem {
  jobId: string;
  url: string;
  filename: string;
  outputPath: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  percent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSecs: number | null;
  connections: number;
  error: string | null;
  /** Rolling log tail for the bottom terminal dock. */
  logs: string[];
  /** Index into `logs` already appended to the DOM (delta rendering). */
  logIndex: number;
  command: string | null;
  engine: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface PluginSettings {
  /** Absolute output directory. */
  outputDir: string;
  /** Per-file connections, clamped to 1..16 by the backend. */
  connections: number;
  /** Per-job speed cap in KiB/s; 0 = unlimited. */
  speedLimitKb: number;
  /** Retry count; 0 = unlimited. */
  maxTries: number;
  /** Rename an existing file to the next free `_N` name instead of overwriting. */
  autoRename: boolean;
  /** Start new downloads immediately instead of parking them in "queued". */
  autoStart: boolean;
}

export const ARIA2_TOOL = "aria2";

export const DEFAULT_CONNECTIONS = 8;
export const DEFAULT_MAX_TRIES = 5;

export interface PluginState {
  queue: Map<string, QueueItem>;
  history: HistoryRecord[];
  settings: PluginSettings;
  /** aria2 availability, refreshed on init and after InstallTool completes. */
  toolAvailable: boolean;
  toolVersion: string | null;
  toolInstalling: boolean;
}

const { workspaceRoot } = getPluginDirs();

export const state: PluginState = {
  queue: new Map<string, QueueItem>(),
  history: [],
  settings: {
    outputDir: workspaceRoot
      ? `${workspaceRoot.replace(/[\\/]+$/, "")}\\Downloads`
      : "",
    connections: DEFAULT_CONNECTIONS,
    speedLimitKb: 0,
    maxTries: DEFAULT_MAX_TRIES,
    autoRename: false,
    autoStart: true,
  },
  toolAvailable: false,
  toolVersion: null,
  toolInstalling: false,
};

/** Derive a safe output file name from a URL. */
export function filenameFromUrl(url: string, fallbackIndex: number): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) {
      const decoded = decodeURIComponent(seg);
      const cleaned = decoded.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
      if (cleaned) return cleaned;
    }
  } catch {
    /* fall through to generic name */
  }
  return `download_${Date.now()}_${fallbackIndex}.bin`;
}
