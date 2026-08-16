/**
 * WinForms desktop-control rendering + download orchestration for the
 * aria2-downloader plugin.
 *
 * All sections use the app's native `.group-box` fieldsets, `.win-button`
 * tactile controls, `.input-field` inputs, and official Bootstrap icons - no
 * web fluff (AGENTS.md §6). `renderTab` builds the full DOM tree once and
 * attaches all listeners; focused updaters (`renderQueue`, `renderHistory`,
 * `updateChips`, `appendLogDelta`) keep polling from rebuilding
 * the tree and clobbering input focus.
 *
 * Accuracy note: aria2c's stdout summary exposes only AGGREGATE bytes/speed/CN
 * for the whole job - a per-segment "chunks" bar is not derivable from stdout.
 * The queue shows one aggregate progress bar plus `CN:<n>`.
 */

import {
  appendLogLines,
  createLogger,
  formatBytes,
  loadPersisted,
  pickDirectory,
  pollServiceProgress,
  savePersisted,
} from "../../lib";
import {
  checkTool,
  downloadCancel,
  downloadProgress,
  downloadStart,
  getToolInstallProgress,
  installTool,
  resolveOutputPath,
  revealInFolder,
} from "./ipc";
import { state, TAB_ID, ARIA2_TOOL, filenameFromUrl, type QueueItem } from "./state";
import { checkUrlCompatibility } from "./sites";
import {
  ensureHistorySchema,
  findDuplicateUrls,
  queryHistory,
  recordDownload,
  removeHistoryEntry,
  searchHistory,
  type HistoryRecord,
} from "./history";
import type { DownloadProgress } from "./ipc";

const PH = window.PluginHost;

export const log = createLogger("ad-log-dock");

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Join an absolute directory and a file name with the OS separator. */
function joinPath(dir: string, name: string): string {
  const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
  return `${dir}${sep}${name}`;
}

/**
 * Accept only real absolute paths from the backend (drive letter, UNC, or
 * leading-slash) so a garbage token such as a bare percent can never reach the
 * queue output path, history store, or Explorer reveal action.
 */
function isAbsolutePath(p: string | null | undefined): boolean {
  if (!p) return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** Format seconds as `2h 3m`, `1m 15s`, or `38s`. */
export function formatEta(secs: number | null): string {
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Format a byte rate as `1.5 MB/s`. */
function formatRate(bps: number): string {
  if (!bps) return "0 B/s";
  return `${formatBytes(bps, "0 B", 1)}/s`;
}

/** Extract the hoster (hostname without `www.`) from a URL. */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    const head = url.split(/[\\/]/)[0];
    return head || url;
  }
}

// ── Resizable table columns (persisted) ─────────────────────────────────────

const COL_WIDTH_KEY = "aria2-downloader-col-";

interface ColumnResizeState {
  th: HTMLTableCellElement;
  colKey: string;
  startX: number;
  startWidth: number;
  liveWidth: number;
}

let columnResizeState: ColumnResizeState | null = null;

/** Restore persisted widths onto table headers (idempotent per render). */
function applyColumnWidths(): void {
  document.querySelectorAll<HTMLTableCellElement>(".ad-table thead th").forEach((th) => {
    const colKey = (th.className.match(/\bcol-\w+/) ?? [""])[0];
    if (!colKey) return;
    const width = localStorage.getItem(COL_WIDTH_KEY + colKey);
    if (width) th.style.width = `${width}px`;
  });
}

function columnResizeMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const th = target.closest?.("th");
  if (!th || !th.closest(".ad-table")) return;
  const rect = th.getBoundingClientRect();
  if (e.clientX < rect.right - 5 || e.clientX > rect.right + 5) return;
  e.preventDefault();
  const colKey = (th.className.match(/\bcol-\w+/) ?? [""])[0];
  if (!colKey) return;
  columnResizeState = {
    th,
    colKey,
    startX: e.clientX,
    startWidth: rect.width,
    liveWidth: rect.width,
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function columnResizeMouseMove(e: MouseEvent): void {
  if (!columnResizeState) return;
  const width = Math.max(40, columnResizeState.startWidth + (e.clientX - columnResizeState.startX));
  columnResizeState.liveWidth = width;
  columnResizeState.th.style.width = `${width}px`;
}

function columnResizeMouseUp(): void {
  if (!columnResizeState) return;
  localStorage.setItem(COL_WIDTH_KEY + columnResizeState.colKey, String(columnResizeState.liveWidth));
  columnResizeState = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

let columnResizeWired = false;
function wireColumnResize(): void {
  if (columnResizeWired) return;
  columnResizeWired = true;
  document.addEventListener("mousedown", columnResizeMouseDown);
  document.addEventListener("mousemove", columnResizeMouseMove);
  document.addEventListener("mouseup", columnResizeMouseUp);
}

function formatDateTime(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── CSS injection ───────────────────────────────────────────────────────────

export function injectStyles(): void {
  if (document.getElementById("ad-styles")) return;
  const style = document.createElement("style");
  style.id = "ad-styles";
  style.textContent = `
    #view-extensions-${TAB_ID}.active {
      display: flex !important;
      flex-direction: column;
      height: calc(100vh - 140px);
      max-height: calc(100vh - 140px);
      overflow: hidden !important;
    }
    .ad-workspace {
      display: flex;
      flex-direction: column;
      gap: 8px;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
      padding: 8px;
      box-sizing: border-box;
      font-family: var(--sys-font-family, "Segoe UI", sans-serif);
      color: var(--sys-window-text, #000);
      background: var(--sys-window-bg, #f0f0f0);
    }
    .ad-toolbar { flex-shrink: 0; }
    .ad-banner {
      display: none;
      flex-shrink: 0;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 4px;
      font-size: 11px;
      border: 1px solid var(--sys-border-dark, #b0b0b0);
      border-radius: 3px;
      background-color: var(--sys-status-bg, #f3f3f3);
      color: var(--sys-window-text, #000);
    }
    .ad-banner > i { color: #b45309; flex-shrink: 0; }
    .ad-banner-inner { flex: 1; min-width: 0; }
    .ad-banner-status {
      margin-top: 3px;
      font-size: 10px;
      color: var(--sys-text-subtle, #555);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ad-banner-progress {
      margin-top: 4px;
      height: 8px;
      background: #dcdcdc;
      border: 1px solid #c0c0c0;
      border-radius: 2px;
      overflow: hidden;
    }
    .ad-banner-fill { height: 100%; background: var(--sys-highlight-bg, #0078d7); width: 0%; }
    .ad-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
      max-height: 54px;
      overflow-y: auto;
    }
    .ad-chip {
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid var(--sys-border-light, #c0c0c0);
      background: var(--sys-window-bg, #fff);
      color: var(--sys-window-text, #333);
      border-radius: 2px;
      white-space: nowrap;
    }
    .ad-chip.ok { border-color: #10b981; color: #047857; }
    .ad-chip.warn { border-color: #f59e0b; color: #b45309; }
    .ad-chip.bad { border-color: #ef4444; color: #b91c1c; }
    .ad-middle {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: row;
      gap: 8px;
    }
    .ad-column {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
    }
    .ad-queue-box { flex: 3; }
    .ad-history-box { flex: 2; }
    .ad-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--sys-border-light, #d0d0d0);
      background: var(--sys-window-bg, #fff);
    }
    .ad-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      font-size: 11px;
      border-bottom: 1px solid #ececec;
    }
    .ad-row:hover { background: #f4f6f8; }
    .ad-row-mono {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: 'Consolas', monospace;
      color: #1a1a2e;
    }
    .ad-error {
      width: 100%;
      color: #b91c1c;
      font-size: 10px;
      font-family: 'Consolas', monospace;
      word-break: break-all;
      white-space: pre-wrap;
    }
    .ad-badge {
      font-size: 10px;
      padding: 1px 7px;
      border-radius: 2px;
      border: 1px solid #c0c0c0;
      background: #f0f0f0;
      color: #444;
      flex-shrink: 0;
    }
    .ad-badge.running { border-color: #3b82f6; background: #dbeafe; color: #1d4ed8; }
    .ad-badge.completed { border-color: #10b981; background: #d1fae5; color: #047857; }
    .ad-badge.cancelled { border-color: #f59e0b; background: #fef3c7; color: #b45309; }
    .ad-badge.failed { border-color: #ef4444; background: #fee2e2; color: #b91c1c; }
    .ad-badge.queued { border-color: #9ca3af; background: #f3f4f6; color: #4b5563; }
    .ad-filter-btn {
      font-size: 10px;
      padding: 1px 8px;
    }
    .ad-filter-btn.active {
      border-color: #1d4ed8;
      background: #dbeafe;
      color: #1d4ed8;
    }
    .ad-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .ad-table thead th {
      text-align: left;
      font-size: 10px;
      font-weight: 600;
      color: #555;
      padding: 4px 6px;
      border-bottom: 1px solid #d0d0d0;
      background: #f4f6f8;
      position: relative;
      user-select: none;
    }
    .ad-table thead th::after {
      content: "";
      position: absolute;
      top: 3px;
      right: 0;
      bottom: 3px;
      width: 2px;
      background: #c8ccd0;
      cursor: col-resize;
    }
    .ad-table thead th:hover::after { background: #0078d7; }
    .ad-table td {
      padding: 4px 6px;
      font-size: 11px;
      border-bottom: 1px solid #ececec;
      vertical-align: middle;
    }
    .ad-table tbody tr:hover { background: #f4f6f8; }
    .ad-table .col-status { width: 74px; }
    .ad-table .col-hoster { width: 88px; }
    .ad-table .col-progress { width: 150px; }
    .ad-table .col-size { width: 96px; }
    .ad-table .col-speed { width: 84px; }
    .ad-table .col-eta { width: 62px; }
    .ad-table .col-hdate { width: 122px; }
    .ad-table .col-actions { width: 150px; text-align: right; }
    .ad-progress-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
    }
    .ad-progress {
      flex: 1;
      height: 8px;
      background: #e5e7eb;
      border: 1px solid #c0c0c0;
      border-radius: 2px;
      overflow: hidden;
    }
    .ad-progress-fill { height: 100%; background: #0078d7; width: 0%; }
    .ad-meta {
      color: #555;
      font-size: 10px;
      flex-shrink: 0;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ad-log-dock {
      flex-shrink: 0;
      height: 200px;
      overflow-y: auto;
      background-color: #1e1e1e;
      color: #cccccc;
      border: 1px solid #7a7a7a;
      padding: 6px 8px;
      font-family: 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
    }
    /* The app's global universal font rule beats inheritance on child divs,
       so pin every dock line to Consolas explicitly. */
    .ad-log-dock div {
      font-family: 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #cccccc;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ad-empty { padding: 12px; color: #9ca3af; font-size: 11px; text-align: center; }
    .ad-summary-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }
    .ad-summary-row input[type="number"] { width: 84px; font-size: 11px; }
    .ad-summary-row label { font-size: 10px; color: #555; flex-shrink: 0; }
    .ad-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: #444;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .ad-toggle input[type="checkbox"] { margin: 0; accent-color: var(--sys-highlight-bg, #0078d7); }
    .ad-toolbar-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .ad-url-input {
      flex: 1;
      min-height: 46px;
      resize: vertical;
      font-family: 'Consolas', monospace;
      font-size: 11px;
    }
  `;
  document.head.appendChild(style);
}

// ── Tab tree construction + event wiring ────────────────────────────────────

export function renderTab(): HTMLElement {
  injectStyles();

  const root = document.createElement("div");
  root.className = "ad-workspace";

  // ── aria2 setup prompt (in-tab banner, shown only when the engine is
  //    unavailable). This is the plugin's only install UI - no modal.
  const banner = document.createElement("div");

  // List containers queried before renderTab returns (host attaches the root
  // after the call, so el() lookups would miss them).
  const queueList = root.querySelector<HTMLElement>("#ad-queue-list");
  const historyList = root.querySelector<HTMLElement>("#ad-history-list");
  banner.id = "ad-banner";
  banner.className = "ad-banner";
  banner.innerHTML = `
    <i class="bi bi-exclamation-triangle-fill" style="flex-shrink:0;font-size:13px;"></i>
    <div class="ad-banner-inner">
      <div id="ad-banner-text"></div>
      <div class="ad-banner-status" id="ad-banner-status" style="display:none;">Preparing install...</div>
      <div class="ad-banner-progress" id="ad-banner-progress" style="display:none;">
        <div class="ad-banner-fill" id="ad-banner-fill"></div>
      </div>
    </div>
    <button type="button" class="win-button primary" id="ad-install-btn" style="margin-left:8px;font-size:10px;flex-shrink:0;">
      <i class="bi bi-download"></i> Download &amp; Install
    </button>`;
  root.appendChild(banner);

  // ── Add Downloads toolbar ─────────────────────────────────────────────────
  const topBar = document.createElement("div");
  topBar.className = "group-box ad-toolbar";
  topBar.innerHTML = `
    <div class="group-box-title"><i class="bi bi-link-45deg"></i> Add Downloads</div>
    <div class="ad-toolbar-row">
      <textarea id="ad-url-input" class="input-field ad-url-input" placeholder="Paste download URLs (comma, space, or newline separated)..."></textarea>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button type="button" class="win-button primary" id="ad-add-btn" style="font-size:11px;"><i class="bi bi-plus-circle"></i> Add to Queue</button>
        <button type="button" class="win-button" id="ad-clear-input-btn" style="font-size:11px;"><i class="bi bi-eraser"></i> Clear</button>
      </div>
    </div>
    <div class="ad-chips" id="ad-chips"></div>
    <div class="ad-summary-row">
      <label for="ad-output-dir">Output</label>
      <input type="text" id="ad-output-dir" class="input-field" readonly style="flex:1;font-size:11px;" />
      <button type="button" class="win-button" id="ad-browse-btn" style="font-size:10px;"><i class="bi bi-folder2-open"></i> Browse</button>
      <button type="button" class="win-button" id="ad-open-folder-btn" style="font-size:10px;"><i class="bi bi-folder"></i> Open</button>
    </div>
    <div class="ad-summary-row">
      <label for="ad-conns">Connections</label>
      <input type="number" id="ad-conns" min="1" max="16" value="${state.settings.connections}" />
      <label for="ad-speed">Speed (KiB/s, 0=∞)</label>
      <input type="number" id="ad-speed" min="0" value="${state.settings.speedLimitKb}" />
      <label for="ad-tries">Max tries</label>
      <input type="number" id="ad-tries" min="0" value="${state.settings.maxTries}" />
    </div>
    <div class="ad-summary-row">
      <label class="ad-toggle"><input type="checkbox" id="ad-auto-rename" ${state.settings.autoRename ? "checked" : ""} /> Rename if exists (<span style="font-family:'Consolas',monospace;">_1</span>, <span style="font-family:'Consolas',monospace;">_2</span>, ...)</label>
      <label class="ad-toggle"><input type="checkbox" id="ad-auto-start" ${state.settings.autoStart ? "checked" : ""} /> Auto start queue</label>
    </div>`;
  root.appendChild(topBar);

  // ── Queue / History / Sites columns ───────────────────────────────────────
  const middle = document.createElement("div");
  middle.className = "ad-middle";
  middle.innerHTML = `
    <div class="ad-column ad-queue-box">
      <div class="group-box" style="flex:1;display:flex;flex-direction:column;min-height:0;">
        <div class="group-box-title"><i class="bi bi-list-ul"></i> Download Queue <span id="ad-queue-count" style="color:#888;font-size:10px;"></span>
        </div>
        <div class="ad-toolbar-row" style="margin-top:0;" id="ad-queue-filter">
          <button type="button" class="win-button" id="ad-start-all-btn" style="font-size:10px;"><i class="bi bi-play-fill"></i> Start All</button>
          <button type="button" class="win-button ad-filter-btn active" data-status="">All</button>
          <button type="button" class="win-button ad-filter-btn" data-status="queued">Queued</button>
          <button type="button" class="win-button ad-filter-btn" data-status="running">Running</button>
          <button type="button" class="win-button ad-filter-btn" data-status="completed">Completed</button>
          <button type="button" class="win-button ad-filter-btn" data-status="failed">Failed</button>
          <button type="button" class="win-button ad-filter-btn" data-status="cancelled">Cancelled</button>
        </div>
        <div class="ad-scroll" id="ad-queue-list"></div>
      </div>
    </div>
    <div class="ad-column ad-history-box">
      <div class="group-box" style="flex:1;display:flex;flex-direction:column;min-height:0;">
        <div class="group-box-title"><i class="bi bi-clock-history"></i> History</div>
        <div class="ad-toolbar-row" style="margin-top:0;">
          <input type="text" id="ad-history-search" class="input-field" placeholder="Search history..." style="flex:1;font-size:11px;" />
          <button type="button" class="win-button" id="ad-history-refresh" style="font-size:10px;"><i class="bi bi-arrow-clockwise"></i></button>
        </div>
        <div class="ad-scroll" id="ad-history-list" style="margin-top:4px;"></div>
      </div>
    </div>`;
  root.appendChild(middle);

  // ── Bottom log console dock ───────────────────────────────────────────────
  const logBox = document.createElement("div");
  logBox.className = "group-box";
  logBox.style.cssText = "flex-shrink:0;";
  logBox.innerHTML = `
    <div class="group-box-title"><i class="bi bi-terminal"></i> aria2 Console</div>
    <div class="ad-log-dock" id="ad-log-dock"></div>`;
  root.appendChild(logBox);

  // ── Listeners ─────────────────────────────────────────────────────────────
  const urlInput = root.querySelector<HTMLTextAreaElement>("#ad-url-input");
  const addBtn = root.querySelector("#ad-add-btn");
  if (addBtn) addBtn.addEventListener("click", () => void addUrls(urlInput?.value ?? ""));
  if (urlInput) {
    urlInput.addEventListener("input", updateChips);
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void addUrls(urlInput.value);
      }
    });
  }
  const clearBtn = root.querySelector("#ad-clear-input-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (urlInput) urlInput.value = "";
      updateChips();
    });
  }

  const outInput = root.querySelector<HTMLInputElement>("#ad-output-dir");
  if (outInput) outInput.value = state.settings.outputDir;

  const browseBtn = root.querySelector("#ad-browse-btn");
  if (browseBtn) {
    browseBtn.addEventListener("click", async () => {
      const path = await pickDirectory();
      if (path) {
        state.settings.outputDir = path;
        if (outInput) outInput.value = path;
        savePersisted("aria2-downloader-output-dir", path);
        log(`Output directory set: ${path}`, "success");
      }
    });
  }
  const openFolderBtn = root.querySelector("#ad-open-folder-btn");
  if (openFolderBtn) {
    openFolderBtn.addEventListener("click", async () => {
      const api = (window as any).__TAURI__?.core;
      if (!api?.invoke || !state.settings.outputDir) return;
      try {
        await api.invoke("open_file_externally", { path: state.settings.outputDir });
      } catch {
        log("Could not open output folder.", "error");
      }
    });
  }

  const connsInput = root.querySelector<HTMLInputElement>("#ad-conns");
  if (connsInput) {
    connsInput.value = String(state.settings.connections);
    connsInput.addEventListener("change", () => {
      state.settings.connections = Math.max(1, Math.min(16, parseInt(connsInput.value, 10) || state.settings.connections));
      connsInput.value = String(state.settings.connections);
      savePersisted("aria2-downloader-connections", String(state.settings.connections));
    });
  }
  const speedInput = root.querySelector<HTMLInputElement>("#ad-speed");
  if (speedInput) {
    speedInput.value = String(state.settings.speedLimitKb);
    speedInput.addEventListener("change", () => {
      state.settings.speedLimitKb = Math.max(0, parseInt(speedInput.value, 10) || 0);
      speedInput.value = String(state.settings.speedLimitKb);
      savePersisted("aria2-downloader-speed-limit", String(state.settings.speedLimitKb));
    });
  }
  const triesInput = root.querySelector<HTMLInputElement>("#ad-tries");
  if (triesInput) {
    triesInput.value = String(state.settings.maxTries);
    triesInput.addEventListener("change", () => {
      state.settings.maxTries = Math.max(0, parseInt(triesInput.value, 10) || 0);
      triesInput.value = String(state.settings.maxTries);
      savePersisted("aria2-downloader-max-tries", String(state.settings.maxTries));
    });
  }

  const installBtn = root.querySelector("#ad-install-btn");
  if (installBtn) installBtn.addEventListener("click", () => void installAria2());

  const historySearch = root.querySelector<HTMLInputElement>("#ad-history-search");
  if (historySearch) {
    historySearch.addEventListener("input", () => {
      void refreshHistoryUI(historySearch.value);
    });
  }
  const historyRefresh = root.querySelector("#ad-history-refresh");
  if (historyRefresh) {
    historyRefresh.addEventListener("click", () => {
      void refreshHistoryUI(historySearch?.value ?? "");
    });
  }

  const autoRename = root.querySelector<HTMLInputElement>("#ad-auto-rename");
  if (autoRename) {
    autoRename.checked = state.settings.autoRename;
    autoRename.addEventListener("change", () => {
      state.settings.autoRename = autoRename.checked;
      savePersisted("aria2-downloader-auto-rename", autoRename.checked ? "1" : "0");
    });
  }
  const autoStart = root.querySelector<HTMLInputElement>("#ad-auto-start");
  if (autoStart) {
    autoStart.checked = state.settings.autoStart;
    autoStart.addEventListener("change", () => {
      state.settings.autoStart = autoStart.checked;
      savePersisted("aria2-downloader-auto-start", autoStart.checked ? "1" : "0");
    });
  }

  const startAllBtn = root.querySelector("#ad-start-all-btn");
  if (startAllBtn) startAllBtn.addEventListener("click", () => void startAllQueued());

  const queueFilterEls = root.querySelectorAll<HTMLButtonElement>("#ad-queue-filter .ad-filter-btn");
  queueFilterEls.forEach((btn) =>
    btn.addEventListener("click", () => {
      queueStatusFilter = btn.dataset.status ?? "";
      queueFilterEls.forEach((b) => b.classList.toggle("active", b === btn));
      renderQueue();
    })
  );

  wireColumnResize();

  // ── Initial render ────────────────────────────────────────────────────────
  // Pass the list elements directly: the host appends `root` to the document
  // only after `renderTab` returns, so `document.getElementById` misses them.
  renderQueue(queueList);
  updateChips();
  renderHistory(state.history, historyList);
  // Pass the banner element directly (same pre-attach reason).
  setToolBanner(state.toolAvailable, state.toolVersion, defaultBannerText(), banner);

  // Guarantee history autofetches after the host attaches `root`: bootstrap's
  // own fetch may have completed before the tab was mounted, and its render
  // then found no `ad-history-list` element yet. Re-running is idempotent.
  void initHistory();

  return root;
}

function defaultBannerText(): string {
  return state.toolInstalling
    ? "Installing aria2 engine..."
    : "aria2 engine not found. Download & install it to enable multi-connection downloads.";
}

// ── Link-inspector chips ────────────────────────────────────────────────────

export function updateChips(): void {
  const input = el<HTMLTextAreaElement>("ad-url-input");
  const chips = el("ad-chips");
  if (!input || !chips) return;
  const urls = splitUrls(input.value);
  const visible = urls.slice(0, 12);
  chips.innerHTML = "";
  if (visible.length === 0) return;
  for (const u of visible) {
    const r = checkUrlCompatibility(u);
    const chip = document.createElement("span");
    chip.className = `ad-chip ${r.status === "verified_direct" ? "ok" : r.status === "generic_direct" ? "warn" : "bad"}`;
    chip.title = `${u}\n${r.label} — ${r.badgeText}`;
    chip.textContent = r.badgeText;
    chips.appendChild(chip);
  }
  if (urls.length > visible.length) {
    const more = document.createElement("span");
    more.className = "ad-chip";
    more.textContent = `+${urls.length - visible.length} more`;
    chips.appendChild(more);
  }
}

/** Split a pasted block into individual URL tokens (whitespace separated). */
export function splitUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Tool setup (aria2 engine) ───────────────────────────────────────────────

export function setToolBanner(available: boolean, version: string | null, message: string, bannerEl?: HTMLElement): void {
  const banner = bannerEl ?? el("ad-banner");
  const text = banner?.querySelector<HTMLElement>("#ad-banner-text");
  if (!banner || !text) return;
  if (available) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  text.textContent = message + (version ? ` (${version})` : "");
}

export async function refreshToolStatus(): Promise<void> {
  try {
    const status = await checkTool(ARIA2_TOOL);
    state.toolAvailable = status.installed;
    state.toolVersion = status.version;
  } catch (err) {
    state.toolAvailable = false;
    state.toolVersion = null;
    log(`Tool check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  setToolBanner(state.toolAvailable, state.toolVersion, defaultBannerText());
}

interface EngineInstallHooks {
  /** Called on each poll with (status, percent). */
  onStatus?: (status: string, percent: number) => void;
  /** Called once when the install task finishes. */
  onDone?: (ok: boolean, error: string | null) => void;
}

/**
 * aria2 engine install driver. Starts `InstallTool` (or adopts an install that
 * is already running) and streams `GetToolInstallProgress` into the tab's log
 * dock until the task reaches a terminal status. Progress is surfaced in the
 * in-tab prompt banner via the onStatus/onDone hooks.
 */
function runEngineInstall({ onStatus, onDone }: EngineInstallHooks): void {
  let rendered = 0;

  const finish = (ok: boolean, error: string | null): void => {
    state.toolInstalling = false;
    if (onDone) onDone(ok, error);
  };

  const poll = async (): Promise<void> => {
    let p: { status: string; percent: number; logs: string[]; error: string | null };
    try {
      p = await getToolInstallProgress(ARIA2_TOOL);
    } catch (err) {
      p = { status: "error", percent: 0, logs: [String(err)], error: String(err) };
    }
    if (onStatus) onStatus(p.status, p.percent);
    rendered = appendLogLines("ad-log-dock", p.logs, rendered);

    if (p.status === "completed" || p.status === "done") {
      log("Install complete.", "success");
      await refreshToolStatus();
      finish(true, null);
      return;
    }
    if (p.status === "failed" || p.status === "error") {
      log(`Install failed: ${p.error ?? p.status}`, "error");
      finish(false, p.error ?? p.status);
      return;
    }
    setTimeout(() => void poll(), 1000);
  };

  const start = async (): Promise<void> => {
    try {
      const { started, error } = await installTool(ARIA2_TOOL);
      if (!started && error) {
        log(`Install could not start: ${error}`, "error");
        finish(false, error);
        return;
      }
    } catch (err) {
      log(`Install start failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }
    await poll();
  };

  void start();
}

async function installAria2(): Promise<void> {
  if (state.toolInstalling) return;
  state.toolInstalling = true;
  const installBtn = el<HTMLButtonElement>("ad-install-btn");
  if (installBtn) installBtn.disabled = true;
  const statusEl = el("ad-banner-status");
  const progressEl = el("ad-banner-progress");
  const fill = el<HTMLElement>("ad-banner-fill");
  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.textContent = "Starting install...";
  }
  if (progressEl) progressEl.style.display = "block";
  if (fill) fill.style.width = "0%";
  log("Installing aria2 engine...", "info");

  runEngineInstall({
    onStatus: (status, percent) => {
      if (statusEl) statusEl.textContent = `${status} ${percent}%`;
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    },
    onDone: (ok, error) => {
      if (installBtn) installBtn.disabled = false;
      if (ok) {
        if (statusEl) statusEl.textContent = "Installed.";
        if (fill) fill.style.width = "100%";
        log("aria2 installed successfully.", "success");
      } else {
        if (statusEl) statusEl.textContent = error ?? "Install failed.";
        log(`aria2 install failed: ${error}`, "error");
      }
    },
  });
}

// ── History ─────────────────────────────────────────────────────────────────

export async function initHistory(): Promise<void> {
  await ensureHistorySchema();
  await refreshHistoryUI("");
}

async function refreshHistoryUI(term: string): Promise<void> {
  try {
    state.history = term.trim()
      ? await searchHistory(term.trim())
      : await queryHistory(200);
  } catch (err) {
    log(`History load failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  renderHistory(state.history);
}

export async function removeHistoryRecord(id: number): Promise<void> {
  try {
    await removeHistoryEntry(id);
    state.history = state.history.filter((r) => r.id !== id);
    renderHistory(state.history);
    log("Removed history entry.", "info");
  } catch (err) {
    log(`Remove failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

// ── Queue + download lifecycle ──────────────────────────────────────────────

let lastQueueRender = 0;

/** Active queue status filter; empty string shows every status. */
let queueStatusFilter = "";
function renderQueueThrottled(): void {
  const now = performance.now();
  if (now - lastQueueRender < 350) return;
  lastQueueRender = now;
  renderQueue();
}

export async function addUrls(raw: string): Promise<void> {
  const urls = splitUrls(raw);
  if (urls.length === 0) return;

  // Detect the engine before enqueuing anything: without aria2c the generic
  // DownloadStart fails server-side, so the in-tab banner prompts the user to
  // install it first.
  if (!state.toolAvailable) {
    log("aria2 engine not installed - downloads are disabled until it is available.", "error");
    setToolBanner(false, state.toolVersion, defaultBannerText());
    return;
  }

  // With auto-rename on, a duplicate URL is legitimately downloadable again to
  // a new `_N` path, so neither the in-queue check nor the history dedup may
  // skip it.
  let fresh = urls;
  if (!state.settings.autoRename) {
    const queued = new Set<string>();
    for (const item of state.queue.values()) queued.add(item.url);
    fresh = urls.filter((u) => !queued.has(u));
  }

  if (fresh.length === 0) {
    log("All pasted URLs are already in the queue.", "info");
    return;
  }

  // Skip URLs already downloaded to this output before (dedup integrity).
  // When auto-rename is on, a fresh copy is written to a new _N path, so a
  // previous entry is not a reason to skip.
  let dupes: string[] = [];
  if (!state.settings.autoRename) {
    try {
      dupes = await findDuplicateUrls(fresh);
    } catch (err) {
      log(`Dedup check failed (continuing): ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  const dupSet = new Set(dupes);
  for (const d of dupes) {
    log(`Already downloaded previously, skipping: ${d}`, "info");
  }

  const toEnqueue = fresh.filter((u) => !dupSet.has(u));
  for (const u of toEnqueue) {
    await enqueue(u);
  }

  const input = el<HTMLTextAreaElement>("ad-url-input");
  if (input) input.value = "";
  updateChips();
}

async function enqueue(url: string, startNow = state.settings.autoStart): Promise<void> {
  if (!state.toolAvailable) {
    log("aria2 engine not installed - install it from the tab banner first.", "error");
    setToolBanner(false, state.toolVersion, defaultBannerText());
    return;
  }
  if (!state.settings.outputDir) {
    log("Choose an output directory first (Browse).", "error");
    return;
  }
  const filename = filenameFromUrl(url, state.queue.size + 1);
  const requestedPath = joinPath(state.settings.outputDir, filename);
  // Generate the id up front so a queued item keeps a stable key; the backend
  // accepts this id via `DownloadStart.job_id` when the item is started.
  const jobId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // The backend owns `_N` renaming: ask it to resolve (and reserve) the exact
  // output path, so queued duplicates display and download to distinct files
  // without the frontend guessing names.
  let outputPath = requestedPath;
  try {
    outputPath = await resolveOutputPath(jobId, requestedPath, state.settings.autoRename);
  } catch (err) {
    log(`Output path resolve failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  const displayName = outputPath.split(/[\\/]/).pop() || filename;

  const item: QueueItem = {
    jobId,
    url,
    filename: displayName,
    outputPath,
    status: "queued",
    percent: 0,
    downloadedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    etaSecs: null,
    connections: 0,
    error: null,
    logs: [],
    logIndex: 0,
    command: null,
    engine: ARIA2_TOOL,
    startedAt: Date.now(),
    completedAt: null,
  };
  state.queue.set(jobId, item);
  renderQueue();

  if (startNow) {
    await startQueuedItem(jobId);
  } else {
    log(`Queued (paused): ${displayName}`, "info");
  }
}

/** Kick off a queued item (or retry) by sending `DownloadStart` and polling. */
async function startQueuedItem(jobId: string): Promise<void> {
  const it = state.queue.get(jobId);
  if (!it) return;
  if (!state.toolAvailable) {
    log("aria2 engine not installed - install it from the tab banner first.", "error");
    setToolBanner(false, state.toolVersion, defaultBannerText());
    return;
  }
  if (!state.settings.outputDir) {
    log("Choose an output directory first (Browse).", "error");
    return;
  }
  it.status = "running";
  renderQueue();
  try {
    await downloadStart({
      engine: ARIA2_TOOL,
      url: it.url,
      output_path: it.outputPath,
      job_id: it.jobId,
      max_connections: state.settings.connections,
      speed_limit_kb: state.settings.speedLimitKb > 0 ? state.settings.speedLimitKb : undefined,
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Project Curator",
      max_tries: state.settings.maxTries,
      auto_rename: state.settings.autoRename,
    });
  } catch (err) {
    it.status = "failed";
    it.error = err instanceof Error ? err.message : String(err);
    renderQueue();
    log(`Start failed for ${it.url}: ${it.error}`, "error");
    return;
  }
  log(`Queued: ${it.filename}`, "info");
  startPoll(jobId);
}

/** Start every item currently parked in the "queued" state. */
async function startAllQueued(): Promise<void> {
  const queued = [...state.queue.values()].filter((i) => i.status === "queued");
  if (queued.length === 0) return;
  log(`Starting ${queued.length} queued download(s)...`, "info");
  await Promise.all(queued.map((i) => startQueuedItem(i.jobId)));
}

function startPoll(jobId: string): void {
  const item = state.queue.get(jobId);
  if (!item) return;

  pollServiceProgress({
    intervalMs: 600,
    fetch: async () => {
      try {
        return await downloadProgress(jobId);
      } catch {
        return undefined;
      }
    },
    isRunning: (p) => p.running,
    onTick: (p) => {
      const it = state.queue.get(jobId);
      if (!it) return;
      it.percent = p.percent;
      it.downloadedBytes = p.downloadedBytes;
      it.totalBytes = p.totalBytes;
      it.speedBps = p.speedBps;
      it.etaSecs = p.etaSecs;
      it.connections = p.connections;
      it.error = p.error;
      it.command = p.command;
      it.engine = p.engine;
      if (isAbsolutePath(p.outputPath)) {
      it.outputPath = p.outputPath;
      const canonical = p.outputPath.split(/[\\/]/).pop();
      if (canonical) it.filename = canonical;
    }
      if (p.logs.length > 0) it.logs = p.logs;
      appendLogDelta(it);
      renderQueueThrottled();
    },
    onComplete: (ok, last) => finalize(jobId, ok, last),
  });
}

function finalize(jobId: string, ok: boolean, last: DownloadProgress | undefined): void {
  const it = state.queue.get(jobId);
  if (!it) return;

  if (last) {
    it.percent = last.percent;
    it.downloadedBytes = last.downloadedBytes;
    it.totalBytes = last.totalBytes;
    it.speedBps = last.speedBps;
    it.error = last.error;
    if (last.outputPath && isAbsolutePath(last.outputPath)) {
      it.outputPath = last.outputPath;
      const canonical = last.outputPath.split(/[\\/]/).pop();
      if (canonical) it.filename = canonical;
    }
    if (last.logs.length > 0) it.logs = last.logs;
  }
  appendLogDelta(it);

  const status = last?.status;
  let final: QueueItem["status"];
  if (status === "cancelled") final = "cancelled";
  else if (status === "failed" || last?.error || !ok) final = "failed";
  else final = "completed";

  it.status = final;
  it.completedAt = Date.now();
  renderQueue();
  renderQueueThrottled();

  const finished = last?.status ?? (ok ? "completed" : "failed");
  log(
    `${final.toUpperCase()} ${it.filename} - ${formatBytes(it.downloadedBytes)} in ${formatDuration(it.startedAt, it.completedAt)}` +
      (it.error ? ` (${it.error})` : ""),
    final === "completed" ? "success" : "error"
  );

  if (final === "completed") {
    void recordFinished(it);
  }
}

async function recordFinished(it: QueueItem): Promise<void> {
  try {
    // Never persist garbage: skip recording when the resolved output path is
    // not an absolute, verifiable location.
    if (!isAbsolutePath(it.outputPath)) {
      log(`History skipped: no valid output path for ${it.filename}`, "error");
      return;
    }
    await ensureHistorySchema();
    await recordDownload({
      url: it.url,
      normalized_url: it.url,
      // Canonical name: the basename of the resolved file on disk, so an
      // auto-renamed download (e.g. `file_1.jpg`) is shown under its real name
      // rather than the URL-derived one.
      filename: it.outputPath.split(/[\\/]/).pop() || it.filename,
      file_path: it.outputPath,
      file_size: it.downloadedBytes,
      status: it.status,
      error_message: it.error,
      completed_at: Math.floor((it.completedAt ?? Date.now()) / 1000),
      package_name: null,
    });
    await refreshHistoryUI("");
  } catch (err) {
    log(`History record failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function formatDuration(startedAt: number, completedAt: number): string {
  const s = Math.max(0, Math.round((completedAt - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export async function retryDownload(jobId: string): Promise<void> {
  const it = state.queue.get(jobId);
  if (!it) return;
  state.queue.delete(jobId);
  renderQueue();
  log(`Retrying: ${it.filename}`, "info");
  await enqueue(it.url, true);
}

export async function redownloadUrl(url: string): Promise<void> {
  await enqueue(url);
}

export async function cancelDownload(jobId: string): Promise<void> {
  try {
    await downloadCancel(jobId);
    log("Cancel requested.", "info");
  } catch (err) {
    log(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

// ── Queue rendering ─────────────────────────────────────────────────────────

export function renderQueue(listEl?: HTMLElement): void {
  const list = listEl ?? el("ad-queue-list");
  if (!list) return;
  list.innerHTML = "";

  const items = [...state.queue.values()].filter(
    (i) => !queueStatusFilter || i.status === queueStatusFilter
  );

  if (items.length === 0) {
    list.innerHTML = queueStatusFilter
      ? '<div class="ad-empty">No queued items with this status.</div>'
      : '<div class="ad-empty">No downloads in queue.</div>';
  } else {
    const table = document.createElement("table");
    table.className = "ad-table";
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr>" +
      '<th class="col-status">Status</th>' +
      '<th class="col-hoster">Hoster</th>' +
      '<th class="col-file">File</th>' +
      '<th class="col-progress">Progress</th>' +
      '<th class="col-size">Size</th>' +
      '<th class="col-speed">Speed</th>' +
      '<th class="col-eta">ETA</th>' +
      '<th class="col-actions">Actions</th>' +
      "</tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const item of items) {
      tbody.appendChild(renderQueueRow(item));
    }
    table.appendChild(tbody);
    list.appendChild(table);
  }

  applyColumnWidths();

  const count = el("ad-queue-count");
  if (count) count.textContent = state.queue.size ? `(${state.queue.size})` : "";
}

function renderQueueRow(item: QueueItem): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "ad-table-row";

  const tdStatus = document.createElement("td");
  tdStatus.className = "col-status";
  const statusBadge = document.createElement("span");
  statusBadge.className = `ad-badge ${item.status}`;
  statusBadge.textContent = item.status;
  tdStatus.appendChild(statusBadge);

  const tdFile = document.createElement("td");
  tdFile.className = "col-file";
  const name = document.createElement("div");
  name.className = "ad-row-mono";
  name.textContent = item.filename;
  name.title = item.url;
  const url = document.createElement("div");
  url.className = "ad-meta";
  url.textContent = item.url;
  url.style.cssText = "display:block;width:100%;";
  tdFile.appendChild(name);
  tdFile.appendChild(url);
  if ((item.status === "failed" || item.status === "cancelled") && item.error) {
    const err = document.createElement("div");
    err.className = "ad-error";
    err.textContent = item.error;
    tdFile.appendChild(err);
  }

  const tdProgress = document.createElement("td");
  tdProgress.className = "col-progress";
  const progressWrap = document.createElement("div");
  progressWrap.className = "ad-progress-wrap";
  const bar = document.createElement("div");
  bar.className = "ad-progress";
  const fill = document.createElement("div");
  fill.className = "ad-progress-fill";
  fill.style.width = `${Math.max(0, Math.min(100, item.percent))}%`;
  bar.appendChild(fill);
  const pct = document.createElement("span");
  pct.className = "ad-meta";
  pct.textContent = `${Math.round(item.percent)}%`;
  progressWrap.appendChild(bar);
  progressWrap.appendChild(pct);
  tdProgress.appendChild(progressWrap);

  const tdHoster = document.createElement("td");
  tdHoster.className = "col-hoster";
  const hoster = document.createElement("span");
  hoster.className = "ad-meta";
  hoster.style.cssText = "display:block;width:100%;";
  hoster.textContent = hostFromUrl(item.url);
  hoster.title = item.url;
  tdHoster.appendChild(hoster);

  const tdSize = document.createElement("td");
  tdSize.className = "col-size";
  const size = document.createElement("span");
  size.className = "ad-meta";
  size.style.cssText = "display:block;width:100%;";
  const total = item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : "";
  size.textContent = `${formatBytes(item.downloadedBytes)}${total}`;
  tdSize.appendChild(size);

  const running = item.status === "running";
  const tdSpeed = document.createElement("td");
  tdSpeed.className = "col-speed";
  const speed = document.createElement("span");
  speed.className = "ad-meta";
  speed.style.cssText = "display:block;width:100%;";
  speed.textContent = running ? formatRate(item.speedBps) : "—";
  tdSpeed.appendChild(speed);

  const tdEta = document.createElement("td");
  tdEta.className = "col-eta";
  const eta = document.createElement("span");
  eta.className = "ad-meta";
  eta.style.cssText = "display:block;width:100%;";
  eta.textContent = running ? formatEta(item.etaSecs) : "—";
  tdEta.appendChild(eta);

  const tdActions = document.createElement("td");
  tdActions.className = "col-actions";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;justify-content:flex-end;";
  const mk = (icon: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "win-button";
    b.style.cssText = "font-size:10px;padding:1px 6px;";
    b.innerHTML = `<i class="${icon}"></i>`;
    b.title = title;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };

  if (item.status === "queued") {
    mk("bi bi-play-fill", "Start", () => void startQueuedItem(item.jobId));
  }
  if (item.status === "running") {
    mk("bi bi-stop-circle", "Cancel (graceful)", () => void cancelDownload(item.jobId));
  }
  if (item.status === "completed") {
    mk("bi bi-folder2-open", "Reveal in Explorer", () => {
      void (async () => {
        const api = (window as any).__TAURI__?.core;
        if (api?.invoke) {
          try {
            await api.invoke("reveal_in_folder", { path: item.outputPath });
          } catch {
            log("Could not reveal output file.", "error");
          }
        }
      })();
    });
  }
  if (item.status === "failed" || item.status === "cancelled") {
    mk("bi bi-arrow-clockwise", "Retry", () => void retryDownload(item.jobId));
  }
  mk("bi bi-clipboard", "Copy URL", () => void navigator.clipboard?.writeText(item.url));

  tdActions.appendChild(actions);

  tr.appendChild(tdStatus);
  tr.appendChild(tdHoster);
  tr.appendChild(tdFile);
  tr.appendChild(tdProgress);
  tr.appendChild(tdSize);
  tr.appendChild(tdSpeed);
  tr.appendChild(tdEta);
  tr.appendChild(tdActions);
  return tr;
}

// ── History rendering ───────────────────────────────────────────────────────

export function renderHistory(records: HistoryRecord[], listEl?: HTMLElement): void {
  const list = listEl ?? el("ad-history-list");
  if (!list) return;
  list.innerHTML = "";
  if (!records.length) {
    list.innerHTML = '<div class="ad-empty">No downloads recorded yet.</div>';
    return;
  }
  const table = document.createElement("table");
  table.className = "ad-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    '<th class="col-status">Status</th>' +
    '<th class="col-hoster">Hoster</th>' +
    '<th class="col-file">File</th>' +
    '<th class="col-size">Size</th>' +
    '<th class="col-hdate">Completed</th>' +
    '<th class="col-actions">Actions</th>' +
    "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const rec of records) {
    tbody.appendChild(renderHistoryRow(rec));
  }
  table.appendChild(tbody);
  list.appendChild(table);
  applyColumnWidths();
}

function renderHistoryRow(rec: HistoryRecord): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "ad-table-row";

  const tdStatus = document.createElement("td");
  tdStatus.className = "col-status";
  const badge = document.createElement("span");
  badge.className = `ad-badge ${rec.status}`;
  badge.textContent = rec.status;
  tdStatus.appendChild(badge);

  const tdHoster = document.createElement("td");
  tdHoster.className = "col-hoster";
  const hoster = document.createElement("span");
  hoster.className = "ad-meta";
  hoster.style.cssText = "display:block;width:100%;";
  hoster.textContent = hostFromUrl(rec.url);
  hoster.title = rec.url;
  tdHoster.appendChild(hoster);

  const tdFile = document.createElement("td");
  tdFile.className = "col-file";
  const name = document.createElement("div");
  name.className = "ad-row-mono";
  name.textContent = rec.filename;
  name.title = rec.file_path;
  tdFile.appendChild(name);

  const tdSize = document.createElement("td");
  tdSize.className = "col-size";
  const size = document.createElement("span");
  size.className = "ad-meta";
  size.style.cssText = "display:block;width:100%;";
  size.textContent = formatBytes(rec.file_size);
  tdSize.appendChild(size);

  const tdDate = document.createElement("td");
  tdDate.className = "col-hdate";
  const date = document.createElement("span");
  date.className = "ad-meta";
  date.style.cssText = "display:block;width:100%;";
  date.textContent = formatDateTime(rec.completed_at);
  tdDate.appendChild(date);

  const tdActions = document.createElement("td");
  tdActions.className = "col-actions";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;justify-content:flex-end;";
  const mk = (icon: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "win-button";
    b.style.cssText = "font-size:10px;padding:1px 6px;";
    b.innerHTML = `<i class="${icon}"></i>`;
    b.title = title;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  mk("bi bi-folder2-open", "Open in Explorer (highlight)", () => {
    void (async () => {
      const ok = await revealInFolder(rec.file_path);
      if (!ok) log("Could not reveal output file in Explorer.", "error");
    })();
  });
  mk("bi bi-clipboard", "Copy path", () => void navigator.clipboard?.writeText(rec.file_path));
  mk("bi bi-link-45deg", "Copy URL", () => void navigator.clipboard?.writeText(rec.url));
  mk("bi bi-arrow-repeat", "Re-download", () => void redownloadUrl(rec.url));
  mk("bi bi-x-lg", "Remove from history", () => void removeHistoryRecord(rec.id));
  tdActions.appendChild(actions);

  tr.appendChild(tdStatus);
  tr.appendChild(tdHoster);
  tr.appendChild(tdFile);
  tr.appendChild(tdSize);
  tr.appendChild(tdDate);
  tr.appendChild(tdActions);
  return tr;
}

// ── Log dock (delta rendering) ──────────────────────────────────────────────

/** Append new log lines for `item` to the bottom dock. Returns the new index. */
export function appendLogDelta(item: QueueItem): void {
  const dock = el("ad-log-dock");
  if (!dock || item.logIndex >= item.logs.length) return;
  const frag = document.createDocumentFragment();
  for (let i = item.logIndex; i < item.logs.length; i++) {
    const line = document.createElement("div");
    line.textContent = item.logs[i];
    frag.appendChild(line);
  }
  dock.appendChild(frag);
  dock.scrollTop = dock.scrollHeight;
  item.logIndex = item.logs.length;
}

export function clearLogDock(): void {
  const dock = el("ad-log-dock");
  if (dock) dock.innerHTML = "";
}

// ── Module bootstrap ────────────────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
  state.settings.outputDir =
    loadPersisted("aria2-downloader-output-dir", state.settings.outputDir) || state.settings.outputDir;
  state.settings.connections = clampNum(
    parseInt(loadPersisted("aria2-downloader-connections", String(state.settings.connections)), 10),
    1,
    16,
    state.settings.connections
  );
  state.settings.speedLimitKb = Math.max(
    0,
    parseInt(loadPersisted("aria2-downloader-speed-limit", String(state.settings.speedLimitKb)), 10) || 0
  );
  state.settings.maxTries = Math.max(
    0,
    parseInt(loadPersisted("aria2-downloader-max-tries", String(state.settings.maxTries)), 10) || 0
  );
  state.settings.autoRename = loadPersisted("aria2-downloader-auto-rename", "0") === "1";
  state.settings.autoStart = loadPersisted("aria2-downloader-auto-start", "1") === "1";

  await refreshToolStatus();
  await initHistory();
  log("aria2-downloader ready.", "success");
}

function clampNum(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

// Expose `PH` reference to prevent tree-shaking of the PluginHost guard.
void PH;
