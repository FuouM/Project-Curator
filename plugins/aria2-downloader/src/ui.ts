/**
 * Entry-point tab bootstrap + root event wiring for aria2-downloader.
 *
 * This module is intentionally thin: it owns the tab tree construction
 * (`renderTab`), the settings bootstrap (`bootstrap`), and the DOM listeners
 * that bind toolbar inputs to the feature modules. Queue lifecycle, history
 * rendering, engine install, chips, columns, and the log dock all live in
 * their own modules.
 */

import { loadPersisted, pickDirectory, savePersisted } from "../../lib";
import { state } from "./state";
import { el, log, PH } from "./ui-core";
import { clampNum, formatEta } from "./ui-utils";
import { applyColumnWidths, wireColumnResize } from "./columns";
import { injectStyles } from "./styles";
import { updateChips, splitUrls } from "./chips";
import { defaultBannerText, installAria2, refreshToolStatus, setToolBanner } from "./tool-status";
import { initHistory, refreshHistoryUI, removeHistoryRecord, renderHistory } from "./history-view";
import {
  addUrls,
  cancelDownload,
  renderQueue,
  retryDownload,
  redownloadUrl,
  setQueueStatusFilter,
  startAllQueued,
} from "./queue";
import { appendLogDelta, clearLogDock } from "./log-dock";

// Preserve the original module surface for any consumer importing from "./ui".
export { formatEta, log, injectStyles, updateChips, splitUrls, setToolBanner, refreshToolStatus };
export {
  addUrls,
  cancelDownload,
  renderQueue,
  retryDownload,
  redownloadUrl,
  setQueueStatusFilter,
  startAllQueued,
};
export { initHistory, removeHistoryRecord, renderHistory };
export { appendLogDelta, clearLogDock };

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
      setQueueStatusFilter(btn.dataset.status ?? "");
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

// Expose `PH` reference to prevent tree-shaking of the PluginHost guard.
void PH;
