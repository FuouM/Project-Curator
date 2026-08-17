/**
 * Typed IPC bridge for the aria2-downloader plugin.
 *
 * Calls ONLY curator-provided generic primitives through
 * `window.PluginHost.callService` (§3.4 A-C of PLAN_ARIA2_DOWNLOADER.md):
 *   A. CheckTool / SetToolPath / InstallTool / GetToolInstallProgress
 *   B. DownloadStart / DownloadProgress / DownloadCancel
 *   C. PluginDbExecute / PluginDbQuery
 *
 * No `Aria2*`-prefixed command exists anywhere; the backend owns the engine
 * registry and the plugin simply names `engine: "aria2"`.
 */

import { createPluginDb } from "../../lib";

const PH = window.PluginHost;

// ── A. Tool / binary management ─────────────────────────────────────────────

export interface ToolStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  portablePath: string | null;
}

export async function checkTool(tool: string): Promise<ToolStatus> {
  const resp = await PH.callService("CheckTool", { tool });
  const r = resp?.CheckToolResult as
    | {
        installed?: boolean;
        path?: string | null;
        version?: string | null;
        portable_path?: string | null;
      }
    | undefined;
  return {
    installed: !!r?.installed,
    path: r?.path ?? null,
    version: r?.version ?? null,
    portablePath: r?.portable_path ?? null,
  };
}

export async function setToolPath(tool: string, path: string | null): Promise<void> {
  const resp = await PH.callService("SetToolPath", { tool, path });
  if (resp?.Error) throw new Error(String(resp.Error.message));
}

export interface InstallOutcome {
  started: boolean;
  error: string | null;
}

export async function installTool(tool: string): Promise<InstallOutcome> {
  const resp = await PH.callService("InstallTool", { tool });
  const r = resp?.InstallToolResult as { started?: boolean; error?: string | null } | undefined;
  return { started: !!r?.started, error: r?.error ?? null };
}

export interface ToolInstallProgress {
  status: string;
  percent: number;
  logs: string[];
  error: string | null;
}

export async function getToolInstallProgress(tool: string): Promise<ToolInstallProgress> {
  const resp = await PH.callService("GetToolInstallProgress", { tool });
  const r = resp?.GetToolInstallProgressResult as
    { status?: string; percent?: number; logs?: string[]; error?: string | null } | undefined;
  return {
    status: r?.status ?? "idle",
    percent: r?.percent ?? 0,
    logs: r?.logs ?? [],
    error: r?.error ?? null,
  };
}

// ── B. Download-job lifecycle (engine-agnostic) ─────────────────────────────

export interface DownloadStartParams {
  engine: string;
  url: string;
  output_path: string;
  max_connections: number;
  speed_limit_kb?: number;
  user_agent?: string;
  headers?: string[];
  max_tries?: number;
  timeout_secs?: number;
  /** Backend picks the next free `_1`, `_2`, ... name when the path exists. */
  auto_rename?: boolean;
  /** Stable id used as the queue key; defaults to a fresh UUID server-side. */
  job_id?: string;
}

export async function downloadStart(params: DownloadStartParams): Promise<string> {
  const resp = await PH.callService("DownloadStart", params);
  if (resp?.Error) throw new Error(String(resp.Error.message));
  const r = resp?.DownloadStartResult as { job_id?: string } | undefined;
  if (!r?.job_id) throw new Error("DownloadStart returned no job_id");
  return r.job_id;
}

export interface DownloadProgress {
  running: boolean;
  status: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSecs: number | null;
  connections: number;
  outputPath: string | null;
  error: string | null;
  logs: string[];
  command: string | null;
  engine: string | null;
}

export async function downloadProgress(jobId: string): Promise<DownloadProgress | undefined> {
  const resp = await PH.callService("DownloadProgress", { job_id: jobId });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  const r = resp?.DownloadProgressResult as
    | {
        running?: boolean;
        status?: string;
        percent?: number;
        downloaded_bytes?: number;
        total_bytes?: number | null;
        speed_bps?: number;
        eta_secs?: number | null;
        connections?: number;
        output_path?: string | null;
        error?: string | null;
        logs?: string[];
        command?: string | null;
        engine?: string | null;
      }
    | undefined;
  if (!r) return undefined;
  return {
    running: !!r.running,
    status: r.status ?? "unknown",
    percent: r.percent ?? 0,
    downloadedBytes: r.downloaded_bytes ?? 0,
    totalBytes: r.total_bytes ?? null,
    speedBps: r.speed_bps ?? 0,
    etaSecs: r.eta_secs ?? null,
    connections: r.connections ?? 0,
    outputPath: r.output_path ?? null,
    error: r.error ?? null,
    logs: r.logs ?? [],
    command: r.command ?? null,
    engine: r.engine ?? null,
  };
}

export async function downloadCancel(jobId: string): Promise<void> {
  const resp = await PH.callService("DownloadCancel", { job_id: jobId });
  if (resp?.Error) throw new Error(String(resp.Error.message));
}

/**
 * Ask the backend to resolve (and reserve) the output path for a job. The
 * backend owns `_N` renaming, so the returned path is exactly what
 * `DownloadStart` will use for the same `job_id`.
 */
export async function resolveOutputPath(
  jobId: string,
  outputPath: string,
  autoRename: boolean,
): Promise<string> {
  const resp = await PH.callService("ResolveOutputPath", {
    job_id: jobId,
    output_path: outputPath,
    auto_rename: autoRename,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  const r = resp?.ResolveOutputPathResult as { output_path?: string } | undefined;
  if (!r?.output_path) throw new Error("ResolveOutputPath returned no output_path");
  return r.output_path;
}

// ── C. Scoped plugin-data SQLite ────────────────────────────────────────────

export interface DbQueryResult {
  rows: Record<string, unknown>[];
}

/** Runs a read query via the shared sandboxed SQLite client (§3.4 C). */
export async function dbQuery(
  sql: string,
  params: unknown[] = [],
  db = "download_history.db",
): Promise<DbQueryResult> {
  const client = createPluginDb(db);
  return { rows: await client.query(sql, params) };
}

/** Runs a write query via the shared sandboxed SQLite client (§3.4 C). */
export async function dbExecute(
  sql: string,
  params: unknown[] = [],
  db = "download_history.db",
): Promise<number> {
  const client = createPluginDb(db);
  return client.execute(sql, params);
}

// ── PluginHost desktop helpers ──────────────────────────────────────────────

/** Opens the native folder picker; resolves the chosen directory or null. */
export async function selectDirectory(): Promise<string | null> {
  try {
    return await PH.dialogs.pickDirectory();
  } catch {
    return null;
  }
}

/** Reveals a file in Explorer with the file highlighted. */
export async function revealInFolder(path: string): Promise<boolean> {
  try {
    await PH.system.revealInFolder(path);
    return true;
  } catch {
    return false;
  }
}

/** Opens a folder directly in Explorer. */
export async function openFolder(path: string): Promise<boolean> {
  try {
    await PH.system.openExternally(path);
    return true;
  } catch {
    return false;
  }
}
