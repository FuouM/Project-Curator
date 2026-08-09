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
    render: () => HTMLElement
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

interface TauriCore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(cmd: string, args?: Record<string, unknown>): Promise<any>;
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

  /** Injected by Tauri v2 WebView2 runtime. Optional — guard before use. */
  __TAURI__?: {
    core?: TauriCore;
    webview?: {
      getCurrentWebview(): TauriWebview;
    };
  };
}
