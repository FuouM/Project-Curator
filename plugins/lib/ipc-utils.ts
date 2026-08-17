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
  return !!resp?.PathExistsResult?.exists;
}

/**
 * Opens the native folder picker and resolves the chosen directory.
 *
 * Returns `null` when the user cancels or the picker fails — never throws.
 * Callers decide how to surface the cancellation/no-API case.
 */
export async function pickDirectory(): Promise<string | null> {
  return PH.dialogs.pickDirectory();
}

/**
 * Opens the native file picker and resolves the chosen file path.
 *
 * Returns `null` when the user cancels or the picker fails — never throws.
 * Callers decide how to surface the cancellation/no-API case.
 */
export async function pickFile(): Promise<string | null> {
  return PH.dialogs.pickFile();
}

/**
 * Reads the plugin's runtime context (absolute dirs provided by the host
 * via `PluginHost.context`). Returns empty strings when unavailable.
 */
export function getPluginDirs(): { pluginDir: string; workspaceRoot: string } {
  return {
    pluginDir: PH.context?.pluginDir ?? "",
    workspaceRoot: PH.context?.workspaceRoot ?? "",
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
  targetExt: string,
): Promise<string> {
  const base = sourcePath.split(/[/\\]/).pop()!;
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx !== -1 ? base.substring(0, dotIdx) : base;

  // Preserve the path separator style used by the output directory.
  const sep = outputDir.includes("\\") ? "\\" : "/";
  const cleanDir = outputDir.replace(/[/\\]+$/, "");

  let n = 0;
  while (true) {
    const name = n === 0 ? `${stem}.${targetExt}` : `${stem}_${n}.${targetExt}`;
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
