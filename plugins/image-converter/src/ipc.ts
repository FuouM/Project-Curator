/**
 * Pure IPC utility helpers for the image-converter plugin.
 *
 * These functions touch no DOM — they only communicate with the Rust backend
 * via window.PluginHost.callService. Keeping them separate makes them easy
 * to unit-test independently of any rendering concerns.
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
 * itself (prevents accidental self-overwrite).
 */
export async function getUniqueOutputPath(
  sourcePath: string,
  outputDir: string,
  targetExt: string
): Promise<string> {
  const base = sourcePath.split(/[/\\]/).pop()!;
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx !== -1 ? base.substring(0, dotIdx) : base;

  // Preserve the path separator style used in the output directory.
  const sep = outputDir.includes("\\") ? "\\" : "/";
  const cleanDir = outputDir.replace(/[/\\]+$/, "");

  let n = 0;
  while (true) {
    const name = n === 0 ? `${stem}.${targetExt}` : `${stem}_${n}.${targetExt}`;
    const candidate = `${cleanDir}${sep}${name}`;

    // Skip if this candidate would silently overwrite the source.
    if (candidate.toLowerCase() === sourcePath.toLowerCase()) {
      n++;
      continue;
    }

    const exists = await checkFileExists(candidate);
    if (!exists) return candidate;
    n++;
  }
}
