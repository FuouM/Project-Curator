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
      readonly context: {
        readonly pluginId: string;
        readonly pluginDir: string;
        readonly workspaceRoot: string;
      };
      readonly storage: {
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
      };
      readonly db: {
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
      };
      readonly media: {
        getMetadata(path: string): Promise<{ durationMs: number; fps: number; totalFrames: number }>;
        convertImages(
          conversions: Array<[string, string]>,
          opts?: { quality?: number; maxDimension?: number; maxBytes?: number },
        ): Promise<Array<{ sourcePath: string; outputPath: string; error?: string }>>;
        transform(req: {
          jobId: string;
          inputPath: string;
          outputPath: string;
          targetFormat?: string;
          videoFilters?: string[];
          customArgs?: string[];
        }): Promise<void>;
        getProgress(jobId: string): Promise<{
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
      };
      readonly network: {
        get(
          url: string,
          opts?: { headers?: Record<string, string>; timeoutMs?: number },
        ): Promise<{ status: number; body: string; etag?: string }>;
        download(
          url: string,
          outputPath: string,
          opts?: { timeoutMs?: number },
        ): Promise<{ absolutePath: string; sizeBytes: number }>;
      };
      readonly dialogs: {
        pickFile(): Promise<string | null>;
        pickDirectory(): Promise<string | null>;
        saveFile(opts?: {
          suggestedName?: string;
          filterName?: string;
          extensions?: string[];
        }): Promise<string | null>;
      };
      readonly system: {
        revealInFolder(path: string): Promise<void>;
        openExternally(path: string): Promise<void>;
        openUrl(url: string): Promise<void>;
      };
      readonly ui: {
        onDragDrop(
          cb: (
            paths: string[],
            position: { x: number; y: number },
            type: "enter" | "over" | "leave" | "drop",
          ) => void,
        ): void;
      };
      readonly tools: {
        check(
          tool: string,
        ): Promise<{
          installed: boolean;
          path: string | null;
          version: string | null;
          portablePath: string | null;
        }>;
        setPath(tool: string, path: string | null): Promise<void>;
        install(tool: string): Promise<{ started: boolean; error?: string }>;
        getProgress(
          tool: string,
        ): Promise<{ status: string; percent: number; logs: string[]; error?: string }>;
      };
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
