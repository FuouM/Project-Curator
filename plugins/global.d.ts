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
      /** Strongly typed overloads for the generic service commands every plugin uses. */
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
        method: "DirStat",
        params: { path?: string },
      ): Promise<{
        DirStatResult?: { total_bytes?: number; file_count?: number; absolute_path?: string };
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
      callService(method: string, params: object): Promise<any>;
      registerTab(
        id: string,
        label: string,
        iconClass: string,
        render: () => HTMLElement,
        chromeLess?: boolean,
      ): void;
      registerMetadataRenderer(id: string, fn: (asset: any) => HTMLElement | null): void;
      registerToolbarButton(
        id: string,
        label: string,
        iconClass: string,
        fn: (selection: any[]) => void,
      ): void;
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
