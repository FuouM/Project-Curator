/**
 * Shared state definitions for the image-compare plugin.
 */

export const TAB_ID = "image-compare" as const;

export interface Slot {
  id: number | null;
  path: string;
  url: string;
  name: string;
  width: number;
  height: number;
  sizeStr: string;
}

export interface Pan {
  x: number;
  y: number;
}

export interface CompareState {
  mode: "side-by-side" | "h-slider" | "v-slider" | "onion";
  splitPos: number;
  onionOpacity: number;
  syncLock: boolean;
  pinSplitterToImage: boolean;
  showInfoOverlay: boolean;

  // Zoom & Pan state
  zoomA: number;
  panA: Pan;
  zoomB: number;
  panB: Pan;

  // Slots
  slotA: Slot;
  slotB: Slot;

  // Interaction flags
  isDraggingPan: boolean;
  dragTargetSlot: "A" | "B" | "both";
  panStartX: number;
  panStartY: number;
  panInitialA: Pan;
  panInitialB: Pan;

  isDraggingSlider: boolean;
  rafPending: boolean;
  globalEventsBound: boolean;
}

export const state: CompareState = {
  mode: "side-by-side",
  splitPos: 50,
  onionOpacity: 50,
  syncLock: true,
  pinSplitterToImage: false,
  showInfoOverlay: true,

  zoomA: 1.0,
  panA: { x: 0, y: 0 },
  zoomB: 1.0,
  panB: { x: 0, y: 0 },

  slotA: { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" },
  slotB: { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" },

  isDraggingPan: false,
  dragTargetSlot: "both",
  panStartX: 0,
  panStartY: 0,
  panInitialA: { x: 0, y: 0 },
  panInitialB: { x: 0, y: 0 },

  isDraggingSlider: false,
  rafPending: false,
  globalEventsBound: false,
};
