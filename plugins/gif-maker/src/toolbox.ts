/**
 * Toolbox pane renderer for gif-maker.
 *
 * Owns the WinForms "Toolbox Menu" side panel: builds the tool-specific
 * control forms (`maker`, `trim`, `crop`, `caption`, `effects`, `optimize`,
 * `split`, `export`), wires their inputs, and delegates action buttons to the
 * FFmpeg pipeline in `export.ts`.
 */

import { formatBytes, pickFile, pickDirectory } from "../../lib";
import { state } from "./state";
import { el, logConsole } from "./ui-core";
import { loadCustomFontFile, renderWysiwygCanvas, updateOverlayPosition } from "./effects";
import {
  compileImagesToAnimation,
  compileMakerVideo,
  handleApplyCaption,
  handleApplyCrop,
  handleApplyEffects,
  handleApplyOptimize,
  handleExportResize,
  handleSplitGif,
  handleTrimVideo,
} from "./export";

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
