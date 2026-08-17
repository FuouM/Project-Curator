/**
 * Typed IPC wrappers for the minipaint plugin.
 *
 * Install/progress calls go through the PluginHost service dispatcher. The
 * edited-image save goes through `PluginHost.storage.writeBinary`, which the
 * dashboard bridges to the `save_edited_image` raw-byte transport.
 */

const PH = window.PluginHost;

export async function checkInstalled(): Promise<boolean> {
  const resp = await PH.callService("CheckPluginRuntimeInstalled", { plugin: "minipaint" });
  return !!resp?.CheckPluginRuntimeInstalledResult?.installed;
}

export async function startInstallation(): Promise<boolean> {
  const resp = await PH.callService("InstallPluginRuntime", { plugin: "minipaint" });
  return !!resp?.InstallPluginRuntimeResult?.started;
}

export interface MiniPaintProgress {
  status: string;
  percent: number;
  logs: string[];
  error?: string;
}

export async function getProgress(): Promise<MiniPaintProgress> {
  const resp = await PH.callService("GetPluginRuntimeInstallProgress", { plugin: "minipaint" });
  return resp?.GetPluginRuntimeInstallProgressResult ?? { status: "idle", percent: 0, logs: [] };
}

export interface SaveEditedImageParams {
  outputDir: string;
  format: string;
  name: string;
  bytes: ArrayBuffer;
}

export async function saveEditedImage(
  p: SaveEditedImageParams,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  // The dashboard bridges `writeBinary` to the raw-byte `save_edited_image`
  // command (no base64, no JSON of the bytes); metadata (output dir, format,
  // filename) is decomposed from the target path and rides in request headers.
  const sep = p.outputDir.includes("\\") ? "\\" : "/";
  const path = await PH.storage.writeBinary(
    `${p.outputDir}${sep}${p.name}.${p.format}`,
    new Uint8Array(p.bytes),
  );
  return { ok: true, path };
}
