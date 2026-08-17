/**
 * All DOM rendering, event wiring, and UI logic for the image-converter plugin.
 *
 * This module owns:
 *   - The tab render function (renderTab)
 *   - Log console output (log)
 *   - Queue management (addToQueue, updateQueueList)
 *   - Progress bar (updateProgress)
 *   - Busy-state toggle (setBusy)
 *   - Format/quality visibility logic (qualityVisibility)
 *   - Navigation helpers (navigateToTab, closeInfoModal)
 *   - Conversion orchestration (runConversion)
 *   - Tauri v2 native drag-drop (setupDropZone)
 *
 * setupDropZone is co-located here (rather than in its own file) because it
 * calls addToQueue directly — keeping both in ui.ts avoids a circular import.
 */

import { CONVERT_FORMATS, TAB_ID, state, setOutputDir } from "./state";
import { getUniqueOutputPath } from "./ipc";
import {
  createLogger,
  navigateToTab as _navigateToTab,
  closeInfoModal,
  setupDropZone as _setupDropZone,
  pickDirectory,
} from "../../lib";

const PH = window.PluginHost;

// ---------------------------------------------------------------------------
// DOM shorthand
// ---------------------------------------------------------------------------

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---------------------------------------------------------------------------
// Plugin-scoped helpers from shared lib
// ---------------------------------------------------------------------------

/** Logger bound to this plugin's log console element. */
export const log = createLogger("converter-log");

/** Navigate to this plugin's sidebar tab. */
export const navigateToTab = (): void => _navigateToTab(TAB_ID);

/** Close info modal — re-exported from lib for use in index.ts. */
export { closeInfoModal };

/** Re-render the queue list from the current state.queue array. */
export function updateQueueList(): void {
  const list = el("converter-queue-list");
  if (!list) return;
  list.innerHTML = "";

  // Count basenames so same-named files from different folders can be
  // disambiguated by showing their parent folder name.
  const basenames: Record<string, number> = {};
  state.queue.forEach((path) => {
    const base = path.split(/[/\\]/).pop()!;
    basenames[base] = (basenames[base] ?? 0) + 1;
  });

  state.queue.forEach((path, index) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:3px 6px;" +
      "border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;" +
      "background:var(--sys-window-bg,#fff);font-size:11px;";

    const parts = path.split(/[/\\]/);
    const base = parts.pop()!;
    let labelText = base;
    if (basenames[base] > 1) {
      const parent = parts[parts.length - 1];
      labelText = (parent ? `${parent}/` : "") + base;
    }

    const label = document.createElement("span");
    label.style.cssText =
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    label.title = path;
    label.textContent = labelText;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "win-button";
    removeBtn.style.cssText = "font-size:10px;padding:1px 6px;";
    removeBtn.innerHTML = '<i class="bi bi-x-lg"></i>';
    removeBtn.addEventListener("click", () => {
      state.queue.splice(index, 1);
      delete state.inQueue[path];
      updateQueueList();
      updateProgress(0, state.queue.length);
    });

    row.appendChild(label);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });

  const empty = el("converter-queue-empty");
  if (empty) empty.style.display = state.queue.length === 0 ? "block" : "none";

  const count = el("converter-queue-count");
  if (count) count.textContent = `${state.queue.length} file(s) queued`;
}

/** Add a single file path to the queue (deduplicates automatically). */
export function addToQueue(path: string): void {
  if (!path) return;
  ensureConverterMounted();
  if (state.inQueue[path]) {
    log(`Already queued: ${path}`, "info");
    return;
  }
  state.inQueue[path] = true;
  state.queue.push(path);
  updateQueueList();
  updateProgress(0, state.queue.length);
  log(`Queued: ${path}`, "info");
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

export function updateProgress(done: number, total: number): void {
  const fill = el("converter-progress-fill");
  const text = el("converter-progress-text");
  if (!fill) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = `${pct}%`;
  if (text) text.textContent = `${done} / ${total} (${pct}%)`;
}

// ---------------------------------------------------------------------------
// Busy state
// ---------------------------------------------------------------------------

export function setBusy(value: boolean): void {
  state.busy = value;
  const btn = el<HTMLButtonElement>("converter-run-btn");
  if (btn) {
    btn.disabled = value;
    btn.innerHTML = value
      ? '<i class="bi bi-hourglass-split"></i> Converting...'
      : '<i class="bi bi-arrow-repeat"></i> Convert';
  }
}

// ---------------------------------------------------------------------------
// Format / quality visibility
// ---------------------------------------------------------------------------

/** Show or hide the quality slider based on the selected target format. */
export function qualityVisibility(): void {
  const slider = el<HTMLInputElement>("converter-quality");
  const note = el("converter-quality-note");
  const wrapper = el("converter-quality-group");
  if (!slider || !wrapper) return;

  const applies =
    state.targetExt === "jpg" || state.targetExt === "jpeg" || state.targetExt === "webp";
  wrapper.style.display = applies ? "" : "none";
  slider.disabled = !applies;

  if (note) {
    note.textContent =
      state.targetExt === "webp" ? "WebP output is lossless (quality not applied)." : "";
  }
}

// ---------------------------------------------------------------------------
// Conversion orchestration
// ---------------------------------------------------------------------------

export async function runConversion(): Promise<void> {
  if (state.busy) return;
  if (state.queue.length === 0) {
    log("No files queued. Drag & drop images or use Send to Converter.", "error");
    return;
  }
  if (!state.outputDir) {
    log("Choose an output directory first.", "error");
    return;
  }

  const sources = state.queue.slice();
  setBusy(true);
  log("Resolving output paths and detecting collisions...", "info");

  const conversions: [string, string][] = [];
  try {
    for (const src of sources) {
      const tgt = await getUniqueOutputPath(src, state.outputDir, state.targetExt);
      conversions.push([src, tgt]);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Path resolution failed: ${msg}`, "error");
    setBusy(false);
    return;
  }

  log(`Converting ${conversions.length} file(s) to ${state.targetExt} ...`, "info");

  try {
    const resp = await PH.callService("EphemeralConvertImages", {
      conversions,
      quality: state.quality,
    });

    if (resp?.ConvertImagesResult) {
      const converted: Array<{
        source_path: string;
        output_path: string;
        error?: string;
      }> = resp.ConvertImagesResult.converted;

      let ok = 0;
      let fail = 0;
      converted.forEach((c) => {
        if (c.error) {
          fail++;
          log(`FAIL ${c.source_path} — ${c.error}`, "error");
        } else {
          ok++;
          log(`OK ${c.source_path}  ->  ${c.output_path}`, "success");
        }
      });

      updateProgress(converted.length, converted.length);
      if (fail === 0) log(`Done: ${ok} file(s) converted.`, "success");
      else log(`Done: ${ok} converted, ${fail} failed.`, "error");
    } else if (resp?.Error) {
      log(`Service error: ${resp.Error.message}`, "error");
    } else {
      log("Unexpected response from service.", "error");
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Conversion failed: ${msg}`, "error");
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Tab render
// ---------------------------------------------------------------------------

export function ensureConverterMounted(): void {
  if (PH && PH.loadTab) {
    PH.loadTab(TAB_ID);
  }
}

export function renderTab(): HTMLElement {
  const container = document.createElement("div");

  container.innerHTML =
    '<div class="group-box">' +
    '  <div class="group-box-title"><i class="bi bi-arrow-repeat"></i> Image Converter</div>' +
    '  <div style="display:flex;flex-direction:column;gap:12px;">' +
    // Output folder row
    '    <div class="form-group">' +
    '      <label for="converter-output-dir" style="min-width:110px;">Output folder:</label>' +
    '      <div class="input-wrapper" style="flex:1;">' +
    '        <input class="input-field has-clear" id="converter-output-dir"' +
    '          placeholder="Where converted files should be written..." />' +
    '        <button type="button" class="input-clear-btn" tabindex="-1">' +
    '          <i class="bi bi-x-lg"></i>' +
    "        </button>" +
    "      </div>" +
    '      <button type="button" class="win-button" id="converter-browse-btn">' +
    '        <i class="bi bi-folder2-open"></i> Browse...' +
    "      </button>" +
    "    </div>" +
    // Format + quality row
    '    <div class="form-group">' +
    '      <label for="converter-format" style="min-width:110px;">Target format:</label>' +
    '      <select class="input-field" id="converter-format" style="width:160px;height:24px;">' +
    CONVERT_FORMATS.map((f) => `<option value="${f}">${f.toUpperCase()}</option>`).join("") +
    "      </select>" +
    '      <div id="converter-quality-group" class="form-group" style="margin:0;flex:1;">' +
    '        <label for="converter-quality" style="min-width:70px;">' +
    '          Quality: <span id="converter-quality-value">90</span>' +
    "        </label>" +
    '        <input type="range" id="converter-quality" min="1" max="100" value="90"' +
    '          style="flex:1;max-width:200px;" />' +
    "      </div>" +
    "    </div>" +
    '    <div id="converter-quality-note" style="font-size:10px;color:#777;margin-top:-6px;"></div>' +
    // Drop zone
    '    <div id="converter-drop-host">' +
    '      <div class="toolbox-drop-zone" id="converter-drop-zone" style="flex:none;height:130px;">' +
    '        <div class="toolbox-drop-icon"><i class="bi bi-images"></i></div>' +
    "        <span>Drop image files here to queue them</span>" +
    "      </div>" +
    "    </div>" +
    // Queue group box
    '    <div class="group-box" style="margin-top:8px;">' +
    '      <div class="group-box-title">Queue' +
    '        <span id="converter-queue-count"' +
    '          style="font-weight:400;color:#777;font-size:10px;">0 file(s) queued</span>' +
    '        <button type="button" class="win-button" id="converter-clear-btn"' +
    '          style="font-size:10px;padding:1px 8px;margin-left:8px;">' +
    '          <i class="bi bi-trash3"></i> Clear' +
    "        </button>" +
    "      </div>" +
    '      <div id="converter-queue-empty"' +
    '        style="font-size:11px;color:#999;font-style:italic;padding:4px 0;">No files queued.</div>' +
    '      <div id="converter-queue-list"' +
    '        style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;"></div>' +
    "    </div>" +
    // Run button + progress bar
    '    <div style="display:flex;align-items:center;gap:12px;">' +
    '      <button type="button" class="win-button primary" id="converter-run-btn"' +
    '        style="padding:4px 14px;">' +
    '        <i class="bi bi-arrow-repeat"></i> Convert' +
    "      </button>" +
    '      <div class="progress-bar" style="flex:1;max-width:300px;">' +
    '        <div class="progress-fill" id="converter-progress-fill" style="width:0%;"></div>' +
    "      </div>" +
    '      <span id="converter-progress-text" style="font-size:11px;color:#555;">0 / 0 (0%)</span>' +
    "    </div>" +
    // Log box
    '    <div class="group-box" style="margin-top:8px;">' +
    '      <div class="group-box-title"><i class="bi bi-terminal"></i> Output Log</div>' +
    '      <div id="converter-log" style="height:140px;overflow-y:auto;background-color:#1e1e1e;' +
    "color:#cccccc;border:1px solid #7a7a7a;padding:8px;font-family:'Consolas',monospace;" +
    'font-size:11px;white-space:pre-wrap;"></div>' +
    "    </div>" +
    "  </div>" +
    "</div>";

  // ── Event listeners ──────────────────────────────────────────────────────

  container
    .querySelector<HTMLButtonElement>("#converter-run-btn")
    ?.addEventListener("click", () => void runConversion());

  container
    .querySelector<HTMLButtonElement>("#converter-clear-btn")
    ?.addEventListener("click", () => {
      state.queue.length = 0;
      state.inQueue = {};
      updateQueueList();
      updateProgress(0, 0);
      log("Queue cleared.", "info");
    });

  const browseBtn = container.querySelector<HTMLButtonElement>("#converter-browse-btn");
  const outInput = container.querySelector<HTMLInputElement>("#converter-output-dir");
  if (outInput) outInput.value = state.outputDir;
  if (browseBtn && outInput) {
    browseBtn.addEventListener("click", async () => {
      const path = await pickDirectory();
      if (path) {
        outInput.value = path;
        setOutputDir(path);
        log(`Output directory set: ${path}`, "success");
      }
    });
  }

  const formatSelect = container.querySelector<HTMLSelectElement>("#converter-format");
  if (formatSelect) {
    formatSelect.value = state.targetExt;
    formatSelect.addEventListener("change", () => {
      state.targetExt = formatSelect.value;
      qualityVisibility();
    });
  }

  const qualityInput = container.querySelector<HTMLInputElement>("#converter-quality");
  const qualityValue = container.querySelector<HTMLSpanElement>("#converter-quality-value");
  if (qualityInput) {
    qualityInput.addEventListener("input", () => {
      state.quality = parseInt(qualityInput.value, 10) || 90;
      if (qualityValue) qualityValue.textContent = String(state.quality);
    });
  }

  if (outInput) {
    outInput.addEventListener("change", () => {
      setOutputDir(outInput.value.trim());
    });
  }

  // DOM queries inside qualityVisibility, _setupDropZone, updateQueueList, and
  // updateProgress all target elements that are still detached from the
  // document at this point. Defer until after the Plugin Host appends the
  // container to the view section.
  setTimeout(() => {
    qualityVisibility();
    _setupDropZone(TAB_ID, "converter-drop-zone", (paths) => {
      paths.forEach(addToQueue);
    });
    updateQueueList();
    updateProgress(0, state.queue.length);
  }, 0);

  return container;
}
