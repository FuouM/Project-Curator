/**
 * Pure IPC utility helpers shared across plugins.
 *
 * These functions communicate with the Rust backend via window.PluginHost
 * and have no DOM dependencies, making them independently testable.
 *
 * Used by: image-converter, ffmpeg-transcoder
 */

const PH = window.PluginHost;

/**
 * Returns true if the given absolute path exists on disk.
 * Delegates to the Rust `PathExists` IPC command.
 */
export async function checkFileExists(path: string): Promise<boolean> {
  const resp = await PH.callService("PathExists", { path });
  return !!(resp?.PathExistsResult?.exists);
}

/**
 * Opens the native folder picker and resolves the chosen directory.
 *
 * Returns `null` when the user cancels, the picker fails, or the Tauri core
 * API is unavailable — never throws. Callers decide how to surface the
 * cancellation/no-API case.
 */
export async function pickDirectory(): Promise<string | null> {
  const api = window.__TAURI__;
  if (!api?.core?.invoke) return null;
  try {
    const selected = await api.core.invoke("select_path", { isDirectory: true });
    return typeof selected === "string" && selected.length > 0 ? selected : null;
  } catch {
    return null;
  }
}

/**
 * Reads the plugin's runtime context (absolute dirs injected by the host
 * before each bundle executes). Returns empty strings when unavailable.
 */
export function getPluginDirs(): { pluginDir: string; workspaceRoot: string } {
  return {
    pluginDir: (window as any).__curator_plugin_dir__ ?? "",
    workspaceRoot: (window as any).__curator_workspace_root__ ?? "",
  };
}

/**
 * Resolves a collision-free output file path.
 *
 * Given a source path, an output directory, and a target extension, returns
 * the first path in the sequence:
 *
 *   <stem>.<ext>
 *   <stem>_1.<ext>
 *   <stem>_2.<ext>  …
 *
 * …that does not already exist on disk and does not equal the source path
 * (prevents accidental self-overwrite when input and output dirs are the same).
 */
export async function getUniqueOutputPath(
  sourcePath: string,
  outputDir: string,
  targetExt: string
): Promise<string> {
  const base = sourcePath.split(/[/\\]/).pop()!;
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx !== -1 ? base.substring(0, dotIdx) : base;

  // Preserve the path separator style used by the output directory.
  const sep = outputDir.includes("\\") ? "\\" : "/";
  const cleanDir = outputDir.replace(/[/\\]+$/, "");

  let n = 0;
  while (true) {
    const name =
      n === 0 ? `${stem}.${targetExt}` : `${stem}_${n}.${targetExt}`;
    const candidate = `${cleanDir}${sep}${name}`;

    if (candidate.toLowerCase() === sourcePath.toLowerCase()) {
      n++;
      continue;
    }

    const exists = await checkFileExists(candidate);
    if (!exists) return candidate;
    n++;
  }
}
