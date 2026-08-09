/**
 * Shared state definitions for the gif-maker plugin.
 */

export const TAB_ID = "gif-maker" as const;

export interface HistoryItem {
  path: string;
  description: string;
  fileSize: number | null;
}

export interface CurrentMedia {
  path: string;
  type: "image" | "video";
  width: number;
  height: number;
  durationMs?: number;
  fps?: number;
  totalFrames?: number;
}

export interface CropState {
  x: number;
  y: number;
  w: number;
  h: number;
  dragging: boolean;
  resizing: boolean;
  needsReset: boolean;
  startX?: number;
  startY?: number;
  startW?: number;
  startH?: number;
}

export interface GifMakerState {
  history: HistoryItem[];
  historyIndex: number;
  currentMedia: CurrentMedia | null;
  customFontName: string;
  currentTool: "maker" | "trim" | "crop" | "caption" | "effects" | "optimize" | "split" | "export";
  sequencePattern: string;
  activeJobId: string | null;
  droppedFrames: string[];
  cropState: CropState;
}

export const state: GifMakerState = {
  history: [],
  historyIndex: -1,
  currentMedia: null,
  customFontName: "Roboto Condensed Bold",
  currentTool: "maker",
  sequencePattern: "",
  activeJobId: null,
  droppedFrames: [],
  cropState: {
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    dragging: false,
    resizing: false,
    needsReset: true,
  },
};

export const workspaceRoot: string = (window as any).__curator_workspace_root__ || "";

