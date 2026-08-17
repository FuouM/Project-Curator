/**
 * Download queue lifecycle + queue table rendering for aria2-downloader.
 *
 * Owns URL ingestion (`addUrls`), the queued-item model (`enqueue`), the
 * start/cancel/retry actions, the `pollServiceProgress` polling loop, and the
 * queue table DOM (`renderQueue` / `renderQueueRow`). The status filter state
 * lives here because the queue renderer is the only consumer.
 */

import { formatBytes, pollServiceProgress } from "../../lib";
import {
  downloadCancel,
  downloadProgress,
  downloadStart,
  resolveOutputPath,
} from "./ipc";
import { findDuplicateUrls, ensureHistorySchema, recordDownload } from "./history";
import { state, ARIA2_TOOL, filenameFromUrl, type QueueItem } from "./state";
import { el, log } from "./ui-core";
import { applyColumnWidths } from "./columns";
import {
  formatDuration,
  formatEta,
  formatRate,
  hostFromUrl,
  isAbsolutePath,
  joinPath,
} from "./ui-utils";
import { splitUrls, updateChips } from "./chips";
import { defaultBannerText, setToolBanner } from "./tool-status";
import { appendLogDelta } from "./log-dock";
import { refreshHistoryUI } from "./history-view";
import type { DownloadProgress } from "./ipc";

let lastQueueRender = 0;

/** Active queue status filter; empty string shows every status. */
let queueStatusFilter = "";
export function setQueueStatusFilter(status: string): void {
  queueStatusFilter = status;
}

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
export async function startAllQueued(): Promise<void> {
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
