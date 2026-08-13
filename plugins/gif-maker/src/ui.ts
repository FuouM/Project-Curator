/**
 * UI layout, events, crop logic, and canvas assembly for gif-maker.
 */

import { state, TAB_ID, workspaceRoot, pluginDir } from "./state";
import {
  createLogger,
  formatBytes,
  pollTranscodeProgress,
  setupDropZone as _setupDropZone,
  pickDirectory,
  pickFile,
} from "../../lib";

const PH = window.PluginHost;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export const logConsole = createLogger("gm-console");

// Global event registers for click handlers inside compiled HTML templates
(window as any).GifMaker_moveFrame = (idx: number, dir: number) => {
  const target = idx + dir;
  if (target < 0 || target >= state.droppedFrames.length) return;
  const temp = state.droppedFrames[idx];
  state.droppedFrames[idx] = state.droppedFrames[target];
  state.droppedFrames[target] = temp;
  renderDroppedFrames();
};

(window as any).GifMaker_removeFrame = (idx: number) => {
  state.droppedFrames.splice(idx, 1);
  renderDroppedFrames();
};

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

interface CaptionResult {
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

export function previewMediaFile(filePath: string): void {
  if (!filePath) return;
  logConsole(`Detecting media file: ${filePath}`, "info");

  const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(filePath);
  state.cropState.needsReset = true;
  state.currentMedia = {
    path: filePath,
    type: isVideo ? "video" : "image",
    width: 0,
    height: 0,
  };

  const contentPanel = el("gm-panel-content");
  contentPanel?.removeAttribute("data-mounted-tool");

  const img = el<HTMLImageElement>("gm-preview-img")!;
  const vid = el<HTMLVideoElement>("gm-preview-video")!;
  const empty = el("gm-empty-state")!;

  const container = el("gm-drop-zone");
  if (container) {
    container.style.background = "#202020";
    container.style.padding = "0px";
    container.style.alignItems = "center";
    container.style.justifyContent = "center";
  }

  empty.style.display = "none";
  const wrapper = el("gm-composition-wrapper");
  if (wrapper) wrapper.style.display = "flex";

  let absolutePath = filePath;
  if (filePath && !/^[a-zA-Z]:[\\/]/.test(filePath) && !filePath.startsWith("\\\\")) {
    absolutePath = workspaceRoot + "\\" + filePath;
  }

  const safeUrl = PH.convertFileSrc(absolutePath);
  console.log("gif-maker path debug:", {
    workspaceRoot,
    filePath,
    absolutePath,
    safeUrl
  });

  if (isVideo) {
    img.style.display = "none";
    vid.style.display = "block";
    vid.src = safeUrl;
    vid.onloadedmetadata = () => {
      state.currentMedia!.width = vid.videoWidth;
      state.currentMedia!.height = vid.videoHeight;
      logConsole(`Loaded video metadata: ${vid.videoWidth}x${vid.videoHeight}`, "success");

      PH.callService("GetMediaMetadata", { path: filePath })
        .then((resp) => {
          if (resp && resp.MediaMetadataResult) {
            state.currentMedia!.durationMs = resp.MediaMetadataResult.duration_ms;
            state.currentMedia!.fps = resp.MediaMetadataResult.fps;
            state.currentMedia!.totalFrames = resp.MediaMetadataResult.total_frames;
            logConsole(
              `Probed media: ${(state.currentMedia!.durationMs! / 1000).toFixed(2)}s, ${state.currentMedia!.fps!.toFixed(
                2
              )} fps, ${state.currentMedia!.totalFrames} frames`,
              "success"
            );
            if (state.currentTool === "trim") {
              const cp = el("gm-panel-content");
              cp?.removeAttribute("data-mounted-tool");
              setupToolboxPane();
            }
          } else if (resp && resp.Error) {
            logConsole(`Failed to probe video details: ${resp.Error.message}`, "error");
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          logConsole(`Failed to probe video details: ${msg}`, "error");
        });

      setupToolboxPane();
      setTimeout(updateOverlayPosition, 80);
    };
  } else {
    const isAnimated = /\.(gif|webp)$/i.test(filePath);
    if (isAnimated) {
      PH.callService("GetMediaMetadata", { path: filePath })
        .then((resp) => {
          if (resp && resp.MediaMetadataResult) {
            state.currentMedia!.durationMs = resp.MediaMetadataResult.duration_ms;
            state.currentMedia!.fps = resp.MediaMetadataResult.fps;
            state.currentMedia!.totalFrames = resp.MediaMetadataResult.total_frames;
            logConsole(
              `Probed animated image: ${(state.currentMedia!.durationMs! / 1000).toFixed(
                2
              )}s, ${state.currentMedia!.fps!.toFixed(2)} fps, ${state.currentMedia!.totalFrames} frames`,
              "success"
            );
            if (state.currentTool === "trim") {
              const cp = el("gm-panel-content");
              cp?.removeAttribute("data-mounted-tool");
              setupToolboxPane();
            }
          } else if (resp && resp.Error) {
            logConsole(`Failed to probe animated image: ${resp.Error.message}`, "error");
          }
        })
        .catch(() => {
          // ignore silently for static images
        });
    }

    vid.style.display = "none";
    img.style.display = "block";
    img.src = safeUrl;
    img.onload = () => {
      state.currentMedia!.width = img.naturalWidth;
      state.currentMedia!.height = img.naturalHeight;
      logConsole(`Loaded image metadata: ${img.naturalWidth}x${img.naturalHeight}`, "success");
      setupToolboxPane();
      setTimeout(updateOverlayPosition, 80);
    };
  }

  setTimeout(renderWysiwygCanvas, 100);
}

export function renderDroppedFrames(): void {
  const container = el("gm-maker-frame-list");
  if (!container) return;

  if (state.droppedFrames.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:12px; color:#808080;">No frames loaded. Drop files to begin.</div>`;
    return;
  }

  container.innerHTML = "";
  state.droppedFrames.forEach((path, idx) => {
    const card = document.createElement("div");
    card.className = "gm-frame-item";
    card.innerHTML = `
      <img class="gm-frame-img" src="${PH.convertFileSrc(path)}" />
      <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${path}">Frame ${
      idx + 1
    }: ${path.split(/[\\/]/).pop()}</span>
      <div style="display:flex; gap:2px;">
        <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, -1)"><i class="bi bi-arrow-up"></i></button>
        <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, 1)"><i class="bi bi-arrow-down"></i></button>
        <button type="button" class="win-button danger" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_removeFrame(${idx})"><i class="bi bi-trash"></i></button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function getTempOutputPath(targetExt: string): Promise<string> {
  const rand = Math.floor(Math.random() * 1e7).toString(36);
  return `.curator\\temp_gif\\temp_gif_${rand}.${targetExt}`;
}

async function compileImagesToAnimation(): Promise<void> {
  const patternInput = el<HTMLInputElement>("gm-inp-seq-pattern");
  const pattern = patternInput ? patternInput.value.trim() : state.sequencePattern;
  if (!pattern) {
    logConsole("Error: No sequence pattern entered. Example: D:\\renders\\frame_%05d.png", "error");
    return;
  }
  state.sequencePattern = pattern;

  const fps = parseFloat(el<HTMLInputElement>("gm-inp-fps")?.value || "24");
  const loop = parseInt(el<HTMLInputElement>("gm-inp-loop")?.value || "0");
  const format = el<HTMLSelectElement>("gm-inp-maker-format")?.value || "gif";

  const jobId = "make_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole("Compiling sequence: " + pattern, "info");
  const resp = await PH.callService("CreateGifFromImages", {
    job_id: jobId,
    image_pattern: pattern,
    frame_rate: fps,
    output_path: tempPath,
    width: null,
    height: null,
    loop_count: loop,
    target_format: format,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Compiled sequence", tempPath);
  }
}

async function compileMakerVideo(): Promise<void> {
  if (!state.currentMedia) {
    logConsole("Error: No video loaded.", "error");
    return;
  }

  const keepNativeFps = el<HTMLInputElement>("gm-chk-native-fps")?.checked || false;
  const fps = keepNativeFps ? null : parseInt(el<HTMLInputElement>("gm-inp-fps")?.value || "15");
  const loop = parseInt(el<HTMLInputElement>("gm-inp-loop")?.value || "0");
  const format = el<HTMLSelectElement>("gm-inp-maker-format")?.value || "gif";

  const jobId = "maker_vid_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole(`Compiling video to ${format.toUpperCase()}...`, "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: null,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: format,
    loop_count: loop,
    fps: fps,
    trim_start: null,
    trim_end: null,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Compiled video", tempPath);
  }
}

async function handleTrimVideo(): Promise<void> {
  if (!state.currentMedia) return;
  const start = parseFloat(el<HTMLInputElement>("gm-inp-trim-start")?.value || "0");
  const end = parseFloat(el<HTMLInputElement>("gm-inp-trim-end")?.value || "10");
  const fps = parseInt(el<HTMLInputElement>("gm-inp-trim-fps")?.value || "10");
  const format = el<HTMLSelectElement>("gm-inp-trim-format")?.value || "gif";

  const jobId = "trim_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole(`Trimming video to ${format.toUpperCase()}...`, "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: null,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: format,
    loop_count: 0,
    fps: fps,
    trim_start: start > 0 ? start : null,
    trim_end: end > 0 ? end : null,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Trimmed & converted video", tempPath);
  }
}

async function handleApplyCrop(): Promise<void> {
  if (!state.currentMedia) return;

  const container = el("gm-overlay-interactive");
  if (!container || state.currentMedia.width === 0) return;

  const containerWidth = container.clientWidth || 1;
  const containerHeight = container.clientHeight || 1;

  const scaleX = state.currentMedia.width / containerWidth;
  const scaleY = state.currentMedia.height / containerHeight;

  const xVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-x")?.value || "0");
  const yVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-y")?.value || "0");
  const wVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-w")?.value || "100");
  const hVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-h")?.value || "100");

  const x = Math.round(xVal * scaleX);
  const y = Math.round(yVal * scaleY);
  const w = Math.round(wVal * scaleX);
  const h = Math.round(hVal * scaleY);

  const jobId = "crop_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying crop filter...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: `${w}:${h}:${x}:${y}`,
    scale: null,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, `Cropped canvas to ${w}x${h}`, tempPath);
  }
}

async function handleApplyCaption(): Promise<void> {
  if (!state.currentMedia) return;
  const txt = el<HTMLTextAreaElement>("gm-inp-caption-text")?.value || "";
  const captionStyle = el<HTMLSelectElement>("gm-inp-caption-style")?.value || "ifunny";

  if (!txt.trim()) {
    logConsole("Warning: No caption text inputted.", "error");
    return;
  }

  const sizeInp = el<HTMLInputElement>("gm-inp-caption-size-num");
  const sizeVal = sizeInp ? parseInt(sizeInp.value) : 28;

  const displayW = el("gm-composition-wrapper")?.clientWidth || 400;
  const originalW = state.currentMedia.width || 400;
  const scale = displayW > 0 ? originalW / displayW : 1;
  const originalFontSize = Math.round(sizeVal * scale);

  const built = buildCaptionCanvas(txt, originalW, captionStyle, originalFontSize);
  const base64Png = built.canvas.toDataURL("image/png");
  const originalCaptionHeight = built.captionH;

  const jobId = "caption_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Rendering text caption from Canvas PNG...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: null,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: base64Png,
    caption_image_height: Math.ceil(originalCaptionHeight),
    caption_style: captionStyle,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, `Applied ${captionStyle} caption`, tempPath);
  }
}

async function handleApplyEffects(): Promise<void> {
  if (!state.currentMedia) return;
  const speed = parseFloat(el<HTMLInputElement>("gm-inp-speed")?.value || "1.0");
  const rotate = el<HTMLSelectElement>("gm-inp-rotate")?.value || null;
  const reverse = el<HTMLInputElement>("gm-inp-reverse")?.checked || false;
  const bounce = el<HTMLInputElement>("gm-inp-bounce")?.checked || false;
  const grayscale = el<HTMLInputElement>("gm-inp-grayscale")?.checked || false;
  const invert = el<HTMLInputElement>("gm-inp-invert")?.checked || false;

  const jobId = "effects_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying layout and speed transformations...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: null,
    speed_multiplier: speed,
    reverse: reverse,
    bounce: bounce,
    rotate: rotate ? rotate : null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: grayscale,
    invert: invert,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Applied effects & speed adjustment", tempPath);
  }
}

async function handleApplyOptimize(): Promise<void> {
  if (!state.currentMedia) return;
  const colors = parseInt(el<HTMLSelectElement>("gm-inp-colors")?.value || "256");
  const dither = el<HTMLSelectElement>("gm-inp-dither")?.value || "floyd_steinberg";
  const dropFrames = parseInt(el<HTMLSelectElement>("gm-inp-drop-frames")?.value || "1");

  const jobId = "optimize_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying dither/colors reduction...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: null,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: colors,
    dither_type: dither,
    drop_frames_factor: dropFrames,
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Optimized color reduction", tempPath);
  }
}

async function handleSplitGif(): Promise<void> {
  if (!state.currentMedia) return;
  const dirInput = el<HTMLInputElement>("gm-inp-split-dir");
  let outDir = dirInput ? dirInput.value.trim() : "";
  if (!outDir) {
    outDir = state.currentMedia.path.replace(/[\/\\][^\/\\]+$/, "") || ".";
  }
  const jobId = "split_" + Date.now();
  logConsole("Extracting frames to folder: " + outDir, "info");

  const resp = await PH.callService("SplitGif", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_dir: outDir,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Split frames to directory", outDir);
  }
}

async function handleExportResize(): Promise<void> {
  if (!state.currentMedia) return;
  const w = parseInt(el<HTMLInputElement>("gm-inp-resize-w")?.value || "");
  const h = parseInt(el<HTMLInputElement>("gm-inp-resize-h")?.value || "");
  const format = el<HTMLSelectElement>("gm-inp-export-format")?.value || "gif";

  const jobId = "export_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  const scaleStr = w && h ? w + ":" + h : null;

  logConsole("Compiling export dimensions scaling...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: null,
    scale: scaleStr,
    speed_multiplier: null,
    reverse: false,
    bounce: false,
    rotate: null,
    brightness: null,
    contrast: null,
    saturation: null,
    grayscale: false,
    invert: false,
    caption_image_base64: null,
    caption_image_height: null,
    caption_style: null,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: format,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Resized & converted export file", tempPath);
  }
}

async function handleSaveFinal(): Promise<void> {
  if (state.historyIndex < 0 || state.historyIndex >= state.history.length) return;
  const activeState = state.history[state.historyIndex];

  if (!window.__TAURI__ || !window.__TAURI__.core) {
    logConsole("Tauri core API not available.", "error");
    return;
  }

  const srcName = activeState.path.split(/[\\/]/).pop() || "output";
  const ext = srcName.split(".").pop()?.toLowerCase() || "gif";
  const baseName = srcName.substring(0, srcName.lastIndexOf(".")) || srcName;
  const suggestedName = baseName + "." + ext;

  const extMap: Record<string, string[]> = {
    gif: ["gif"],
    mp4: ["mp4"],
    webm: ["webm"],
    webp: ["webp"],
    png: ["png"],
    jpg: ["jpg", "jpeg"],
    jpeg: ["jpg", "jpeg"],
  };
  const filterExts = extMap[ext] || [ext];
  const filterName = ext.toUpperCase() + " File";

  const finalDest = await window.__TAURI__.core.invoke("save_file_dialog", {
    suggestedName,
    filterName,
    extensions: filterExts,
  }).catch((err: unknown) => {
    logConsole("Save dialog error: " + err, "error");
    return null;
  });

  if (!finalDest) return;

  logConsole("Saving final compiled media to disk...", "info");
  const resp = await PH.callService("PathExists", { path: activeState.path });
  if (resp && resp.PathExistsResult && resp.PathExistsResult.exists) {
    const copyResp = await PH.callService("EphemeralConvertImages", {
      conversions: [[activeState.path, finalDest]],
      quality: 100,
    });
    if (
      copyResp &&
      copyResp.ConvertImagesResult &&
      copyResp.ConvertImagesResult.converted.length > 0
    ) {
      const fileInfo = copyResp.ConvertImagesResult.converted[0];
      if (fileInfo.error) {
        logConsole("Save failed: " + fileInfo.error, "error");
      } else {
        logConsole("Saved successfully to " + fileInfo.output_path, "success");
      }
    } else {
      logConsole("Save operation returned empty results.", "error");
    }
  } else {
    logConsole("Source temp file is missing or expired.", "error");
  }
}

export function pollCompilationProgress(jobId: string, description: string, filePath: string): void {
  const bar = el("gm-progress-bar");
  const text = el("gm-progress-text");
  const startTime = Date.now();

  state.activeJobId = jobId;

  pollTranscodeProgress({
    jobId,
    onTick: (progress) => {
      const pct = progress.percent;
      if (bar) bar.style.width = pct + "%";
      if (text) text.textContent = pct + "%";
    },
    onComplete: (ok, lastProgress) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      state.activeJobId = null;

      if (!ok) {
        logConsole(`Job Failed (took ${elapsed}s)`, "error");
        if (bar) bar.style.width = "0%";
        if (text) text.textContent = "0%";
        return;
      }

      logConsole(`Compilation completed successfully! (took ${elapsed}s)`, "success");
      if (bar) bar.style.width = "100%";
      if (text) text.textContent = "100%";

      const finalPath = (lastProgress?.raw?.output_path as string) || filePath;
      if (finalPath.endsWith("_frames") || jobId.startsWith("split_")) {
        logConsole(`Frames generated inside folder ${finalPath}`, "success");
      } else {
        void pushHistoryState(finalPath, description);
      }
    },
  });
}

export async function pushHistoryState(filePath: string, description: string): Promise<void> {
  if (state.historyIndex < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyIndex + 1);
  }

  let size = null;
  if (window.__TAURI__ && window.__TAURI__.core) {
    try {
      size = await window.__TAURI__.core.invoke("get_file_size", { path: filePath });
    } catch {
      // ignore silently
    }
  }

  state.history.push({ path: filePath, description, fileSize: size });
  state.historyIndex = state.history.length - 1;
  restoreHistoryState();
}

export function restoreHistoryState(): void {
  const root = el("view-extensions-" + TAB_ID);
  if (!root) return;

  const list = root.querySelector("#gm-hist-list");
  const btnUndo = root.querySelector<HTMLButtonElement>("#gm-btn-undo");
  const btnRedo = root.querySelector<HTMLButtonElement>("#gm-btn-redo");
  const btnSave = root.querySelector<HTMLButtonElement>("#gm-btn-save-final");

  if (!list || !btnUndo || !btnRedo || !btnSave) return;

  if (state.history.length === 0) {
    list.innerHTML = `<div style="color:#808080; padding:6px; font-style:italic;">No files loaded.</div>`;
    btnUndo.disabled = true;
    btnRedo.disabled = true;
    btnSave.disabled = true;
    const container = el("gm-drop-zone");
    if (container) {
      container.style.background = "var(--sys-window-bg, #f0f0f0)";
      container.style.padding = "12px";
      container.style.alignItems = "stretch";
      container.style.justifyContent = "stretch";
    }
    const empty = el("gm-empty-state");
    if (empty) empty.style.display = "flex";
    const img = el("gm-preview-img");
    const wrapper = el("gm-composition-wrapper");
    if (wrapper) wrapper.style.display = "none";
    if (img) img.style.display = "none";
    const vid = el<HTMLVideoElement>("gm-preview-video");
    if (vid) {
      vid.style.display = "none";
      vid.src = "";
    }
    state.currentMedia = null;
    return;
  }

  list.innerHTML = "";
  state.history.forEach((histState, idx) => {
    const item = document.createElement("div");
    item.className = "gm-history-item" + (idx === state.historyIndex ? " active" : "");
    const name = histState.path.split(/[\\/]/).pop();
    const sizeStr = histState.fileSize ? " (" + formatBytes(histState.fileSize) + ")" : "";
    item.innerHTML = `
      <span>${histState.description}</span>
      <span style="color:#666; font-size:10px;">${name}${sizeStr}</span>
    `;
    item.addEventListener("click", () => {
      state.historyIndex = idx;
      restoreHistoryState();
    });
    list.appendChild(item);
  });

  btnUndo.disabled = state.historyIndex <= 0;
  btnRedo.disabled = state.historyIndex >= state.history.length - 1;
  btnSave.disabled = state.historyIndex < 0;

  const activeState = state.history[state.historyIndex];
  previewMediaFile(activeState.path);
}

export async function handleLoadSelection(): Promise<void> {
  logConsole("Fetching selected gallery assets...", "info");
  const selection = await PH.getSelectionAssetContexts();
  if (!selection || selection.length === 0) {
    logConsole("Error: Select files in the main gallery first.", "error");
    return;
  }

  if (state.currentTool === "maker") {
    state.droppedFrames = selection.map((asset) => asset.path);
    logConsole(`Loaded ${state.droppedFrames.length} frames to the GIF Maker frame pool.`, "success");
    renderDroppedFrames();
  } else {
    void pushHistoryState(selection[0].path, "Imported selected file");
  }
}

export async function handleBrowseFile(): Promise<void> {
  try {
    const path = await pickFile();
    if (path) {
      if (state.currentTool === "maker") {
        if (/\.(png|jpe?g|webp|gif)$/i.test(path)) {
          state.droppedFrames.push(path);
          logConsole("Added frame: " + path.split(/[\\/]/).pop(), "success");
          renderDroppedFrames();
        } else {
          logConsole("Error: Select an image file to add to GIF Maker frames.", "error");
        }
      } else {
        void pushHistoryState(path, "Opened file: " + path.split(/[\\/]/).pop());
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logConsole("Browse file error: " + msg, "error");
  }
}

export function setupToolboxPane(): void {
  const title = el("gm-control-title");
  const content = el("gm-panel-content");
  const rect = el("gm-crop-rect");
  const container = el("gm-overlay-interactive");
  if (!title || !content) return;

  const prevVid = el<HTMLVideoElement>("gm-preview-video");
  if (prevVid && (window as any).__gm_timeupdate_listener) {
    prevVid.removeEventListener("timeupdate", (window as any).__gm_timeupdate_listener);
    (window as any).__gm_timeupdate_listener = null;
  }

  if (rect) rect.style.display = state.currentTool === "crop" ? "block" : "none";
  if (container) {
    container.style.pointerEvents = state.currentTool === "crop" ? "auto" : "none";
    setTimeout(updateOverlayPosition, 50);
  }

  const optimizeBtn = el<HTMLButtonElement>("gm-tool-optimize");
  const isGif = state.currentMedia && /\.gif$/i.test(state.currentMedia.path);
  if (optimizeBtn) {
    optimizeBtn.disabled = !isGif;
    optimizeBtn.title = isGif ? "" : "Optimize is only available for GIF files";
  }
  if (state.currentTool === "optimize" && !isGif) {
    state.currentTool = "maker";
    const tools = document.querySelectorAll(".gm-toolbar .win-button");
    tools.forEach((b) => b.classList.remove("active"));
    const makerBtn = el("gm-tool-maker");
    makerBtn?.classList.add("active");
    const panelContent = el("gm-panel-content");
    panelContent?.removeAttribute("data-mounted-tool");
  }

  const canvas = el<HTMLCanvasElement>("gm-preview-canvas");
  if (canvas && state.currentTool !== "caption") {
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  const mountedTool = content.getAttribute("data-mounted-tool");
  if (mountedTool === state.currentTool) {
    if (state.currentTool === "optimize" && state.currentMedia) {
      const beforeEl = content.querySelector("#gm-opt-size-before");
      if (beforeEl && window.__TAURI__?.core) {
        window.__TAURI__.core
          .invoke("get_file_size", { path: state.currentMedia.path })
          .then((size: number) => {
            if (size !== null && size !== undefined) {
              beforeEl.textContent = formatBytes(size);
            }
          })
          .catch(() => {});
      }
    }
    return;
  }
  content.setAttribute("data-mounted-tool", state.currentTool);

  switch (state.currentTool) {
    case "maker":
      if (state.currentMedia && state.currentMedia.type === "video") {
        title.textContent = "GIF / Video Maker";
        content.innerHTML = `
          <div style="flex: none; display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size:11px; color:#888; padding:4px 0; border-bottom:1px solid var(--sys-border-light,#d0d0d0); margin-bottom:2px;">
              <i class="bi bi-film"></i> Video loaded &mdash; converting to animation
            </div>

            <label style="font-size:11px; font-weight:bold;">Frame Rate (FPS)</label>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="win-input" id="gm-inp-fps" value="15" min="1" max="60" style="width:70px;" />
              <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer;">
                <input type="checkbox" id="gm-chk-native-fps" checked /> Keep original
              </label>
            </div>

            <label style="font-size:11px; font-weight:bold;">Loop Count</label>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="win-input" id="gm-inp-loop" value="0" style="width:70px;" />
              <span style="font-size:10px; color:#666;">(0 = Infinite, -1 = Once)</span>
            </div>

            <label style="font-size:11px; font-weight:bold;">Target Output Format</label>
            <select class="win-input" id="gm-inp-maker-format" style="width:100%;">
              <option value="gif">Animated GIF (.gif)</option>
              <option value="webp">Animated WebP (.webp) — Lossless</option>
              <option value="mp4">H.264 Video (.mp4)</option>
              <option value="webm">VP9 Video (.webm)</option>
            </select>

            <button type="button" class="win-button primary" id="gm-btn-compile-gif" style="width:100%; margin-top:4px; padding:4px 0;">
              <i class="bi bi-gear-wide-connected"></i> Compile to Animation
            </button>
          </div>
        `;
        content.querySelector("#gm-btn-compile-gif")?.addEventListener("click", () => void compileMakerVideo());
        const nativeFpsChk = content.querySelector<HTMLInputElement>("#gm-chk-native-fps")!;
        const fpsInp = content.querySelector<HTMLInputElement>("#gm-inp-fps")!;

        fpsInp.disabled = true;
        fpsInp.style.opacity = "0.4";

        nativeFpsChk.addEventListener("change", function () {
          fpsInp.disabled = this.checked;
          fpsInp.style.opacity = this.checked ? "0.4" : "1";
        });
      } else {
        title.textContent = "GIF / Video Maker";
        content.innerHTML = `
          <div style="flex: none; display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size:11px; color:#888; padding:4px 0; border-bottom:1px solid var(--sys-border-light,#d0d0d0); margin-bottom:2px;">
              <i class="bi bi-images"></i> Drop a video to convert it, or enter an image sequence pattern below.
            </div>

            <label style="font-size:11px; font-weight:bold;">Image Sequence Pattern</label>
            <input type="text" class="win-input" id="gm-inp-seq-pattern"
              placeholder="e.g. D:\\renders\\frame_%05d.png"
              value="${state.sequencePattern}"
              style="width:100%; font-size:10px; font-family:monospace;" />
            <div style="font-size:10px; color:#888;">Use printf-style numbering: <code>%04d</code>, <code>%05d</code>, etc.</div>

            <label style="font-size:11px; font-weight:bold; margin-top:4px;">Frame Rate (FPS)</label>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="win-input" id="gm-inp-fps" value="24" min="1" max="120" style="width:70px;" />
              <span style="font-size:11px;">frames per second</span>
            </div>

            <label style="font-size:11px; font-weight:bold;">Loop Count</label>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="win-input" id="gm-inp-loop" value="0" style="width:70px;" />
              <span style="font-size:10px; color:#666;">(0 = Infinite, -1 = Once)</span>
            </div>

            <label style="font-size:11px; font-weight:bold;">Target Output Format</label>
            <select class="win-input" id="gm-inp-maker-format" style="width:100%;">
              <option value="gif">Animated GIF (.gif)</option>
              <option value="webp">Animated WebP (.webp) — Lossless</option>
              <option value="mp4">H.264 Video (.mp4)</option>
              <option value="webm">VP9 Video (.webm)</option>
            </select>

            <button type="button" class="win-button primary" id="gm-btn-compile-gif" style="width:100%; margin-top:4px; padding:4px 0;">
              <i class="bi bi-gear-wide-connected"></i> Compile Sequence
            </button>
          </div>
        `;
        content.querySelector("#gm-inp-seq-pattern")?.addEventListener("input", function (this: HTMLInputElement) {
          state.sequencePattern = this.value.trim();
        });
        content.querySelector("#gm-btn-compile-gif")?.addEventListener("click", () => void compileImagesToAnimation());
      }
      break;

    case "trim":
      title.textContent = "Video Trimming & FPS";
      (() => {
        const fps = state.currentMedia && state.currentMedia.fps ? state.currentMedia.fps : 30.0;
        const dur = state.currentMedia && state.currentMedia.durationMs ? state.currentMedia.durationMs / 1000 : 10.0;
        const totalF =
          state.currentMedia && state.currentMedia.totalFrames
            ? state.currentMedia.totalFrames
            : Math.round(dur * fps);

        let activeExt =
          state.currentMedia && state.currentMedia.path ? state.currentMedia.path.split(".").pop()!.toLowerCase() : "gif";
        if (activeExt === "mov" || activeExt === "avi" || activeExt === "mkv") activeExt = "mp4";

        content.innerHTML = `
          <div style="font-size:11px; color:#555; background:var(--sys-window-bg,#f5f5f5); border:1px solid var(--sys-border-light,#d0d0d0); padding:6px; border-radius:2px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; border-bottom:1px dashed #d0d0d0; padding-bottom:3px; margin-bottom:3px;">
              <strong>Playhead:</strong> <span id="gm-trim-info-playhead" style="font-family:monospace; font-weight:bold; color:#dc3545;">0.00s (Frame 0)</span>
            </div>
            <div style="display:flex; justify-content:space-between;"><strong>Duration:</strong> <span>${
              state.currentMedia && state.currentMedia.durationMs ? (state.currentMedia.durationMs / 1000).toFixed(2) + "s" : "Unknown"
            }</span></div>
            <div style="display:flex; justify-content:space-between;"><strong>Total Frames:</strong> <span>${
              state.currentMedia && state.currentMedia.totalFrames ? state.currentMedia.totalFrames : "Unknown"
            }</span></div>
            <div style="display:flex; justify-content:space-between;"><strong>Probed FPS:</strong> <span>${
              state.currentMedia && state.currentMedia.fps ? state.currentMedia.fps.toFixed(2) : "Unknown"
            }</span></div>
          </div>

          <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:6px;">Timeline Range Selection</label>
          <div id="gm-trim-timeline" style="position:relative; height:20px; background:#e5e7eb; border:1px solid #ccc; border-radius:2px; margin-bottom:14px; user-select:none; -webkit-user-select:none;">
            <div id="gm-timeline-range" style="position:absolute; top:0; bottom:0; left:0%; right:0%; background:rgba(0, 120, 212, 0.25); border-left:2px solid #0078d4; border-right:2px solid #0078d4;"></div>
            <div id="gm-timeline-playhead" style="position:absolute; top:0; bottom:0; left:0%; width:2px; background:#dc3545; z-index:9; pointer-events:none;">
              <div style="position:absolute; top:-4px; left:-4px; width:10px; height:6px; background:#dc3545; clip-path:polygon(0% 0%, 100% 0%, 50% 100%);"></div>
            </div>
            <div id="gm-timeline-thumb-l" style="position:absolute; top:-3px; left:0%; width:10px; height:24px; background:#0078d4; border:1px solid #005a9e; border-radius:2px; cursor:ew-resize; box-shadow:0 1px 3px rgba(0,0,0,0.3); z-index:10;"></div>
            <div id="gm-timeline-thumb-r" style="position:absolute; top:-3px; left:100%; width:10px; height:24px; background:#0078d4; border:1px solid #005a9e; border-radius:2px; cursor:ew-resize; box-shadow:0 1px 3px rgba(0,0,0,0.3); z-index:10;"></div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Start Time (s)</label>
              <input type="number" class="win-input" id="gm-inp-trim-start" value="0" step="0.1" style="width:100%;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Start Frame</label>
              <input type="number" class="win-input" id="gm-inp-trim-start-frame" value="0" step="1" style="width:100%;" />
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">End Time (s)</label>
              <input type="number" class="win-input" id="gm-inp-trim-end" value="${dur.toFixed(2)}" step="0.1" style="width:100%;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">End Frame</label>
              <input type="number" class="win-input" id="gm-inp-trim-end-frame" value="${totalF}" step="1" style="width:100%;" />
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Frame Rate (FPS)</label>
              <select class="win-input" id="gm-inp-trim-fps" style="width:100%;">
                <option value="5" ${Math.round(fps) === 5 ? "selected" : ""}>5 FPS</option>
                <option value="10" ${Math.round(fps) === 10 ? "selected" : ""}>10 FPS</option>
                <option value="12" ${Math.round(fps) === 12 ? "selected" : ""}>12 FPS</option>
                <option value="15" ${Math.round(fps) === 15 ? "selected" : ""}>15 FPS</option>
                <option value="20" ${Math.round(fps) === 20 ? "selected" : ""}>20 FPS</option>
                <option value="25" ${Math.round(fps) === 25 ? "selected" : ""}>25 FPS</option>
                <option value="30" ${Math.round(fps) >= 30 || Math.round(fps) < 5 ? "selected" : ""}>30 FPS</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Output Format</label>
              <select class="win-input" id="gm-inp-trim-format" style="width:100%;">
                <option value="gif" ${activeExt === "gif" ? "selected" : ""}>GIF (.gif)</option>
                <option value="webp" ${activeExt === "webp" ? "selected" : ""}>WebP (.webp)</option>
                <option value="mp4" ${activeExt === "mp4" ? "selected" : ""}>MP4 (.mp4)</option>
                <option value="webm" ${activeExt === "webm" ? "selected" : ""}>WebM (.webm)</option>
              </select>
            </div>
          </div>
          <button type="button" class="win-button primary" id="gm-btn-apply-trim" style="width:100%; margin-top:4px;">
            <i class="bi bi-scissors"></i> Convert &amp; Trim Video
          </button>
        `;

        const tStart = content.querySelector<HTMLInputElement>("#gm-inp-trim-start")!;
        const fStart = content.querySelector<HTMLInputElement>("#gm-inp-trim-start-frame")!;
        const tEnd = content.querySelector<HTMLInputElement>("#gm-inp-trim-end")!;
        const fEnd = content.querySelector<HTMLInputElement>("#gm-inp-trim-end-frame")!;

        const timeline = content.querySelector<HTMLElement>("#gm-trim-timeline")!;
        const range = content.querySelector<HTMLElement>("#gm-timeline-range")!;
        const thumbL = content.querySelector<HTMLElement>("#gm-timeline-thumb-l")!;
        const thumbR = content.querySelector<HTMLElement>("#gm-timeline-thumb-r")!;

        let pctL = 0;
        let pctR = 100;

        function updateTimelineUI(): void {
          range.style.left = pctL + "%";
          range.style.width = pctR - pctL + "%";
          thumbL.style.left = `calc(${pctL}% - 5px)`;
          thumbR.style.left = `calc(${pctR}% - 5px)`;
        }

        function syncInputsFromTimeline(): void {
          const startS = (pctL / 100) * dur;
          const endS = (pctR / 100) * dur;

          tStart.value = startS.toFixed(2);
          fStart.value = String(Math.round(startS * fps));

          tEnd.value = endS.toFixed(2);
          fEnd.value = String(Math.round(endS * fps));
        }

        function syncTimelineFromInputs(): void {
          const startVal = parseFloat(tStart.value) || 0;
          const endVal = parseFloat(tEnd.value) || 0;

          pctL = Math.max(0, Math.min(100, (startVal / dur) * 100));
          pctR = Math.max(0, Math.min(100, (endVal / dur) * 100));

          if (pctL > pctR) pctL = pctR;

          updateTimelineUI();
        }

        thumbL.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          thumbL.setPointerCapture(e.pointerId);
          const onPointerMove = (ev: PointerEvent) => {
            const r = timeline.getBoundingClientRect();
            const relativeX = ev.clientX - r.left;
            const pct = (relativeX / r.width) * 100;
            pctL = Math.max(0, Math.min(pctR - 1, pct));
            updateTimelineUI();
            syncInputsFromTimeline();
          };
          const onPointerUp = (ev: PointerEvent) => {
            thumbL.releasePointerCapture(ev.pointerId);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
          };
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
        });

        thumbR.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          thumbR.setPointerCapture(e.pointerId);
          const onPointerMove = (ev: PointerEvent) => {
            const r = timeline.getBoundingClientRect();
            const relativeX = ev.clientX - r.left;
            const pct = (relativeX / r.width) * 100;
            pctR = Math.max(pctL + 1, Math.min(100, pct));
            updateTimelineUI();
            syncInputsFromTimeline();
          };
          const onPointerUp = (ev: PointerEvent) => {
            thumbR.releasePointerCapture(ev.pointerId);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
          };
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
        });

        tStart.addEventListener("input", function (this: HTMLInputElement) {
          const val = parseFloat(this.value) || 0;
          fStart.value = String(Math.round(val * fps));
          syncTimelineFromInputs();
        });
        fStart.addEventListener("input", function (this: HTMLInputElement) {
          const val = parseInt(this.value) || 0;
          tStart.value = (val / fps).toFixed(3);
          syncTimelineFromInputs();
        });

        tEnd.addEventListener("input", function (this: HTMLInputElement) {
          const val = parseFloat(this.value) || 0;
          fEnd.value = String(Math.round(val * fps));
          syncTimelineFromInputs();
        });
        fEnd.addEventListener("input", function (this: HTMLInputElement) {
          const val = parseInt(this.value) || 0;
          tEnd.value = (val / fps).toFixed(3);
          syncTimelineFromInputs();
        });

        const playhead = content.querySelector<HTMLElement>("#gm-timeline-playhead")!;
        const vid = el<HTMLVideoElement>("gm-preview-video");
        const playheadText = content.querySelector("#gm-trim-info-playhead");

        const updatePlayheadText = (timeSecs: number) => {
          if (playheadText) {
            const frameIdx = Math.round(timeSecs * fps);
            playheadText.textContent = timeSecs.toFixed(2) + "s (Frame " + frameIdx + ")";
          }
        };

        let evSeeking = false;
        const syncPlayheadWithVideo = () => {
          if (vid && !evSeeking && dur > 0) {
            const startVal = parseFloat(tStart.value) || 0;
            const endVal = parseFloat(tEnd.value) || dur;

            if (vid.currentTime > endVal || vid.currentTime < startVal) {
              vid.currentTime = startVal;
            }

            const pct = (vid.currentTime / dur) * 100;
            playhead.style.left = Math.max(0, Math.min(100, pct)) + "%";
            updatePlayheadText(vid.currentTime);
          }
        };

        if (vid) {
          (window as any).__gm_timeupdate_listener = syncPlayheadWithVideo;
          vid.addEventListener("timeupdate", syncPlayheadWithVideo);
        }

        const seekTimeline = (ev: MouseEvent) => {
          const r = timeline.getBoundingClientRect();
          if (r.width <= 0) return;
          let pct = ((ev.clientX - r.left) / r.width) * 100;
          pct = Math.max(0, Math.min(100, pct));
          playhead.style.left = pct + "%";
          const targetTime = (pct / 100) * dur;
          if (vid && dur > 0) {
            vid.currentTime = targetTime;
          }
          updatePlayheadText(targetTime);
        };

        timeline.addEventListener("pointerdown", (e) => {
          if (e.target === thumbL || e.target === thumbR) return;
          e.preventDefault();
          timeline.setPointerCapture(e.pointerId);
          evSeeking = true;
          seekTimeline(e);
          const onPointerMove = (ev: MouseEvent) => {
            seekTimeline(ev);
          };
          const onPointerUp = (ev: PointerEvent) => {
            timeline.releasePointerCapture(ev.pointerId);
            evSeeking = false;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
          };
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
        });

        syncTimelineFromInputs();

        content.querySelector("#gm-btn-apply-trim")?.addEventListener("click", () => void handleTrimVideo());
      })();
      break;

    case "crop":
      title.textContent = "Crop Canvas Coordinates";
      content.innerHTML = `
        <div style="font-size:10px; color:#666; margin-bottom:6px;">Drag/resize the overlay box in the preview or set exact pixel dimensions.</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
          <div>
            <label style="font-size:11px; font-weight:bold;">Left (X)</label>
            <input type="number" class="win-input" id="gm-inp-crop-x" value="50" style="width:100%;" />
          </div>
          <div>
            <label style="font-size:11px; font-weight:bold;">Top (Y)</label>
            <input type="number" class="win-input" id="gm-inp-crop-y" value="50" style="width:100%;" />
          </div>
          <div>
            <label style="font-size:11px; font-weight:bold;">Width</label>
            <input type="number" class="win-input" id="gm-inp-crop-w" value="200" style="width:100%;" />
          </div>
          <div>
            <label style="font-size:11px; font-weight:bold;">Height</label>
            <input type="number" class="win-input" id="gm-inp-crop-h" value="200" style="width:100%;" />
          </div>
        </div>
        <button type="button" class="win-button primary" id="gm-btn-apply-crop" style="width:100%;">
          <i class="bi bi-crop"></i> Apply Crop Boundary
        </button>
      `;

      const inX = content.querySelector<HTMLInputElement>("#gm-inp-crop-x")!;
      const inY = content.querySelector<HTMLInputElement>("#gm-inp-crop-y")!;
      const inW = content.querySelector<HTMLInputElement>("#gm-inp-crop-w")!;
      const inH = content.querySelector<HTMLInputElement>("#gm-inp-crop-h")!;
      [inX, inY, inW, inH].forEach((input) => {
        input.addEventListener("input", () => {
          state.cropState.x = parseFloat(inX.value) || 0;
          state.cropState.y = parseFloat(inY.value) || 0;
          state.cropState.w = parseFloat(inW.value) || 100;
          state.cropState.h = parseFloat(inH.value) || 100;
          const rectEl = el("gm-crop-rect");
          if (rectEl) {
            rectEl.style.left = state.cropState.x + "px";
            rectEl.style.top = state.cropState.y + "px";
            rectEl.style.width = state.cropState.w + "px";
            rectEl.style.height = state.cropState.h + "px";
          }
        });
      });
      content.querySelector("#gm-btn-apply-crop")?.addEventListener("click", () => void handleApplyCrop());
      break;

    case "caption":
      title.textContent = "Caption & Text Overlays";
      (() => {
        const displayW = el("gm-composition-wrapper")?.clientWidth || 400;
        const defaultSize = Math.max(8, Math.min(120, Math.round(displayW / 12)));

        content.innerHTML = `
          <label style="font-size:11px; font-weight:bold;">Caption Text</label>
          <textarea class="win-input" id="gm-inp-caption-text" rows="3" style="width:100%; margin-bottom:8px; font-size:12px;" placeholder="Caption goes here..."></textarea>
          
          <label style="font-size:11px; font-weight:bold;">Caption Layout Style</label>
          <select class="win-input" id="gm-inp-caption-style" style="width:100%; margin-bottom:8px;">
            <option value="ifunny" selected>iFunny Style (White top border)</option>
            <option value="overlay_top">Overlay Style - Top</option>
            <option value="overlay_center">Overlay Style - Center</option>
            <option value="overlay_bottom">Overlay Style - Bottom</option>
          </select>

          <!-- Overlay Options (shown only if layout is overlay_*) -->
          <div id="gm-caption-overlay-opts" style="display:none; margin-bottom:8px;">
            <div class="group-box" style="margin-bottom:8px; padding:6px;">
              <div class="group-box-title">Overlay Customizations</div>
              <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">Font Size</label>
              <div style="display:flex; align-items:center; gap:6px;">
                <input type="range" id="gm-inp-caption-size-range" min="8" max="120" value="${defaultSize}" style="flex:1;" />
                <input type="number" class="win-input" id="gm-inp-caption-size-num" value="${defaultSize}" min="8" style="width:50px; text-align:center;" />
                <span style="font-size:11px;">px</span>
              </div>
            </div>
          </div>
          
          <label style="font-size:11px; font-weight:bold;">Font Selection</label>
          <div style="display:flex; gap:6px; margin-bottom:8px;">
            <input type="text" class="win-input" id="gm-inp-caption-font" style="flex:1; font-size:11px;" placeholder="Roboto Condensed Bold (Default)" readonly />
            <button type="button" class="win-button" id="gm-btn-browse-font" style="font-size:11px;">Browse...</button>
          </div>

          <button type="button" class="win-button primary" id="gm-btn-apply-caption" style="width:100%;">
            <i class="bi bi-chat-square-text"></i> Render Caption Overlay
          </button>
        `;

        const txtArea = content.querySelector("#gm-inp-caption-text")!;
        const styleSel = content.querySelector<HTMLSelectElement>("#gm-inp-caption-style")!;
        const fontInp = content.querySelector<HTMLInputElement>("#gm-inp-caption-font")!;
        const browseFontBtn = content.querySelector("#gm-btn-browse-font")!;

        const overlayOpts = content.querySelector<HTMLElement>("#gm-caption-overlay-opts")!;
        const sizeRange = content.querySelector<HTMLInputElement>("#gm-inp-caption-size-range")!;
        const sizeNum = content.querySelector<HTMLInputElement>("#gm-inp-caption-size-num")!;

        function syncOverlayOptsVisibility(): void {
          if (styleSel.value.startsWith("overlay")) {
            overlayOpts.style.display = "block";
          } else {
            overlayOpts.style.display = "none";
          }
        }

        styleSel.addEventListener("change", () => {
          syncOverlayOptsVisibility();
          renderWysiwygCanvas();
        });

        sizeRange.addEventListener("input", function (this: HTMLInputElement) {
          sizeNum.value = this.value;
          renderWysiwygCanvas();
        });

        sizeNum.addEventListener("input", function (this: HTMLInputElement) {
          const val = Math.max(8, Math.min(120, parseInt(this.value) || 28));
          sizeRange.value = String(val);
          renderWysiwygCanvas();
        });

        [txtArea, styleSel].forEach((elem) => {
          elem.addEventListener("input", renderWysiwygCanvas);
        });

browseFontBtn.addEventListener("click", async () => {
          const path = await pickFile();
          if (path) {
            const ext = path.split(".").pop()!.toLowerCase();
            if (ext === "ttf" || ext === "otf") {
              const fileName = path.split(/[\\/]/).pop()!;
              fontInp.value = fileName;
              loadCustomFontFile(path);
            } else {
              logConsole("Warning: Please select a valid .ttf or .otf file.", "error");
            }
          }
        });
        content.querySelector("#gm-btn-apply-caption")?.addEventListener("click", () => void handleApplyCaption());
      })();
      break;

    case "effects":
      title.textContent = "Speed, Bounce, Filters";
      content.innerHTML = `
        <label style="font-size:11px; font-weight:bold;">Playback Speed</label>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <input type="range" id="gm-inp-speed" min="0.25" max="3" step="0.25" value="1.0" style="flex:1;" />
          <span id="gm-txt-speed" style="font-size:11px; width:40px;">1.0x</span>
        </div>

        <label style="font-weight:bold; font-size:11px;">Transpose / Rotation</label>
        <select class="win-input" id="gm-inp-rotate" style="width:100%; margin-bottom:8px;">
          <option value="">No rotation</option>
          <option value="90_cw">90° Clockwise</option>
          <option value="90_ccw">90° Counter-Clockwise</option>
          <option value="180">180° Flip</option>
          <option value="hflip">Flip Horizontally</option>
          <option value="vflip">Flip Vertically</option>
        </select>

        <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px;">
          <label style="font-size:11px;"><input type="checkbox" id="gm-inp-reverse" /> Reverse Direction</label>
          <label style="font-size:11px;"><input type="checkbox" id="gm-inp-bounce" /> Bounce Loop (Forward + Reverse)</label>
        </div>

        <div style="border-top:1px solid #d0d0d0; padding-top:6px; display:flex; flex-direction:column; gap:4px;">
          <label style="font-size:11px;"><input type="checkbox" id="gm-inp-grayscale" /> Grayscale</label>
          <label style="font-size:11px;"><input type="checkbox" id="gm-inp-invert" /> Negate (Invert Colors)</label>
        </div>

        <button type="button" class="win-button primary" id="gm-btn-apply-effects" style="width:100%; margin-top:8px;">
          <i class="bi bi-sliders"></i> Apply Speed & Filter Effects
        </button>
      `;
      const slider = content.querySelector<HTMLInputElement>("#gm-inp-speed")!;
      const valTxt = content.querySelector("#gm-txt-speed")!;
      slider.addEventListener("input", () => {
        valTxt.textContent = slider.value + "x";
      });
      content.querySelector("#gm-btn-apply-effects")?.addEventListener("click", () => void handleApplyEffects());
      break;

    case "optimize":
      title.textContent = "Optimize & Reduce Size";
      (() => {
        let sizeBefore = "Scanning...";
        let sizeAfter = "&mdash;";
        let compressionLine = "";

        if (state.historyIndex >= 0 && state.historyIndex < state.history.length) {
          const aState = state.history[state.historyIndex];
          if (aState.description.indexOf("Optimized") !== -1) {
            const pState = state.history[state.historyIndex - 1];
            sizeBefore = pState && pState.fileSize ? formatBytes(pState.fileSize) : "Unknown";
            sizeAfter = aState.fileSize ? formatBytes(aState.fileSize) : "Unknown";
            if (pState && pState.fileSize && aState.fileSize && pState.fileSize > 0) {
              const savedPct = (100 - (aState.fileSize / pState.fileSize) * 100).toFixed(1);
              const factor = (pState.fileSize / aState.fileSize).toFixed(2);
              compressionLine =
                parseFloat(savedPct) > 0
                  ? `<span style="color:#10b981;">&#8595; saved ${savedPct}% &mdash; ${factor}x smaller</span>`
                  : `<span style="color:#f87171;">&#8593; grew ${Math.abs(parseFloat(savedPct))}% &mdash; ${factor}x larger</span>`;
            }
          } else {
            sizeBefore = aState.fileSize ? formatBytes(aState.fileSize) : "Scanning...";
          }
        }

        content.innerHTML = `
          <div class="group-box" style="margin-bottom:8px;">
            <div class="group-box-title">Compression Statistics</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:4px 0; text-align:center;">
              <div style="font-size:10px; color:var(--sys-text-subtle,#666);">Before</div>
              <div style="font-size:10px; color:var(--sys-text-subtle,#666);">After</div>
              <div id="gm-opt-size-before" style="font-size:12px; font-weight:bold; padding:4px; background:var(--sys-control-bg,#fff); border:1px solid var(--sys-border-dark,#999);">${sizeBefore}</div>
              <div id="gm-opt-size-after" style="font-size:12px; font-weight:bold; padding:4px; background:var(--sys-control-bg,#fff); border:1px solid var(--sys-border-dark,#999); color:#555;">${sizeAfter}</div>
            </div>
            <div style="text-align:center; font-size:11px; padding:4px 0 2px; min-height:18px;" id="gm-opt-compression-factor">
              ${compressionLine || '<span style="color:var(--sys-text-subtle,#666);">&mdash;</span>'}
            </div>
          </div>

          <label style="font-size:11px; font-weight:bold;">Color Reduction</label>
          <select class="win-input" id="gm-inp-colors" style="width:100%; margin-bottom:8px;">
            <option value="256" selected>256 Colors (No reduction)</option>
            <option value="128">128 Colors</option>
            <option value="64">64 Colors</option>
            <option value="32">32 Colors</option>
            <option value="16">16 Colors</option>
          </select>

          <label style="font-size:11px; font-weight:bold;">Dithering Algorithm</label>
          <select class="win-input" id="gm-inp-dither" style="width:100%; margin-bottom:8px;">
            <option value="floyd_steinberg" selected>Floyd Steinberg (Default Quality)</option>
            <option value="bayer">Bayer Ordered Dither (Retro look)</option>
            <option value="none">No Dither (Smallest file size)</option>
          </select>

          <label style="font-size:11px; font-weight:bold;">Frame Dropping</label>
          <select class="win-input" id="gm-inp-drop-frames" style="width:100%; margin-bottom:12px;">
            <option value="1" selected>Keep all frames</option>
            <option value="2">Drop every 2nd frame (50% smaller)</option>
            <option value="3">Drop every 3rd frame (33% smaller)</option>
          </select>

          <button type="button" class="win-button primary" id="gm-btn-apply-optimize" style="width:100%;">
            <i class="bi bi-speedometer2"></i> Optimize Size
          </button>
        `;

        if (sizeBefore === "Scanning...") {
          if (state.currentMedia && window.__TAURI__?.core) {
            window.__TAURI__.core
              .invoke("get_file_size", { path: state.currentMedia.path })
              .then((size: number) => {
                if (size !== null && size !== undefined) {
                  const beforeEl = content.querySelector("#gm-opt-size-before");
                  if (beforeEl) beforeEl.textContent = formatBytes(size);
                  if (state.historyIndex >= 0 && state.historyIndex < state.history.length) {
                    state.history[state.historyIndex].fileSize = size;
                  }
                }
              })
              .catch(() => {});
          }
        }
        content.querySelector("#gm-btn-apply-optimize")?.addEventListener("click", () => void handleApplyOptimize());
      })();
      break;

    case "split":
      title.textContent = "Split GIF to Frames";
      (() => {
        const defaultDir = state.currentMedia ? state.currentMedia.path.replace(/[\/\\][^\/\\]+$/, "") : "";
        content.innerHTML = `
          <div style="font-size:11px; color:#666; margin-bottom:8px;">Extracts every frame from the active GIF/video and saves them as individual PNG files to a destination folder.</div>
          <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">Output Folder</label>
          <div style="display:flex; gap:4px; margin-bottom:10px;">
            <input type="text" class="win-input" id="gm-inp-split-dir" placeholder="Choose output folder..." style="flex:1; min-width:0;" />
            <button type="button" class="win-button" id="gm-btn-split-browse"><i class="bi bi-folder2-open"></i> Browse</button>
          </div>
          <button type="button" class="win-button primary" id="gm-btn-split" style="width:100%;">
            <i class="bi bi-grid-3x3-gap"></i> Extract &amp; Split Frames
          </button>
        `;
        const splitInp = content.querySelector<HTMLInputElement>("#gm-inp-split-dir")!;
        splitInp.value = defaultDir;

        content.querySelector("#gm-btn-split-browse")?.addEventListener("click", async () => {
          try {
            const selected = await pickDirectory();
            if (selected) splitInp.value = selected;
          } catch (e: unknown) {
            logConsole("Folder browse error: " + e, "error");
          }
        });
        content.querySelector("#gm-btn-split")?.addEventListener("click", () => void handleSplitGif());
      })();
      break;

    case "export":
      title.textContent = "Resize Dimensions & Export";
      (() => {
        const origW = (state.currentMedia && state.currentMedia.width) || 0;
        const origH = (state.currentMedia && state.currentMedia.height) || 0;

        let activeExt =
          state.currentMedia && state.currentMedia.path ? state.currentMedia.path.split(".").pop()!.toLowerCase() : "gif";
        if (activeExt === "mov" || activeExt === "avi" || activeExt === "mkv") activeExt = "mp4";

        content.innerHTML = `
          <div class="group-box" style="margin-bottom:8px;">
            <div class="group-box-title">Dimensions</div>
            <div style="display:flex; flex-direction:column; gap:6px; padding:4px 0;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; font-weight:bold; width:42px;">Width</span>
                <span style="font-size:11px; color:var(--sys-text-subtle,#666); min-width:40px; text-align:right;">${origW}</span>
                <span style="font-size:11px; color:var(--sys-text-subtle,#666);">&#8594;</span>
                <input type="number" class="win-input" id="gm-inp-resize-w" value="${origW}" min="1" style="width:70px; text-align:center;" />
                <span style="font-size:10px; color:var(--sys-text-subtle,#666);">px</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; font-weight:bold; width:42px;">Height</span>
                <span style="font-size:11px; color:var(--sys-text-subtle,#666); min-width:40px; text-align:right;">${origH}</span>
                <span style="font-size:11px; color:var(--sys-text-subtle,#666);">&#8594;</span>
                <input type="number" class="win-input" id="gm-inp-resize-h" value="${origH}" min="1" style="width:70px; text-align:center;" />
                <span style="font-size:10px; color:var(--sys-text-subtle,#666);">px</span>
              </div>
            </div>
          </div>

          <div class="group-box" style="margin-bottom:8px;">
            <div class="group-box-title">Resize by Percent</div>
            <div style="display:flex; align-items:center; gap:6px; padding:4px 0;">
              <input type="range" id="gm-inp-resize-pct" min="10" max="1000" value="100" step="5" style="flex:1;" />
              <input type="number" class="win-input" id="gm-inp-resize-pct-num" value="100" min="10" style="width:60px; text-align:center;" />
              <span style="font-size:11px;">%</span>
            </div>
          </div>

          <label style="font-size:11px; font-weight:bold;">Export Format</label>
          <select class="win-input" id="gm-inp-export-format" style="width:100%; margin-bottom:12px;">
            <option value="gif" ${activeExt === "gif" ? "selected" : ""}>Animated GIF (.gif)</option>
            <option value="webp" ${activeExt === "webp" ? "selected" : ""}>Animated WebP (.webp) &mdash; Lossless</option>
            <option value="mp4" ${activeExt === "mp4" ? "selected" : ""}>MP4 Video (.mp4)</option>
            <option value="webm" ${activeExt === "webm" ? "selected" : ""}>WebM Video (.webm)</option>
          </select>

          <button type="button" class="win-button primary" id="gm-btn-export" style="width:100%;">
            <i class="bi bi-download"></i> Apply &amp; Save Export
          </button>
        `;

        const wInp = content.querySelector<HTMLInputElement>("#gm-inp-resize-w")!;
        const hInp = content.querySelector<HTMLInputElement>("#gm-inp-resize-h")!;
        const pctRange = content.querySelector<HTMLInputElement>("#gm-inp-resize-pct")!;
        const pctNum = content.querySelector<HTMLInputElement>("#gm-inp-resize-pct-num")!;

        function applyPct(pct: number): void {
          if (!origW || !origH) return;
          wInp.value = String(Math.max(1, Math.round((origW * pct) / 100)));
          hInp.value = String(Math.max(1, Math.round((origH * pct) / 100)));
        }

        function syncPctFromDims(): void {
          const w = parseInt(wInp.value);
          if (!origW || !w) return;
          const pct = Math.round((w / origW) * 100);
          pctRange.value = String(Math.max(10, pct));
          pctNum.value = String(pct);
        }

        pctRange.addEventListener("input", function (this: HTMLInputElement) {
          pctNum.value = this.value;
          applyPct(parseInt(this.value));
        });
        pctNum.addEventListener("input", function (this: HTMLInputElement) {
          const v = Math.max(10, parseInt(this.value) || 100);
          pctRange.value = String(v);
          applyPct(v);
        });
        wInp.addEventListener("input", () => {
          if (origW && origH) {
            hInp.value = String(Math.max(1, Math.round((parseInt(wInp.value || String(origW)) * origH) / origW)));
          }
          syncPctFromDims();
        });
        hInp.addEventListener("input", () => {
          if (origW && origH) {
            wInp.value = String(Math.max(1, Math.round((parseInt(hInp.value || String(origH)) * origW) / origH)));
          }
          syncPctFromDims();
        });
      })();
      content.querySelector("#gm-btn-export")?.addEventListener("click", () => void handleExportResize());
      break;
  }
}

export function setupEvents(root: HTMLElement): void {
  const tools = root.querySelectorAll<HTMLElement>(".gm-toolbar .win-button");
  tools.forEach((btn) => {
    btn.addEventListener("click", () => {
      tools.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentTool = btn.getAttribute("data-tool") as any;
      const content = el("gm-panel-content");
      content?.removeAttribute("data-mounted-tool");
      setupToolboxPane();
    });
  });

  root.querySelector("#gm-btn-undo")?.addEventListener("click", () => {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      restoreHistoryState();
    }
  });

  root.querySelector("#gm-btn-redo")?.addEventListener("click", () => {
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      restoreHistoryState();
    }
  });

  root.querySelector("#gm-btn-save-final")?.addEventListener("click", () => void handleSaveFinal());
  root.querySelector("#gm-btn-load-selection")?.addEventListener("click", () => void handleLoadSelection());
  root.querySelector("#gm-btn-browse-file")?.addEventListener("click", () => void handleBrowseFile());

  // Setup Tauri v2 native drops
  _setupDropZone(TAB_ID, "gm-drop-zone", (paths) => {
    if (state.currentTool === "maker") {
      if (paths.length === 1 && /\.(mp4|webm|mov|gif|avi|mkv)$/i.test(paths[0])) {
        previewMediaFile(paths[0]);
        setupToolboxPane();
      } else {
        logConsole("Sequence mode: enter your pattern in the Maker panel.", "info");
      }
    } else {
      void pushHistoryState(paths[0], "Dropped media file");
    }
  });
}

export function renderGifMakerTab(): HTMLElement {
  injectStyles();

  // Load Roboto Condensed Bold immediately
  const robotoFace = new FontFace(
    "Roboto Condensed Bold",
    `url(${PH.convertFileSrc(pluginDir + "\\Roboto_Condensed_Bold.otf")})`
  );
  robotoFace
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      renderWysiwygCanvas();
    })
    .catch((err: unknown) => {
      console.warn("gif-maker: Failed to load local Roboto font", err);
    });

  const container = document.createElement("div");
  container.className = "gm-workspace";

  container.innerHTML = `
    <div class="gm-left-panel">
      <div class="gm-preview-container" id="gm-drop-zone" style="background: var(--sys-window-bg, #f0f0f0); padding: 12px; display: flex; align-items: center; justify-content: center; position: relative;">
        <div class="toolbox-drop-zone" id="gm-empty-state" style="flex: 1; margin-top: 0; align-self: stretch; width: 100%; height: 100%; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;">
          <div class="toolbox-drop-icon"><i class="bi bi-images"></i></div>
          <span>Drag & Drop images or videos here to begin</span>
        </div>

        <div id="gm-composition-wrapper" style="display: none; flex-direction: column; align-items: center; max-width: 100%; max-height: 100%; box-sizing: border-box; overflow: hidden;">
          <!-- iFunny Top Concatenated Bar -->
          <div id="gm-ifunny-bar" style="display: none; background: #ffffff; color: #000000; font-family: 'Roboto Condensed Bold', Arial, sans-serif; font-weight: bold; text-align: center; box-sizing: border-box; flex: none; line-height: 1.05; padding: 0; white-space: pre-wrap; word-break: break-word; overflow: hidden;"></div>

          <!-- Media Content Box -->
          <div id="gm-media-box" style="position: relative; display: block; flex: none;">
            <img class="gm-preview-media" id="gm-preview-img" style="display:none; object-fit: fill; flex: none; display: block;" />
            <video class="gm-preview-media" id="gm-preview-video" style="display:none; object-fit: fill; flex: none; display: block;" controls autoplay loop muted></video>

            <!-- Bottom Text Overlay -->
            <div id="gm-bottom-overlay" style="display: none; position: absolute; bottom: 20px; left: 5%; width: 90%; text-align: center; color: #ffffff; font-family: 'Roboto Condensed Bold', Arial, sans-serif; font-weight: bold; -webkit-text-stroke: var(--stroke-w, 4px) #000000; paint-order: stroke fill; pointer-events: none; line-height: 1.05; white-space: pre-wrap; word-break: break-word;"></div>

            <!-- Interactive Crop Overlay -->
            <div class="gm-preview-overlay" id="gm-overlay-interactive" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; user-select: none; -webkit-user-select: none;">
              <div class="gm-crop-box" id="gm-crop-rect" style="display: none;">
                <div class="gm-crop-handle se" id="gm-crop-resize-handle"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="group-box gm-history-box">
        <div class="group-box-title">Editing Steps History</div>
        <div style="display:flex; gap:6px; padding:3px 6px; border-bottom:1px solid var(--sys-border-light,#d0d0d0);">
          <button type="button" class="win-button" id="gm-btn-undo" disabled>
            <i class="bi bi-arrow-counterclockwise"></i> Undo
          </button>
          <button type="button" class="win-button" id="gm-btn-redo" disabled>
            <i class="bi bi-arrow-clockwise"></i> Redo
          </button>
          <span style="flex:1;"></span>
          <button type="button" class="win-button primary" id="gm-btn-save-final" disabled>
            <i class="bi bi-save2"></i> Save Final...
          </button>
        </div>
        <div class="gm-history-list" id="gm-hist-list">
          <div style="color:#808080; padding:6px; font-style:italic;">No files loaded.</div>
        </div>
      </div>
    </div>

    <div class="gm-right-panel">
      <div class="group-box" style="flex: none;">
        <div class="group-box-title">Source Media</div>
        <div style="padding: 6px; display: flex; gap: 6px;">
          <button type="button" class="win-button" id="gm-btn-browse-file" style="flex: 1; font-size: 11px;">
            <i class="bi bi-folder2-open"></i> Browse File...
          </button>
          <button type="button" class="win-button" id="gm-btn-load-selection" style="flex: 1; font-size: 11px;">
            <i class="bi bi-images"></i> Load Selection
          </button>
        </div>
      </div>

      <div class="group-box" style="flex: none;">
        <div class="group-box-title">Toolbox Menu</div>
        <div class="gm-toolbar">
          <button class="win-button active" id="gm-tool-maker" data-tool="maker"><i class="bi bi-images"></i>Maker</button>
          <button class="win-button" id="gm-tool-trim" data-tool="trim"><i class="bi bi-scissors"></i>Trim</button>
          <button class="win-button" id="gm-tool-crop" data-tool="crop"><i class="bi bi-crop"></i>Crop</button>
          <button class="win-button" id="gm-tool-caption" data-tool="caption"><i class="bi bi-chat-text"></i>Caption</button>
          <button class="win-button" id="gm-tool-effects" data-tool="effects"><i class="bi bi-magic"></i>Effects</button>
          <button class="win-button" id="gm-tool-optimize" data-tool="optimize"><i class="bi bi-speedometer2"></i>Optimize</button>
          <button class="win-button" id="gm-tool-split" data-tool="split"><i class="bi bi-grid-3x3-gap"></i>Split</button>
          <button class="win-button" id="gm-tool-export" data-tool="export"><i class="bi bi-arrow-left-right"></i>Resize</button>
        </div>
      </div>

      <div class="group-box gm-control-box">
        <div class="group-box-title" id="gm-control-title">GIF Maker Settings</div>
        <div id="gm-panel-content" style="padding:6px; display:flex; flex-direction:column; gap:8px; flex:1; overflow-y:auto; min-height:0;">
          <!-- Content dynamically generated by setupToolboxPane -->
        </div>
      </div>

      <div class="group-box" style="height:190px; display:flex; flex-direction:column; flex: none;">
        <div class="group-box-title"><i class="bi bi-terminal"></i> Output Log</div>
        <div style="display:flex; align-items:center; gap:8px; padding:4px 8px; border-bottom:1px solid var(--sys-border-light,#d0d0d0); background:#f5f5f5; flex:none;">
          <div class="progress-bar" style="height: 10px; border-radius: 2px;">
            <div id="gm-progress-bar" class="progress-fill" style="width:0%; border-radius: 2px; background: var(--sys-primary, #0078d4);"></div>
          </div>
          <span id="gm-progress-text" class="progress-text" style="font-size:10px; min-width:30px;">0%</span>
        </div>
        <div class="gm-log-box" id="gm-console" style="flex:1;"></div>
      </div>
    </div>
  `;

  setTimeout(() => {
    setupEvents(container);
    setupToolboxPane();
    setupInteractiveCrop();
  }, 50);

  return container;
}
