/**
 * Typed IPC wrappers for the minipaint plugin.
 *
 * Install/progress calls go through the PluginHost service dispatcher. The
 * edited-image save goes straight to the Tauri `save_edited_image` command in
 * the dashboard process as a raw binary body (no base64, no number arrays) —
 * see the implementation plan §4.4 for the transport rationale.
 */

const PH = window.PluginHost;

export async function checkInstalled(): Promise<boolean> {
  const resp = await PH.callService("CheckPluginRuntimeInstalled", { plugin: "minipaint" });
  return !!(resp?.CheckPluginRuntimeInstalledResult?.installed);
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
  return (
    resp?.GetPluginRuntimeInstallProgressResult ?? { status: "idle", percent: 0, logs: [] }
  );
}

export interface SaveEditedImageParams {
  outputDir: string;
  format: string;
  name: string;
  bytes: ArrayBuffer;
}

export async function saveEditedImage(p: SaveEditedImageParams): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Raw-byte Tauri invoke: the Uint8Array is sent as the command's raw body
  // (no base64, no JSON of the bytes); metadata rides in request headers.
  // The saved path (a tiny string) is the only thing that comes back.
  const tauriCore = window.__TAURI__?.core;
  if (!tauriCore) {
    throw new Error("Tauri core API not available; cannot save edited image.");
  }
  const path = await tauriCore.invoke(
    "save_edited_image",
    new Uint8Array(p.bytes),
    {
      headers: {
        "x-filename": encodeURIComponent(p.name),
        "x-format": p.format,
        "x-out-dir": encodeURIComponent(p.outputDir),
      },
    },
  );
  return { ok: true, path: path as string };
}