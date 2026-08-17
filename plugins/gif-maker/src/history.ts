/**
 * Media preview + editing-step history for gif-maker.
 *
 * Owns loading a source file into the preview (`previewMediaFile`), the
 * undo/redo stack manipulation (`pushHistoryState`, `restoreHistoryState`),
 * and the file-size lookups that feed the history list.
 */

import { formatBytes } from "../../lib";
import { state, TAB_ID, workspaceRoot } from "./state";
import { PH, el, logConsole } from "./ui-core";
import { setupToolboxPane } from "./toolbox";
import { updateOverlayPosition, renderWysiwygCanvas } from "./effects";

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
    safeUrl,
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
                2,
              )} fps, ${state.currentMedia!.totalFrames} frames`,
              "success",
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
                2,
              )}s, ${state.currentMedia!.fps!.toFixed(2)} fps, ${state.currentMedia!.totalFrames} frames`,
              "success",
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

export async function pushHistoryState(filePath: string, description: string): Promise<void> {
  if (state.historyIndex < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyIndex + 1);
  }

  let size = null;
  try {
    size = await PH.storage.getFileSize(filePath);
  } catch {
    // ignore silently
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
