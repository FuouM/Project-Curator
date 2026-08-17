/**
 * Canvas + overlay effects layer for gif-maker.
 *
 * Owns plugin CSS injection, custom-font loading, caption-canvas rendering,
 * the WYSIWYG preview overlay position math, and the interactive crop box
 * drag/resize handlers.
 */

import { state } from "./state";
import { PH, el, logConsole } from "./ui-core";

// CSS injection for our WinForms visual workspace
export function injectStyles(): void {
  if (document.getElementById("gm-styles")) return;
  const style = document.createElement("style");
  style.id = "gm-styles";
  style.textContent = `
    #view-extensions-gif-maker.active {
      display: flex !important;
      flex-direction: column;
      height: calc(100vh - 140px);
      max-height: calc(100vh - 140px);
      overflow: hidden !important;
    }
    .gm-workspace {
      display: flex;
      flex-direction: row;
      gap: 12px;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
      padding: 8px;
      box-sizing: border-box;
      font-family: var(--sys-font-family, "Segoe UI", sans-serif);
      color: var(--sys-window-text, #000);
      background: var(--sys-window-bg, #f0f0f0);
    }
    .gm-left-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .gm-preview-container {
      flex: 1;
      border: 1px solid var(--sys-border, #a0a0a0);
      background: #202020;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .gm-preview-media {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    #gm-preview-video {
      pointer-events: auto;
    }
    #gm-preview-video::-webkit-media-controls-panel {
      display: flex !important;
      opacity: 1 !important;
    }
    .gm-preview-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
    }
    .gm-crop-box {
      position: absolute;
      border: 2px dashed #0078d7;
      background: rgba(0, 120, 215, 0.15);
      cursor: move;
      display: none;
    }
    .gm-crop-handle {
      position: absolute;
      width: 8px;
      height: 8px;
      background: #0078d7;
      border: 1px solid #fff;
    }
    .gm-crop-handle.se {
      bottom: -4px;
      right: -4px;
      cursor: se-resize;
    }
    .gm-right-panel {
      width: 360px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;
      min-height: 0;
      overflow: hidden;
    }
    .gm-toolbar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .gm-toolbar .win-button {
      font-size: 10px;
      padding: 4px 2px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      height: 36px;
      box-sizing: border-box;
    }
    .gm-toolbar .win-button.active {
      background: var(--sys-accent-light, #cce5ff);
      border-color: var(--sys-accent, #0078d7);
      font-weight: bold;
    }
    .gm-control-box {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .gm-history-box {
      height: 140px;
      display: flex;
      flex-direction: column;
    }
    .gm-history-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--sys-border-light, #d0d0d0);
      background: var(--sys-window-bg, #fff);
      font-size: 11px;
    }
    .gm-history-item {
      padding: 3px 6px;
      cursor: pointer;
      border-bottom: 1px solid #f0f0f0;
      display: flex;
      justify-content: space-between;
    }
    .gm-history-item:hover {
      background: #f5f5f5;
    }
    .gm-history-item.active {
      background: #e0eef9;
      font-weight: bold;
    }
    .gm-frame-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px;
      border: 1px solid #d0d0d0;
      background: #fff;
      margin-bottom: 4px;
      font-size: 10px;
    }
    .gm-frame-img {
      width: 40px;
      height: 40px;
      object-fit: cover;
      border: 1px solid #a0a0a0;
    }
    .gm-log-box {
      height: 140px;
      overflow-y: auto;
      background-color: #1e1e1e;
      color: #cccccc;
      border: 1px solid #7a7a7a;
      padding: 8px;
      font-family: 'Consolas', monospace;
      font-size: 11px;
      white-space: pre-wrap;
    }
    .gm-canvas-overlay {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

export function loadCustomFontFile(fontPath: string): void {
  if (!fontPath) {
    state.customFontName = "Roboto Condensed Bold";
    renderWysiwygCanvas();
    return;
  }
  const baseName = fontPath.split(/[\\/]/).pop()?.split(".")[0] || "CustomFont";
  const convertedUrl = PH.convertFileSrc(fontPath);
  const newFace = new FontFace(baseName, `url(${convertedUrl})`);
  newFace
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      state.customFontName = baseName;
      logConsole(`Loaded custom font: ${baseName}`, "success");
      renderWysiwygCanvas();
    })
    .catch(() => {
      logConsole(`Failed to load font file: ${fontPath}`, "error");
    });
}

export interface CaptionResult {
  canvas: HTMLCanvasElement;
  captionH: number;
  lines: string[];
}

export function buildCaptionCanvas(
  txt: string,
  originalW: number,
  captionStyle = "ifunny",
  customSize?: number
): CaptionResult {
  const isOverlay = captionStyle.startsWith("overlay");
  const fontSize = customSize ? Math.round(customSize) : Math.round(originalW / 10);
  const lineH = fontSize * 1.2;
  const padY = lineH * 0.45;
  const padX = fontSize * 0.6;
  const textMaxW = originalW - padX * 2;
  const fontStr = `bold ${fontSize}px '${state.customFontName}', 'Roboto Condensed Bold', Arial, sans-serif`;

  const measureCtx = document.createElement("canvas").getContext("2d")!;
  measureCtx.font = fontStr;

  const lines: string[] = [];
  txt.split("\n").forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      return;
    }
    let cur = "";
    words.forEach((word) => {
      if (measureCtx.measureText(word).width > textMaxW) {
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        let partial = "";
        for (let c = 0; c < word.length; c++) {
          const ch = word[c];
          if (measureCtx.measureText(partial + ch).width > textMaxW) {
            if (partial) lines.push(partial);
            partial = ch;
          } else {
            partial += ch;
          }
        }
        if (partial) cur = partial;
        return;
      }
      const test = cur ? cur + " " + word : word;
      if (measureCtx.measureText(test).width > textMaxW && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    });
    if (cur) lines.push(cur);
  });
  if (!lines.length) lines.push(" ");

  const captionH = lines.length * lineH + padY * 2;

  const canvas = document.createElement("canvas");
  canvas.width = originalW;
  canvas.height = Math.ceil(captionH);
  const ctx = canvas.getContext("2d")!;

  if (isOverlay) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = fontStr;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    lines.forEach((line, i) => {
      const x = originalW / 2;
      const y = padY + i * lineH + lineH / 2;

      ctx.strokeStyle = "#000000";
      ctx.lineWidth = Math.max(3, Math.round(fontSize / 6));
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, y, textMaxW);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, x, y, textMaxW);
    });
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = fontStr;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => {
      ctx.fillText(line, originalW / 2, padY + i * lineH + lineH / 2, textMaxW);
    });
  }

  return { canvas, captionH, lines };
}

export function updateOverlayPosition(): void {
  const mediaEl =
    state.currentMedia && state.currentMedia.type === "video"
      ? el("gm-preview-video")
      : el("gm-preview-img");
  const container = el("gm-overlay-interactive");
  const wrapper = el("gm-composition-wrapper");
  const ifunnyBar = el("gm-ifunny-bar");
  const bottomOverlay = el("gm-bottom-overlay");
  const parent = el("gm-drop-zone");

  if (!mediaEl || !container || !state.currentMedia || !parent || !wrapper || !ifunnyBar || !bottomOverlay) {
    return;
  }

  if (mediaEl.style.display === "none") {
    container.style.display = "none";
    return;
  }

  const parentRect = parent.getBoundingClientRect();
  const maxW = parentRect.width - 24;
  const maxH = parentRect.height - 24;

  const originalW = state.currentMedia.width || 400;
  const originalH = state.currentMedia.height || 400;

  const txt = el<HTMLTextAreaElement>("gm-inp-caption-text")?.value || "";
  const captionStyle = el<HTMLSelectElement>("gm-inp-caption-style")?.value || "ifunny";

  let captionH = 0;
  let captionDataUrl: string | null = null;

  if (txt.trim() && captionStyle === "ifunny") {
    const built = buildCaptionCanvas(txt, originalW);
    captionH = built.captionH;
    captionDataUrl = built.canvas.toDataURL("image/png");
  }

  const totalOriginalH = originalH + captionH;
  const scale = Math.min(maxW / originalW, maxH / totalOriginalH);

  const displayW = Math.round(originalW * scale);
  const displayH = Math.round((displayW * originalH) / originalW);
  const displayCaptionH = Math.round(captionH * scale);

  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.width = displayW + "px";
  wrapper.style.height = displayH + displayCaptionH + "px";
  wrapper.style.maxWidth = "";
  wrapper.style.maxHeight = "";
  wrapper.style.transform = "";

  if (captionDataUrl && captionStyle === "ifunny") {
    bottomOverlay.style.display = "none";
    ifunnyBar.style.display = "block";
    ifunnyBar.style.width = displayW + "px";
    ifunnyBar.style.height = displayCaptionH + "px";
    ifunnyBar.style.padding = "0";
    ifunnyBar.style.fontSize = "";
    ifunnyBar.style.backgroundImage = `url('${captionDataUrl}')`;
    ifunnyBar.style.backgroundSize = "100% 100%";
    ifunnyBar.style.backgroundRepeat = "no-repeat";
    ifunnyBar.textContent = "";
  } else if (txt.trim() && captionStyle !== "ifunny") {
    ifunnyBar.style.display = "none";
    bottomOverlay.style.display = "block";
    const sizeNum = el<HTMLInputElement>("gm-inp-caption-size-num");
    const overlaySize = sizeNum ? parseInt(sizeNum.value) : Math.round(displayW / 10);
    bottomOverlay.textContent = txt;
    bottomOverlay.style.fontSize = overlaySize + "px";
    bottomOverlay.style.setProperty("--stroke-w", Math.max(2, Math.round(overlaySize / 6)) + "px");
    bottomOverlay.style.padding = "0px";

    if (captionStyle === "overlay_top") {
      bottomOverlay.style.top = "15px";
      bottomOverlay.style.bottom = "auto";
      bottomOverlay.style.transform = "none";
    } else if (captionStyle === "overlay_center") {
      bottomOverlay.style.top = "50%";
      bottomOverlay.style.bottom = "auto";
      bottomOverlay.style.transform = "translateY(-50%)";
    } else {
      bottomOverlay.style.bottom = "15px";
      bottomOverlay.style.top = "auto";
      bottomOverlay.style.transform = "none";
    }
  } else {
    ifunnyBar.style.display = "none";
    bottomOverlay.style.display = "none";
  }

  mediaEl.style.width = displayW + "px";
  mediaEl.style.height = displayH + "px";
  mediaEl.style.maxWidth = "";
  mediaEl.style.maxHeight = "";

  container.style.display = "block";

  if (state.cropState.needsReset) {
    state.cropState.x = 0;
    state.cropState.y = 0;
    state.cropState.w = displayW;
    state.cropState.h = displayH;
    state.cropState.needsReset = false;

    const r = el("gm-crop-rect");
    if (r) {
      r.style.left = "0px";
      r.style.top = "0px";
      r.style.width = displayW + "px";
      r.style.height = displayH + "px";
    }

    const inX = el<HTMLInputElement>("gm-inp-crop-x");
    const inY = el<HTMLInputElement>("gm-inp-crop-y");
    const inW = el<HTMLInputElement>("gm-inp-crop-w");
    const inH = el<HTMLInputElement>("gm-inp-crop-h");
    if (inX) inX.value = "0";
    if (inY) inY.value = "0";
    if (inW) inW.value = String(Math.round(displayW));
    if (inH) inH.value = String(Math.round(displayH));
  }
}

export function renderWysiwygCanvas(): void {
  updateOverlayPosition();
}

export function setupInteractiveCrop(): void {
  const rect = el("gm-crop-rect");
  const handle = el("gm-crop-resize-handle");
  const container = el("gm-overlay-interactive");
  if (!rect || !handle || !container) return;

  const updateVisuals = () => {
    rect.style.left = state.cropState.x + "px";
    rect.style.top = state.cropState.y + "px";
    rect.style.width = state.cropState.w + "px";
    rect.style.height = state.cropState.h + "px";

    const inX = el<HTMLInputElement>("gm-inp-crop-x");
    const inY = el<HTMLInputElement>("gm-inp-crop-y");
    const inW = el<HTMLInputElement>("gm-inp-crop-w");
    const inH = el<HTMLInputElement>("gm-inp-crop-h");
    if (inX) inX.value = String(Math.round(state.cropState.x));
    if (inY) inY.value = String(Math.round(state.cropState.y));
    if (inW) inW.value = String(Math.round(state.cropState.w));
    if (inH) inH.value = String(Math.round(state.cropState.h));
  };

  rect.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    e.preventDefault();
    rect.setPointerCapture(e.pointerId);
    state.cropState.dragging = true;
    state.cropState.startX = e.clientX - state.cropState.x;
    state.cropState.startY = e.clientY - state.cropState.y;
  });

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    state.cropState.resizing = true;
    state.cropState.startW = state.cropState.w;
    state.cropState.startH = state.cropState.h;
    state.cropState.startX = e.clientX;
    state.cropState.startY = e.clientY;
  });

  window.addEventListener("pointermove", (e) => {
    const box = container.getBoundingClientRect();
    if (state.cropState.dragging && state.cropState.startX !== undefined && state.cropState.startY !== undefined) {
      state.cropState.x = Math.max(0, Math.min(box.width - state.cropState.w, e.clientX - state.cropState.startX));
      state.cropState.y = Math.max(0, Math.min(box.height - state.cropState.h, e.clientY - state.cropState.startY));
      updateVisuals();
    }
    if (
      state.cropState.resizing &&
      state.cropState.startW !== undefined &&
      state.cropState.startH !== undefined &&
      state.cropState.startX !== undefined &&
      state.cropState.startY !== undefined
    ) {
      state.cropState.w = Math.max(
        20,
        Math.min(box.width - state.cropState.x, state.cropState.startW + (e.clientX - state.cropState.startX))
      );
      state.cropState.h = Math.max(
        20,
        Math.min(box.height - state.cropState.y, state.cropState.startH + (e.clientY - state.cropState.startY))
      );
      updateVisuals();
    }
  });

  window.addEventListener("pointerup", () => {
    state.cropState.dragging = false;
    state.cropState.resizing = false;
  });

  updateVisuals();
}
