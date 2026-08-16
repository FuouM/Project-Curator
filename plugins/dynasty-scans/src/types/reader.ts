/**
 * Reader subsystem types: fit modes, layout modes, themes, and download tasks.
 */

export type FitMode = "width" | "height" | "original";

export type ReaderMode = "scroll" | "paged";

export type ReaderTheme = "light" | "dark";

export interface PageDownloadTask {
  index: number;
  url: string;
  outputPath: string;
}

export interface ViewportState {
  currentIndex: number;
  pageTotal: number;
  cachedCount: number;
}

export interface PageSlot {
  index: number;
  el: HTMLElement;
}

export type SlotRenderKind = "spinner" | "offline" | "error";
