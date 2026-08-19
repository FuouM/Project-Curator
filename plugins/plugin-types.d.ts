/**
 * Ambient type declarations for Project Curator plugin authors.
 *
 * These mirror the interfaces defined in:
 *   curator-dashboard/src/plugin-host.ts
 *   curator-dashboard/src/types.ts
 *
 * Plugins access the PluginHost solely via `window.PluginHost` — there are
 * no import paths into the dashboard source tree.
 */

// ---------------------------------------------------------------------------
// Core plugin data types
// ---------------------------------------------------------------------------

interface TagContext {
  name: string;
  category: string;
  source_id: string;
  confidence: number | null;
}

interface AssetContext {
  asset_id: number;
  path: string;
  hash: string;
  tags: TagContext[];
}

// ---------------------------------------------------------------------------
// PluginHost API surface
// ---------------------------------------------------------------------------

interface PluginContext {
  readonly pluginId: string;
  readonly pluginDir: string;
  readonly workspaceRoot: string;
}

interface PluginStorage {
  stat(path?: string): Promise<{ totalBytes: number; fileCount: number; exists: boolean }>;
  exists(path: string): Promise<boolean>;
  resolve(path: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array): Promise<string>;
  getFileSize(path: string): Promise<number | null>;
  move(src: string, dst: string): Promise<string>;
  delete(path: string): Promise<void>;
  list(path?: string): Promise<Array<{ name: string; isDir: boolean; sizeBytes: number }>>;
}

interface PluginDb {
  execute(
    dbName: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ rowsAffected: number }>;
  query<T = Record<string, unknown>>(
    dbName: string,
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

interface PluginMediaTransformRequest {
  jobId: string;
  inputPath: string;
  outputPath: string;
  targetFormat?: string;
  videoFilters?: string[];
  customArgs?: string[];
}

interface PluginMedia {
  getMetadata(path: string): Promise<{ durationMs: number; fps: number; totalFrames: number }>;
  convertImages(
    conversions: Array<[string, string]>,
    opts?: { quality?: number; maxDimension?: number; maxBytes?: number },
  ): Promise<Array<{ sourcePath: string; outputPath: string; error?: string }>>;
  transform(req: PluginMediaTransformRequest): Promise<void>;
  getProgress(
    jobId: string,
  ): Promise<{
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
  }>;
}

interface PluginNetwork {
  get(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ status: number; body: string; etag?: string }>;
  download(
    url: string,
    outputPath: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ absolutePath: string; sizeBytes: number }>;
}

interface PluginDialogs {
  pickFile(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  saveFile(opts?: {
    suggestedName?: string;
    filterName?: string;
    extensions?: string[];
  }): Promise<string | null>;
}

interface PluginSystem {
  revealInFolder(path: string): Promise<void>;
  openExternally(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
}

interface PluginUi {
  onDragDrop(
    cb: (
      paths: string[],
      position: { x: number; y: number },
      type: "enter" | "over" | "leave" | "drop",
    ) => void,
  ): void;
}

interface PluginTools {
  check(
    tool: string,
  ): Promise<{ installed: boolean; path: string | null; version: string | null; portablePath: string | null }>;
  setPath(tool: string, path: string | null): Promise<void>;
  install(tool: string): Promise<{ started: boolean; error?: string }>;
  getProgress(
    tool: string,
  ): Promise<{ status: string; percent: number; logs: string[]; error?: string }>;
}

interface PluginHostApi {
  // Plugin context
  readonly context: PluginContext;

  // Capability namespaces
  readonly storage: PluginStorage;
  readonly db: PluginDb;
  readonly media: PluginMedia;
  readonly network: PluginNetwork;
  readonly dialogs: PluginDialogs;
  readonly system: PluginSystem;
  readonly ui: PluginUi;
  readonly tools: PluginTools;

  // Capability registration
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

  // IPC bridge
  // `method` is the Rust enum variant name (e.g. "GetImage", "PathExists").
  //
  // Strongly typed overloads for the standard generic service commands give
  // compile-time payload IntelliSense; unknown commands fall through to the
  // untyped catch-all.
  callService(
    method: "PluginDbExecute",
    params: { db: string; sql: string; params?: unknown[] },
  ): Promise<{
    PluginDbExecuteResult?: { rows_affected?: number };
    Error?: { message: string };
  }>;
  callService(
    method: "PluginDbQuery",
    params: { db: string; sql: string; params?: unknown[] },
  ): Promise<{
    PluginDbQueryResult?: { rows?: Record<string, unknown>[] };
    Error?: { message: string };
  }>;
  callService(
    method: "HttpGet",
    params: {
      url: string;
      timeout_ms?: number;
      method?: "GET" | "POST";
      body?: string;
      content_type?: string;
      headers?: Record<string, string>;
    },
  ): Promise<{
    HttpGetResult?: { status: number; body: string; etag?: string };
    Error?: { message: string };
  }>;
  callService(
    method: "HttpDownload",
    params: { url: string; output_path: string; timeout_ms?: number },
  ): Promise<{
    HttpDownloadResult?: { written_to?: string; size_bytes?: number; absolute_path?: string };
    Error?: { message: string };
  }>;
  callService(
    method: "FileExists",
    params: { path: string },
  ): Promise<{
    FileExistsResult?: { exists?: boolean; size_bytes?: number; absolute_path?: string };
    Error?: { message: string };
  }>;
  callService(
    method: "FileExistsBatch",
    params: { paths: string[] },
  ): Promise<{
    FileExistsBatchResult?: {
      items?: {
        path: string;
        exists?: boolean;
        size_bytes?: number;
        absolute_path?: string;
        error?: string;
      }[];
    };
    Error?: { message: string };
  }>;
  callService(
    method: "DirStat",
    params: { path?: string },
  ): Promise<{
    DirStatResult?: { total_bytes?: number; file_count?: number; absolute_path?: string };
    Error?: { message: string };
  }>;
  callService(
    method: "DirStatBatch",
    params: { paths: string[] },
  ): Promise<{
    DirStatBatchResult?: {
      items?: {
        path: string;
        total_bytes?: number;
        file_count?: number;
        absolute_path?: string;
        error?: string;
      }[];
    };
    Error?: { message: string };
  }>;
  callService(
    method: "FileMove",
    params: { src: string; dst: string },
  ): Promise<{
    FileMoveResult?: { absolute_path?: string };
    Error?: { message: string };
  }>;
  callService(
    method: "FileDelete",
    params: { path: string },
  ): Promise<{ Error?: { message: string } }>;
  callService(
    method: "PathExists",
    params: { path: string },
  ): Promise<{
    PathExistsResult?: { exists?: boolean };
    Error?: { message: string };
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callService(method: string, params: object): Promise<any>;

  // Asset helpers
  convertFileSrc(filePath: string): string;
  fetchAssetContext(imageId: number): Promise<AssetContext>;
  getSelectionAssetContexts(): Promise<AssetContext[]>;
  getAssetContextFromCard(card: HTMLElement): AssetContext;
  /** Close the full-screen image viewer (if open), e.g. before navigating to a tab. */
  closeImageViewer(): void;

  // Lifecycle & Autoload
  isAutoloadEnabled(pluginName?: string): boolean;
  setAutoloadEnabled(pluginName: string, autoload: boolean): void;
  isTabLoaded(tabId?: string): boolean;
  loadTab(tabId?: string): void;
  unloadTab(tabId?: string): void;
}

// ---------------------------------------------------------------------------
// Tauri v2 globals injected by the WebView2 host
// ---------------------------------------------------------------------------

interface TauriDragDropPayload {
  type: "enter" | "over" | "leave" | "drop";
  paths?: string[];
  position?: { x: number; y: number };
}

interface TauriWebview {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDragDropEvent(handler: (event: { payload: TauriDragDropPayload }) => void): any;
}

interface TauriInvokeOptions {
  headers?: Record<string, string>;
}

interface TauriCore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(cmd: string, args?: Record<string, unknown>): Promise<any>;
  // Raw-body overload: passing a typed array as the payload (no JSON/base64).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(cmd: string, args: ArrayBuffer | Uint8Array, options?: TauriInvokeOptions): Promise<any>;
}

// ---------------------------------------------------------------------------
// Global window augmentation
// ---------------------------------------------------------------------------

declare interface Window {
  /** Exposed by curator-dashboard/src/plugin-host.ts before plugins load. */
  PluginHost: PluginHostApi;

  /**
   * Absolute path to the currently-loading plugin's directory, set by the
   * Plugin Host immediately before the plugin bundle is injected and deleted
   * immediately after. Use this to build absolute paths for local binary
   * assets (fonts, images) that must be passed to `PluginHost.convertFileSrc`.
   *
   * @example
   * var fontUrl = PluginHost.convertFileSrc(
   *   (window.__curator_plugin_dir__ ?? "") + "\\MyFont.otf"
   * );
   */
  __curator_plugin_dir__?: string;

  /**
   * Absolute path to the workspace root directory, set by the Plugin Host
   * immediately before the plugin bundle is injected and deleted immediately
   * after. Use this to resolve absolute paths for temporary files (e.g.
   * inside `.curator/temp_gif/`) before passing to `PluginHost.convertFileSrc`.
   */
  __curator_workspace_root__?: string;

  /** Injected by Tauri v2 WebView2 runtime. Optional — guard before use. */
  __TAURI__?: {
    core?: TauriCore;
    webview?: {
      getCurrentWebview(): TauriWebview;
    };
  };
}
