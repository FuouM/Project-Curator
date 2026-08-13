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

interface PluginHostApi {
  // Capability registration
  registerTab(
    id: string,
    label: string,
    iconClass: string,
    render: () => HTMLElement,
    chromeLess?: boolean
  ): void;
  registerMetadataRenderer(
    id: string,
    fn: (asset: AssetContext) => HTMLElement | null
  ): void;
  registerToolbarButton(
    id: string,
    label: string,
    iconClass: string,
    fn: (selection: AssetContext[]) => void
  ): void;
  registerContextMenuItem(
    id: string,
    label: string,
    fn: (asset: AssetContext) => void
  ): void;

  // IPC bridge
  // `method` is the Rust enum variant name (e.g. "GetImage", "PathExists").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callService(method: string, params: object): Promise<any>;

  // Asset helpers
  convertFileSrc(filePath: string): string;
  fetchAssetContext(imageId: number): Promise<AssetContext>;
  getSelectionAssetContexts(): Promise<AssetContext[]>;
  getAssetContextFromCard(card: HTMLElement): AssetContext;
  /** Close the full-screen image viewer (if open), e.g. before navigating to a tab. */
  closeImageViewer(): void;
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
