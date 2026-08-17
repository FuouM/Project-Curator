/**
 * Shared sandboxed filesystem + download helpers for plugin data dirs.
 *
 * These primitives operate inside the plugin's scoped `plugin_data/<plugin_id>/`
 * directory via the typed `PluginHost.storage` / `PluginHost.network`
 * namespaces. They are the canonical version of the helpers first introduced
 * by `dynasty-scans/src/api/client.ts`.
 *
 * IMPORTANT — semantic split between path probes:
 *  - Sandboxed `PluginHost.storage.*` calls are confined to
 *    `plugin_data/<plugin_id>/` (paths that escape it are rejected by the
 *    service).
 *  - `lib/ipc-utils.ts` `checkFileExists` calls the core `PathExists` command,
 *    which probes arbitrary workspace / `.curator` paths and is the correct
 *    tool for output-path collision checks (`getUniqueOutputPath`). Do not swap
 *    the two unless the caller genuinely wants the sandboxed semantics.
 */

const PH = window.PluginHost;

export interface FileStat {
  absolutePath: string;
  sizeBytes: number;
}

export interface DirStatResult {
  totalBytes: number;
  fileCount: number;
}

/** Resolves a plugin-relative path if it exists and is non-empty; otherwise null. */
export async function fileResolve(path: string): Promise<string | null> {
  return PH.storage.resolve(path);
}

/** Returns true when the file exists on disk in the plugin's data dir and is non-empty. */
export async function fileExists(path: string): Promise<boolean> {
  return PH.storage.exists(path);
}

/** Renames/moves a file within the plugin's data dir. Returns the new absolute path. */
export async function fileMove(src: string, dst: string): Promise<string> {
  return PH.storage.move(src, dst);
}

/** Deletes a file or directory within the plugin's data dir. */
export async function fileDelete(path: string): Promise<void> {
  await PH.storage.delete(path);
}

/** Calculates recursive on-disk byte footprint and file count for a directory. */
export async function dirStat(path = ""): Promise<DirStatResult> {
  try {
    const s = await PH.storage.stat(path);
    return { totalBytes: s.totalBytes, fileCount: s.fileCount };
  } catch {}
  return { totalBytes: 0, fileCount: 0 };
}

/** Downloads a binary payload to the plugin's data dir; resolves to the absolute path. */
export async function httpDownload(
  url: string,
  outputPath: string,
  timeoutMs = 30000,
): Promise<string> {
  return (await PH.network.download(url, outputPath, { timeoutMs })).absolutePath;
}

/** Like `httpDownload`, but also resolves the exact written size in bytes. */
export async function httpDownloadFull(
  url: string,
  outputPath: string,
  timeoutMs = 30000,
): Promise<{ absolutePath: string; sizeBytes: number }> {
  return PH.network.download(url, outputPath, { timeoutMs });
}
