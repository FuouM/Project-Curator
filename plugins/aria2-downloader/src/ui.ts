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
import { state, TAB_ID } from "./state";
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

export function buildWorkspaceRoot(): HTMLElement {
  injectStyles();

  const root = document.createElement("div");
  root.className = "ad-workspace";

  // ── aria2 setup prompt (in-tab banner, shown only when the engine is
  //    unavailable). This is the plugin's only install UI - no modal.
  const banner = document.createElement("div");
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
    <div id="ad-add-feedback" style="display:none;font-size:11px;padding:5px 8px;margin-top:6px;border:1px solid var(--sys-border-dark,#999);border-radius:2px;background:var(--sys-window-bg,#fff);"></div>
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

  const queueList = middle.querySelector<HTMLElement>("#ad-queue-list");
  const historyList = middle.querySelector<HTMLElement>("#ad-history-list");

  // ── Bottom log console dock ───────────────────────────────────────────────
  const logDock = document.createElement("div");
  logDock.className = "group-box ad-log-dock";
  logDock.innerHTML = `
    <div class="group-box-title" style="display:flex;align-items:center;justify-content:space-between;">
      <span><i class="bi bi-terminal"></i> Activity Log</span>
      <button type="button" class="win-button" id="ad-log-clear-btn" style="font-size:10px;padding:0 5px;height:18px;line-height:18px;"><i class="bi bi-trash3"></i> Clear</button>
    </div>
    <div class="ad-log-box" id="ad-log"></div>`;
  root.appendChild(logDock);

  const showFeedback = (html: string, isError: boolean) => {
    const fb = root.querySelector<HTMLElement>("#ad-add-feedback");
    if (!fb) return;
    fb.innerHTML = html;
    fb.style.display = "block";
    fb.style.color = isError ? "var(--sys-error-text, #c00)" : "var(--sys-window-text, #333)";
    fb.style.borderColor = isError ? "var(--sys-error-text, #c00)" : "var(--sys-border-dark, #999)";
    fb.style.background = isError ? "rgba(255, 0, 0, 0.05)" : "rgba(0, 128, 0, 0.05)";
  };

  const clearFeedback = () => {
    const fb = root.querySelector<HTMLElement>("#ad-add-feedback");
    if (fb) {
      fb.style.display = "none";
      fb.innerHTML = "";
    }
  };

  // ── Event wiring ──────────────────────────────────────────────────────────
  root.querySelector("#ad-log-clear-btn")?.addEventListener("click", () => clearLogDock());
  root.querySelector("#ad-install-btn")?.addEventListener("click", () => void installAria2(banner));
  root.querySelector("#ad-add-btn")?.addEventListener("click", async () => {
    const ta = root.querySelector<HTMLTextAreaElement>("#ad-url-input");
    if (!ta || !ta.value.trim()) return;
    clearFeedback();
    const res = await addUrls(ta.value);
    if (res.added > 0) {
      ta.value = "";
      updateChips();
      let msg = `<i class="bi bi-check-circle"></i> Added <b>${res.added}</b> URL(s) to queue.`;
      if (res.skippedHistory > 0) {
        msg += ` (${res.skippedHistory} duplicate(s) already in history skipped)`;
      }
      if (res.skippedQueue > 0) {
        msg += ` (${res.skippedQueue} already in queue skipped)`;
      }
      showFeedback(msg, false);
      log(`Added ${res.added} URL(s) to queue.`, "info");
      if (state.settings.autoStart) void startAllQueued();
    } else {
      if (res.skippedHistory > 0) {
        showFeedback(
          `<i class="bi bi-exclamation-triangle"></i> Rejected: <b>${res.skippedHistory}</b> URL(s) were already downloaded previously.<br/><span style="opacity:0.85;font-size:10px;">Enable <i>"Rename if exists (_1, _2, ...)"</i> below if you wish to download duplicate copies.</span>`,
          true,
        );
        log(
          `Rejected: ${res.skippedHistory} URL(s) were already downloaded previously. Enable "Rename if exists" to download duplicates.`,
          "warn",
        );
      } else if (res.skippedQueue > 0) {
        showFeedback(
          `<i class="bi bi-info-circle"></i> <b>${res.skippedQueue}</b> URL(s) are already present in the active download queue.`,
          true,
        );
        log(`Rejected: ${res.skippedQueue} URL(s) are already in the queue.`, "warn");
      } else {
        showFeedback(`<i class="bi bi-x-circle"></i> No valid URLs found to download.`, true);
      }
    }
  });
  root.querySelector("#ad-clear-input-btn")?.addEventListener("click", () => {
    const ta = root.querySelector<HTMLTextAreaElement>("#ad-url-input");
    if (ta) ta.value = "";
    clearFeedback();
    updateChips();
  });
  root.querySelector("#ad-url-input")?.addEventListener("input", () => {
    clearFeedback();
    updateChips();
  });

  const outInput = root.querySelector<HTMLInputElement>("#ad-output-dir");
  if (outInput) {
    outInput.value = state.settings.outputDir;
  }
  root.querySelector("#ad-browse-btn")?.addEventListener("click", async () => {
    const picked = await pickDirectory();
    if (picked) {
      state.settings.outputDir = picked;
      savePersisted("aria2-downloader-output-dir", picked);
      if (outInput) outInput.value = picked;
      log("Output directory set: " + picked, "info");
    }
  });
  root.querySelector("#ad-open-folder-btn")?.addEventListener("click", async () => {
    const dir = state.settings.outputDir;
    if (!dir) return;
    try {
      await PH.callService("OpenFolder", { path: dir });
    } catch {
      window.open("file://" + dir.replace(/\\/g, "/"));
    }
  });

  const conns = root.querySelector<HTMLInputElement>("#ad-conns");
  if (conns) {
    conns.value = String(state.settings.connections);
    conns.addEventListener("change", () => {
      state.settings.connections = clampNum(parseInt(conns.value, 10), 1, 16, 4);
      conns.value = String(state.settings.connections);
      savePersisted("aria2-downloader-connections", String(state.settings.connections));
    });
  }

  const speed = root.querySelector<HTMLInputElement>("#ad-speed");
  if (speed) {
    speed.value = String(state.settings.speedLimitKb);
    speed.addEventListener("change", () => {
      state.settings.speedLimitKb = Math.max(0, parseInt(speed.value, 10) || 0);
      speed.value = String(state.settings.speedLimitKb);
      savePersisted("aria2-downloader-speed-limit", String(state.settings.speedLimitKb));
    });
  }

  const tries = root.querySelector<HTMLInputElement>("#ad-tries");
  if (tries) {
    tries.value = String(state.settings.maxTries);
    tries.addEventListener("change", () => {
      state.settings.maxTries = Math.max(0, parseInt(tries.value, 10) || 0);
      tries.value = String(state.settings.maxTries);
      savePersisted("aria2-downloader-max-tries", String(state.settings.maxTries));
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

  const queueFilterEls = root.querySelectorAll<HTMLButtonElement>(
    "#ad-queue-filter .ad-filter-btn",
  );
  queueFilterEls.forEach((btn) =>
    btn.addEventListener("click", () => {
      setQueueStatusFilter(btn.dataset.status ?? "");
      queueFilterEls.forEach((b) => b.classList.toggle("active", b === btn));
      renderQueue();
    }),
  );

  wireColumnResize();

  // ── Initial render ────────────────────────────────────────────────────────
  renderQueue(queueList);
  updateChips();
  renderHistory(state.history, historyList);
  setToolBanner(state.toolAvailable, state.toolVersion, defaultBannerText(), banner);

  // Probe tool status and fetch history immediately
  void refreshToolStatus(banner);
  setTimeout(() => {
    void refreshToolStatus();
    void initHistory();
  }, 50);

  return root;
}

export function renderTab(): HTMLElement {
  return buildWorkspaceRoot();
}

export async function bootstrap(): Promise<void> {
  state.settings.outputDir =
    loadPersisted("aria2-downloader-output-dir", state.settings.outputDir) ||
    state.settings.outputDir;
  state.settings.connections = clampNum(
    parseInt(loadPersisted("aria2-downloader-connections", String(state.settings.connections)), 10),
    1,
    16,
    state.settings.connections,
  );
  state.settings.speedLimitKb = Math.max(
    0,
    parseInt(
      loadPersisted("aria2-downloader-speed-limit", String(state.settings.speedLimitKb)),
      10,
    ) || 0,
  );
  state.settings.maxTries = Math.max(
    0,
    parseInt(loadPersisted("aria2-downloader-max-tries", String(state.settings.maxTries)), 10) || 0,
  );
  state.settings.autoRename = loadPersisted("aria2-downloader-auto-rename", "0") === "1";
  state.settings.autoStart = loadPersisted("aria2-downloader-auto-start", "1") === "1";

  await refreshToolStatus();
  await initHistory();
  log("aria2-downloader ready.", "success");
}

// Expose `PH` reference to prevent tree-shaking of the PluginHost guard.
void PH;
