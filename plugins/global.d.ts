/**
 * Ambient type declarations for Project Curator plugin bundles.
 *
 * Plugins run inside the dashboard webview where the host injects
 * `window.PluginHost` (typed as `PluginHostApi` in the dashboard's
 * `plugin-host.ts`) plus a per-plugin facade that binds `callService` to the
 * plugin's own name. Bundles also receive `__curator_plugin_dir__` /
 * `__curator_workspace_root__` and the Tauri `__TAURI__.core` API before they
 * execute.
 *
 * The dashboard declares its richer `PluginHostApi` globally, but that file is
 * not part of a plugin compile unit; this smaller ambient surface lets
 * `tsc --project plugins/tsconfig.json` typecheck plugin sources standalone.
 */

export {};

declare global {
  interface Window {
    PluginHost: {
      callService(method: string, params: object): Promise<any>;
      registerTab(
        id: string,
        label: string,
        iconClass: string,
        render: () => HTMLElement,
        chromeLess?: boolean
      ): void;
      registerMetadataRenderer(id: string, fn: (asset: any) => HTMLElement | null): void;
      registerToolbarButton(id: string, label: string, iconClass: string, fn: (selection: any[]) => void): void;
      registerContextMenuItem(id: string, label: string, fn: (asset: any) => void): void;
      convertFileSrc(filePath: string): string;
      closeImageViewer(): void;
    };
    __TAURI__?: {
      core?: {
        invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
      };
      webview?: {
        getCurrentWebview(): {
          onDragDropEvent(callback: (event: any) => void): void;
        };
      };
    };
    __curator_plugin_dir__?: string;
    __curator_workspace_root__?: string;
  }
}
