/**
 * Entry-point UI orchestration for gif-maker.
 *
 * This module is intentionally thin: it owns the tab bootstrap
 * (`renderGifMakerTab`), root event wiring (`setupEvents`), and the two
 * source-loading actions (`handleLoadSelection`, `handleBrowseFile`). All
 * feature logic lives in `timeline.ts`, `effects.ts`, `export.ts`,
 * `history.ts`, and `toolbox.ts`.
 */

import { state, TAB_ID, pluginDir } from "./state";
import { pickFile, setupDropZone as _setupDropZone } from "../../lib";
import { PH, el, logConsole } from "./ui-core";
import { renderDroppedFrames } from "./timeline";
import { pushHistoryState, restoreHistoryState, previewMediaFile } from "./history";
import { setupToolboxPane } from "./toolbox";
import { handleSaveFinal } from "./export";
import { injectStyles, renderWysiwygCanvas, setupInteractiveCrop } from "./effects";

export { logConsole, renderDroppedFrames, pushHistoryState };

export async function handleLoadSelection(): Promise<void> {
  logConsole("Fetching selected gallery assets...", "info");
  const selection = await PH.getSelectionAssetContexts();
  if (!selection || selection.length === 0) {
    logConsole("Error: Select files in the main gallery first.", "error");
    return;
  }

  if (state.currentTool === "maker") {
    state.droppedFrames = selection.map((asset) => asset.path);
    logConsole(
      `Loaded ${state.droppedFrames.length} frames to the GIF Maker frame pool.`,
      "success",
    );
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
  root
    .querySelector("#gm-btn-load-selection")
    ?.addEventListener("click", () => void handleLoadSelection());
  root
    .querySelector("#gm-btn-browse-file")
    ?.addEventListener("click", () => void handleBrowseFile());

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
    `url(${PH.convertFileSrc(pluginDir + "\\Roboto_Condensed_Bold.otf")})`,
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
