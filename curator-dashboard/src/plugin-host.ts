import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { typedCall } from "./ipc";
import { closeImageViewer } from "./image-viewer";
import { getPluginViewKeys, registerPluginView, removePluginView } from "./views/navigation";
import { AssetContext, ImageDetails, PluginInfo, TagContext } from "./types";
import { selectedImageIds } from "./state";
import { GetImageRequestSchema, ImageResultSchema } from "./gen/gallery_pb";
import {
  InvokePluginRequestSchema,
  InvokePluginResponseSchema,
  PluginsListResultSchema,
  ReadPluginFileRequestSchema,
  PluginFileResultSchema,
} from "./gen/plugins_pb";
import { imageDetailsFromProto, pluginInfoFromProto } from "./proto-adapters";

// ---------------------------------------------------------------------------
// Plugin Registry State
// ---------------------------------------------------------------------------

const registeredTabs: Array<{
  id: string;
  label: string;
  iconClass: string;
  render: () => HTMLElement;
  chromeLess?: boolean;
}> = [];
const registeredRenderers: Array<{ id: string; fn: (asset: AssetContext) => HTMLElement | null }> =
  [];
const registeredToolbarButtons: Array<{
  id: string;
  label: string;
  iconClass: string;
  fn: (selection: AssetContext[]) => void;
}> = [];
const registeredContextMenuItems: Array<{
  id: string;
  label: string;
  fn: (asset: AssetContext) => void;
}> = [];
const mountedTabs = new Set<string>();

let pluginInfos: PluginInfo[] = [];
export function getPluginInfos(): PluginInfo[] {
  return pluginInfos;
}

// ---------------------------------------------------------------------------
// AssetContext Adapter
// ---------------------------------------------------------------------------

/** Map a core `ImageDetails` record into the plugin `AssetContext` shape. */
export function getAssetContext(image: ImageDetails): AssetContext {
  const tags: TagContext[] = (image.tags || []).map((t) => ({
    name: t.tag,
    category: t.category,
    source_id: t.source_name || "user",
    confidence: typeof t.confidence === "number" ? t.confidence : null,
  }));
  return {
    asset_id: image.id,
    path: image.current_filepath,
    hash: image.sha256 || "",
    tags,
  };
}

/** Minimal `AssetContext` derived from a rendered card (path + id only). */
export function getAssetContextFromCard(card: HTMLElement): AssetContext {
  const id = parseInt(card.dataset.imageId || "0", 10);
  const path = card.dataset.filepath || "";
  return { asset_id: id, path, hash: "", tags: [] };
}

/** Fetch the full `AssetContext` for an asset id (hydrates hash + tags). */
export async function fetchAssetContext(imageId: number): Promise<AssetContext> {
  const resp = await typedCall(
    "GalleryService.GetImage",
    GetImageRequestSchema,
    { imageId: BigInt(imageId) },
    ImageResultSchema,
  );
  if (resp.image) {
    return getAssetContext(imageDetailsFromProto(resp.image));
  }
  return { asset_id: imageId, path: "", hash: "", tags: [] };
}

/** Build `AssetContext[]` for the current multi-select set (in parallel). */
export async function getSelectionAssetContexts(): Promise<AssetContext[]> {
  const ids = Array.from(selectedImageIds);
  const results = await Promise.all(ids.map((id) => fetchAssetContext(id)));
  return results.filter((a) => a.asset_id > 0);
}

// ---------------------------------------------------------------------------
// PluginHost Global API (design doc Section 8.1/8.2)
// ---------------------------------------------------------------------------

/**
 * Bridge a bundled plugin's dynamic `{ command, params }` call onto the typed
 * `PluginsService.InvokePlugin` RPC. The server dispatches `command` through
 * the same handler pipeline the legacy single-RPC endpoint used and returns a
 * JSON-serialized response in the legacy shape, so bundled plugins keep their
 * existing parsing behavior unchanged.
 */
async function invokePlugin(
  pluginId: string,
  command: string,
  params: object | null | undefined,
): Promise<any> {
  const resp = await typedCall(
    "PluginsService.InvokePlugin",
    InvokePluginRequestSchema,
    { pluginId, command, parametersJson: JSON.stringify(params ?? null) },
    InvokePluginResponseSchema,
  );
  return JSON.parse(resp.responseJson);
}

// ---------------------------------------------------------------------------
// Capability SDK (Phase 3): typed namespaces over the sandboxed backend
// ---------------------------------------------------------------------------

/** Unwrap a `{ CommandResult: … }` plugin response, throwing on `Error`. */
function unwrapCommandResult<T = any>(resp: any, expectedKey: string): T {
  if (resp && typeof resp === "object") {
    if (resp.Error) {
      throw new Error(resp.Error.message || "Plugin command failed");
    }
    if (expectedKey in resp) {
      return resp[expectedKey] as T;
    }
  }
  throw new Error(`Unexpected plugin command response (expected ${expectedKey})`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly pluginDir: string;
  readonly workspaceRoot: string;
}

export interface MediaTransformRequest {
  jobId: string;
  inputPath: string;
  outputPath: string;
  targetFormat?: string;
  videoFilters?: string[];
  customArgs?: string[];
}

export interface TranscodeProgressResult {
  running: boolean;
  percent: number;
  fps: number;
  xSpeed: number;
  outTimeMs: number;
  outputPath: string | null;
  error: string | null;
  command: string | null;
  inputSizeBytes: number | null;
  outputSizeBytes: number | null;
}

type DragDropEventType = "enter" | "over" | "leave" | "drop";

const dragDropCallbacks: Array<
  (paths: string[], position: { x: number; y: number }, type: DragDropEventType) => void
> = [];
let dragDropBound = false;

function bindDragDropOnce(): void {
  if (dragDropBound) return;
  dragDropBound = true;
  getCurrentWebview().onDragDropEvent((event) => {
    const drop = event.payload;
    const type = drop.type;
    const paths = "paths" in drop ? drop.paths ?? [] : [];
    const position = type === "leave" ? { x: 0, y: 0 } : drop.position;
    for (const cb of dragDropCallbacks) {
      try {
        cb(paths, position, type);
      } catch (e) {
        console.error("PluginHost.ui.onDragDrop callback error:", e);
      }
    }
  });
}

function makeCapabilities(pluginId: string) {
  return {
    storage: {
      async stat(
        path?: string,
      ): Promise<{ totalBytes: number; fileCount: number; exists: boolean }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "DirStat", { path: path ?? "" }),
          "DirStatResult",
        );
        return {
          totalBytes: r.total_bytes,
          fileCount: r.file_count,
          exists: r.file_count > 0,
        };
      },
      async exists(path: string): Promise<boolean> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "FileExists", { path }),
          "FileExistsResult",
        );
        return r.exists;
      },
      async resolve(path: string): Promise<string | null> {
        try {
          const r = unwrapCommandResult(
            await invokePlugin(pluginId, "FileExists", { path }),
            "FileExistsResult",
          );
          return r.absolute_path || null;
        } catch {
          return null;
        }
      },
      async readText(path: string): Promise<string> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "FileRead", { path }),
          "FileReadResult",
        );
        return new TextDecoder().decode(base64ToBytes(r.content_base64));
      },
      async writeText(path: string, content: string): Promise<void> {
        await invokePlugin(pluginId, "FileWrite", {
          path,
          content_base64: bytesToBase64(new TextEncoder().encode(content)),
        });
      },
      async readBinary(path: string): Promise<Uint8Array> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "FileRead", { path }),
          "FileReadResult",
        );
        return base64ToBytes(r.content_base64);
      },
      async writeBinary(path: string, bytes: Uint8Array): Promise<string> {
        const sep = path.includes("\\") ? "\\" : "/";
        const name = path.split(sep).pop() || "edited";
        const dot = name.lastIndexOf(".");
        const stem = dot !== -1 ? name.substring(0, dot) : name;
        const format = dot !== -1 ? name.substring(dot + 1) : "png";
        const outDir = path.substring(0, path.length - name.length - 1);
        return invoke("save_edited_image", bytes, {
          headers: {
            "x-filename": encodeURIComponent(stem),
            "x-format": format,
            "x-out-dir": encodeURIComponent(outDir),
          },
        });
      },
      async getFileSize(path: string): Promise<number | null> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "GetFileSize", { path }),
          "GetFileSizeResult",
        );
        return r.size_bytes ?? null;
      },
      async move(src: string, dst: string): Promise<string> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "FileMove", { src, dst }),
          "FileMoveResult",
        );
        return r.absolute_path;
      },
      async delete(path: string): Promise<void> {
        await invokePlugin(pluginId, "FileDelete", { path });
      },
      async list(path?: string): Promise<Array<{ name: string; isDir: boolean; sizeBytes: number }>> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "FileList", { path: path ?? "" }),
          "FileListResult",
        );
        return (r.entries || []).map((e: any) => ({
          name: e.name,
          isDir: e.is_dir,
          sizeBytes: e.size_bytes,
        }));
      },
    },

    db: {
      async execute(
        dbName: string,
        sql: string,
        params: unknown[] = [],
      ): Promise<{ rowsAffected: number }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "PluginDbExecute", { db: dbName, sql, params }),
          "PluginDbExecuteResult",
        );
        return { rowsAffected: r.rows_affected };
      },
      async query<T = Record<string, unknown>>(
        dbName: string,
        sql: string,
        params: unknown[] = [],
      ): Promise<T[]> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "PluginDbQuery", { db: dbName, sql, params }),
          "PluginDbQueryResult",
        );
        return (r.rows || []) as T[];
      },
    },

    media: {
      async getMetadata(path: string): Promise<{ durationMs: number; fps: number; totalFrames: number }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "GetMediaMetadata", { path }),
          "MediaMetadataResult",
        );
        return { durationMs: r.duration_ms, fps: r.fps, totalFrames: r.total_frames };
      },
      async convertImages(
        conversions: Array<[string, string]>,
        opts?: { quality?: number; maxDimension?: number; maxBytes?: number },
      ): Promise<Array<{ sourcePath: string; outputPath: string; error?: string }>> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "EphemeralConvertImages", {
            conversions: conversions.map(([s, d]) => [s, d]),
            quality: opts?.quality ?? 80,
            max_dimension: opts?.maxDimension,
            max_bytes: opts?.maxBytes,
          }),
          "ConvertImagesResult",
        );
        return (r.converted || []).map((c: any) => ({
          sourcePath: c.source_path,
          outputPath: c.output_path,
          error: c.error,
        }));
      },
      async transform(req: MediaTransformRequest): Promise<void> {
        await invokePlugin(pluginId, "MediaTransform", {
          job_id: req.jobId,
          input_path: req.inputPath,
          output_path: req.outputPath,
          target_format: req.targetFormat,
          video_filters: req.videoFilters,
          custom_args: req.customArgs,
        });
      },
      async getProgress(jobId: string): Promise<TranscodeProgressResult> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "GetTranscodeProgress", { job_id: jobId }),
          "TranscodeProgressResult",
        );
        return {
          running: r.running,
          percent: r.percent,
          fps: r.fps,
          xSpeed: r.x_speed,
          outTimeMs: r.out_time_ms,
          outputPath: r.output_path ?? null,
          error: r.error ?? null,
          command: r.command ?? null,
          inputSizeBytes: r.input_size_bytes ?? null,
          outputSizeBytes: r.output_size_bytes ?? null,
        };
      },
    },

    network: {
      async get(
        url: string,
        opts?: { headers?: Record<string, string>; timeoutMs?: number },
      ): Promise<{ status: number; body: string; etag?: string }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "HttpGet", { url, headers: opts?.headers ?? {} }),
          "HttpGetResult",
        );
        return { status: r.status, body: r.body, etag: r.etag };
      },
      async download(
        url: string,
        outputPath: string,
        opts?: { timeoutMs?: number },
      ): Promise<{ absolutePath: string; sizeBytes: number }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "HttpDownload", {
            url,
            output_path: outputPath,
            timeout_ms: opts?.timeoutMs,
          }),
          "HttpDownloadResult",
        );
        return { absolutePath: r.absolute_path, sizeBytes: r.size_bytes };
      },
    },

    dialogs: {
      async pickFile(): Promise<string | null> {
        return invoke<string | null>("select_path", { isDirectory: false });
      },
      async pickDirectory(): Promise<string | null> {
        return invoke<string | null>("select_path", { isDirectory: true });
      },
      async saveFile(opts?: {
        suggestedName?: string;
        filterName?: string;
        extensions?: string[];
      }): Promise<string | null> {
        return invoke<string | null>("save_file_dialog", {
          suggestedName: opts?.suggestedName ?? "export",
          filterName: opts?.filterName ?? "All files",
          extensions: opts?.extensions ?? ["*"],
        });
      },
    },

    system: {
      async revealInFolder(path: string): Promise<void> {
        await invoke("reveal_in_folder", { path });
      },
      async openExternally(path: string): Promise<void> {
        await invoke("open_file_externally", { path });
      },
      async openUrl(url: string): Promise<void> {
        await invoke("plugin:opener|open_url", { url });
      },
    },

    ui: {
      onDragDrop(
        cb: (paths: string[], position: { x: number; y: number }, type: DragDropEventType) => void,
      ): void {
        bindDragDropOnce();
        dragDropCallbacks.push(cb);
      },
    },

    tools: {
      async check(
        tool: string,
      ): Promise<{ installed: boolean; path: string | null; version: string | null; portablePath: string | null }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "CheckTool", { tool }),
          "CheckToolResult",
        );
        return {
          installed: r.installed,
          path: r.path ?? null,
          version: r.version ?? null,
          portablePath: r.portable_path ?? null,
        };
      },
      async setPath(tool: string, path: string | null): Promise<void> {
        await invokePlugin(pluginId, "SetToolPath", { tool, path });
      },
      async install(tool: string): Promise<{ started: boolean; error?: string }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "InstallTool", { tool }),
          "InstallToolResult",
        );
        return { started: r.started, error: r.error };
      },
      async getProgress(
        tool: string,
      ): Promise<{ status: string; percent: number; logs: string[]; error?: string }> {
        const r = unwrapCommandResult(
          await invokePlugin(pluginId, "GetToolInstallProgress", { tool }),
          "GetToolInstallProgressResult",
        );
        return { status: r.status, percent: r.percent, logs: r.logs || [], error: r.error };
      },
    },
  };
}

const PLUGIN_AUTOLOAD_KEY = "curator_plugin_autoload_settings";

export function isPluginAutoloadEnabled(pluginName: string): boolean {
  try {
    const raw = localStorage.getItem(PLUGIN_AUTOLOAD_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw);
    if (typeof map[pluginName] === "boolean") {
      return map[pluginName];
    }
  } catch (_) {}
  return true;
}

export function setPluginAutoloadEnabled(pluginName: string, autoload: boolean): void {
  try {
    const raw = localStorage.getItem(PLUGIN_AUTOLOAD_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[pluginName] = autoload;
    localStorage.setItem(PLUGIN_AUTOLOAD_KEY, JSON.stringify(map));
  } catch (e) {
    console.error("Failed to save plugin autoload setting:", e);
  }
}

export interface PluginHostApi {
  readonly context: PluginContext;
  readonly storage: ReturnType<typeof makeCapabilities>["storage"];
  readonly db: ReturnType<typeof makeCapabilities>["db"];
  readonly media: ReturnType<typeof makeCapabilities>["media"];
  readonly network: ReturnType<typeof makeCapabilities>["network"];
  readonly dialogs: ReturnType<typeof makeCapabilities>["dialogs"];
  readonly system: ReturnType<typeof makeCapabilities>["system"];
  readonly ui: ReturnType<typeof makeCapabilities>["ui"];
  readonly tools: ReturnType<typeof makeCapabilities>["tools"];
  registerTab(
    id: string,
    label: string,
    iconClass: string,
    render: () => HTMLElement,
    chromeLess?: boolean,
  ): void;
  registerMetadataRenderer(id: string, fn: (asset: AssetContext) => HTMLElement | null): void;
  registerToolbarButton(
    id: string,
    label: string,
    iconClass: string,
    fn: (selection: AssetContext[]) => void,
  ): void;
  registerContextMenuItem(id: string, label: string, fn: (asset: AssetContext) => void): void;
  callService(method: string, params: object): Promise<any>;
  convertFileSrc(filePath: string): string;
  closeImageViewer(): void;
  getAssetContext(image: ImageDetails): AssetContext;
  getAssetContextFromCard(card: HTMLElement): AssetContext;
  fetchAssetContext(imageId: number): Promise<AssetContext>;
  getSelectionAssetContexts(): Promise<AssetContext[]>;
  renderMetadataSections(asset: AssetContext): HTMLElement[];
  getContextMenuItems(): Array<{ id: string; label: string; fn: (asset: AssetContext) => void }>;
  isAutoloadEnabled(pluginName?: string): boolean;
  setAutoloadEnabled(pluginName: string, autoload: boolean): void;
  isTabLoaded(tabId?: string): boolean;
  loadTab(tabId?: string): void;
  unloadTab(tabId?: string): void;
}

const basePluginHost: PluginHostApi = {
  context: { pluginId: "", pluginDir: "", workspaceRoot: "" },
  ...makeCapabilities(""),
  registerTab(id, label, iconClass, render, chromeLess) {
    registeredTabs.push({ id, label, iconClass, render, chromeLess });
  },
  registerMetadataRenderer(id, fn) {
    registeredRenderers.push({ id, fn });
  },
  registerToolbarButton(id, label, iconClass, fn) {
    registeredToolbarButtons.push({ id, label, iconClass, fn });
  },
  registerContextMenuItem(id, label, fn) {
    registeredContextMenuItems.push({ id, label, fn });
  },
  callService(method, params) {
    return invokePlugin("", method, params);
  },
  convertFileSrc(filePath: string) {
    return convertFileSrc(filePath);
  },
  closeImageViewer() {
    closeImageViewer();
  },
  getAssetContext,
  getAssetContextFromCard,
  fetchAssetContext,
  getSelectionAssetContexts,
  renderMetadataSections(asset) {
    return registeredRenderers
      .map((r) => r.fn(asset))
      .filter((el): el is HTMLElement => el !== null);
  },
  getContextMenuItems() {
    return registeredContextMenuItems.slice();
  },
  isAutoloadEnabled(pluginName?: string) {
    return isPluginAutoloadEnabled(pluginName || "");
  },
  setAutoloadEnabled(pluginName, autoload) {
    setPluginAutoloadEnabled(pluginName, autoload);
  },
  isTabLoaded(tabId?: string) {
    return isTabLoaded(tabId);
  },
  loadTab(tabId?: string) {
    if (tabId) setTabLoadedState(tabId, true);
  },
  unloadTab(tabId?: string) {
    if (tabId) setTabLoadedState(tabId, false);
  },
};

/**
 * Per-plugin facade over the base host. Bundles capture `window.PluginHost` at
 * load time, so swapping the global right before a bundle executes binds that
 * plugin's `callService` to its own name — the backend uses it to scope
 * `PluginDbExecute`/`PluginDbQuery` to `.curator/plugin_data/<plugin>/`.
 */
function makePluginHostFacade(
  pluginName: string,
  pluginDir: string,
  workspaceRoot: string,
): PluginHostApi {
  return {
    ...basePluginHost,
    context: { pluginId: pluginName, pluginDir, workspaceRoot },
    ...makeCapabilities(pluginName),
    callService(method, params) {
      return invokePlugin(pluginName, method, params);
    },
    isAutoloadEnabled(name?: string) {
      return isPluginAutoloadEnabled(name || pluginName);
    },
    setAutoloadEnabled(name: string, autoload: boolean) {
      return setPluginAutoloadEnabled(name || pluginName, autoload);
    },
    isTabLoaded(name?: string) {
      return isTabLoaded(name || pluginName);
    },
    loadTab(name?: string) {
      setTabLoadedState(name || pluginName, true);
    },
    unloadTab(name?: string) {
      setTabLoadedState(name || pluginName, false);
    },
  };
}

declare global {
  interface Window {
    PluginHost: PluginHostApi;
  }
}

window.PluginHost = basePluginHost;

// ---------------------------------------------------------------------------
// Bundle Loading
// ---------------------------------------------------------------------------

/** Execute a plugin JS bundle in global scope. Throws propagate to the caller's
 *  try/catch (inline script execution is synchronous). */
function executePluginBundle(
  code: string,
  pluginName: string,
  pluginDir: string,
  workspaceRoot: string,
): void {
  // Expose absolute directories before the bundle runs so plugins
  // can construct absolute paths for local binary assets and temporary files.
  (window as any).__curator_plugin_dir__ = pluginDir;
  (window as any).__curator_workspace_root__ = workspaceRoot;
  // Bind callService to this plugin so the backend can scope plugin DB access.
  window.PluginHost = makePluginHostFacade(pluginName, pluginDir, workspaceRoot);
  const script = document.createElement("script");
  script.textContent = code;
  script.setAttribute("data-plugin", pluginName);
  document.head.appendChild(script);
  document.head.removeChild(script);
  delete (window as any).__curator_plugin_dir__;
  delete (window as any).__curator_workspace_root__;
  window.PluginHost = basePluginHost;
}

function clearRegistry() {
  registeredTabs.length = 0;
  registeredRenderers.length = 0;
  registeredToolbarButtons.length = 0;
  registeredContextMenuItems.length = 0;
  mountedTabs.clear();
}

/**
 * Load all enabled, UI-injecting plugins and mount their registered
 * capabilities. Safe to re-run (live re-init after enable/disable toggles).
 */
export async function initPlugins() {
  clearRegistry();
  refreshExtensionsToolbar();

  let resp: any;
  try {
    resp = await typedCall("PluginsService.ListPlugins", null, null, PluginsListResultSchema);
  } catch (e) {
    console.error("initPlugins: ListPlugins failed:", e);
    return;
  }

  pluginInfos = resp.plugins.map(pluginInfoFromProto);

  const loadable = pluginInfos.filter(
    (p) => p.enabled && !!p.ui && p.permissions.includes("ui:inject"),
  );

  for (const p of loadable) {
    try {
      const fileResp = await typedCall(
        "PluginsService.ReadPluginFile",
        ReadPluginFileRequestSchema,
        { pluginName: p.name, relativePath: p.ui! },
        PluginFileResultSchema,
      );
      // Derive the plugin's absolute directory from its manifest path.
      // manifest_path is e.g. "K:\...\plugins\gif-maker\manifest.json"
      const pluginDir = p.manifest_path.replace(/[\\/][^\\/]+$/, ""); // strip manifest.json
      const workspaceRoot = pluginDir
        .replace(/[\\/][^\\/]+$/, "") // strip plugin directory name
        .replace(/[\\/][^\\/]+$/, ""); // strip "plugins"
      executePluginBundle(fileResp.content, p.name, pluginDir, workspaceRoot);
    } catch (e) {
      console.error(`Plugin "${p.name}": bundle load failed, skipping (core UI untouched):`, e);
    }
  }

  mountPluginTabs();
  refreshExtensionsToolbar();

  // Remove nav items / sections for plugins that were loaded in a previous
  // cycle but are no longer registered (e.g. disabled via the hub).
  const currentTabKeys = new Set(registeredTabs.map((t) => `extensions-${t.id}`));
  for (const key of getPluginViewKeys()) {
    if (!currentTabKeys.has(key)) removePluginView(key);
  }
}

const tabLoadedStates = new Map<string, boolean>();

export function isTabLoaded(tabId?: string): boolean {
  const id = tabId || "";
  if (!id) return true;
  if (!tabLoadedStates.has(id)) {
    tabLoadedStates.set(id, isPluginAutoloadEnabled(id));
  }
  return tabLoadedStates.get(id) ?? true;
}

export function setTabLoadedState(tabId: string, loaded: boolean): void {
  const current = isTabLoaded(tabId);
  tabLoadedStates.set(tabId, loaded);
  if (current !== loaded) {
    renderTabState(tabId);
  }
  updateHeaderPluginActions();
}

export function toggleTabLoadedState(tabId: string): void {
  const current = isTabLoaded(tabId);
  setTabLoadedState(tabId, !current);
}

export function renderTabState(tabId: string): void {
  const tab = registeredTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const section = document.getElementById(`view-extensions-${tab.id}`);
  if (!section) return;

  // Chrome-less plugins (like miniPaint or custom-header readers) render directly
  // and manage their own internal toolbar/load controls.
  if (tab.chromeLess) {
    if (section.childElementCount === 0) {
      section.innerHTML = "";
      const el = tab.render();
      if (el) section.appendChild(el);
    }
    return;
  }

  const loaded = isTabLoaded(tabId);
  section.innerHTML = "";
  if (loaded) {
    const el = tab.render();
    if (el) section.appendChild(el);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "group-box";
    placeholder.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:300px;text-align:center;gap:12px;color:var(--sys-text-muted, #666);padding:24px;";
    placeholder.innerHTML = `
      <i class="${tab.iconClass}" style="font-size:36px;opacity:0.4;"></i>
      <div style="font-size:13px;font-weight:600;color:var(--sys-window-text, #333);">${tab.label} is Unloaded</div>
      <div style="font-size:11px;max-width:340px;line-height:1.5;color:var(--sys-text-muted, #666);">
        The plugin view is unloaded to keep memory and background activity minimal. Click below or in the top header to load the view.
      </div>
      <button type="button" class="win-button primary" id="plugin-unloaded-load-btn-${tab.id}" style="padding:4px 16px;font-size:12px;display:inline-flex;align-items:center;gap:6px;">
        <i class="bi bi-play-circle"></i> Load View
      </button>
    `;
    placeholder
      .querySelector(`#plugin-unloaded-load-btn-${tab.id}`)
      ?.addEventListener("click", () => {
        setTabLoadedState(tab.id, true);
      });
    section.appendChild(placeholder);
  }
}

export function updateHeaderPluginActions(currentView?: string): void {
  const headerActions = document.getElementById("header-actions");
  if (!headerActions) return;

  const activeView =
    currentView || document.querySelector(".nav-item.active")?.getAttribute("data-view") || "";
  if (!activeView.startsWith("extensions-")) {
    headerActions.innerHTML = "";
    headerActions.style.display = "none";
    return;
  }

  const tabId = activeView.replace("extensions-", "");
  const tab = registeredTabs.find((t) => t.id === tabId);
  if (!tab || tab.chromeLess) {
    headerActions.innerHTML = "";
    headerActions.style.display = "none";
    return;
  }

  headerActions.style.display = "flex";
  headerActions.innerHTML = "";

  const loaded = isTabLoaded(tabId);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "header-plugin-toggle-btn";
  btn.style.cssText = "font-size:11px;padding:3px 10px;";
  if (loaded) {
    btn.className = "win-button";
    btn.innerHTML = '<i class="bi bi-stop-circle"></i> Unload';
    btn.title = `Unload ${tab.label} view`;
  } else {
    btn.className = "win-button primary";
    btn.innerHTML = '<i class="bi bi-play-circle"></i> Load';
    btn.title = `Load ${tab.label} view`;
  }
  btn.addEventListener("click", () => {
    toggleTabLoadedState(tabId);
  });
  headerActions.appendChild(btn);
}

/** Create sidebar nav item + view section for each registered plugin tab. */
function mountPluginTabs() {
  // Clear previously-rendered plugin tab content so re-init renders fresh
  // closures on next activation (live re-init after enable/disable toggles).
  document.querySelectorAll<HTMLElement>("[id^='view-extensions-']").forEach((s) => {
    s.innerHTML = "";
  });

  for (const tab of registeredTabs) {
    if (mountedTabs.has(tab.id)) continue;
    mountedTabs.add(tab.id);
    registerPluginView(
      tab.id,
      tab.label,
      tab.iconClass,
      `Plugin: ${tab.label}`,
      () => {
        const section = document.getElementById(`view-extensions-${tab.id}`);
        if (section && section.childElementCount === 0) {
          renderTabState(tab.id);
        }
        updateHeaderPluginActions(`extensions-${tab.id}`);
      },
      tab.chromeLess,
    );
  }
}

// ---------------------------------------------------------------------------
// Toolbar Buttons (D3)
// ---------------------------------------------------------------------------

export function refreshExtensionsToolbar() {
  const containers = document.querySelectorAll<HTMLElement>(".extensions-toolbar");
  containers.forEach((c) => {
    c.innerHTML = "";
  });

  for (const btn of registeredToolbarButtons) {
    containers.forEach((container) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "win-button";
      b.style.cssText = "font-size: 11px;";
      b.title = btn.label;
      b.innerHTML = `<i class="${btn.iconClass}"></i> ${btn.label}`;
      b.addEventListener("click", () => {
        getSelectionAssetContexts().then((selection) => btn.fn(selection));
      });
      container.appendChild(b);
    });
  }
}
