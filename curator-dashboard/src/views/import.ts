import { typedCall } from "../ipc";
import { folderDetailsFromProto } from "../proto-adapters";
import {
  ImportImageRequestSchema,
  ImportResultSchema,
  ImportedFoldersResultSchema,
  ImportProgressSchema,
  CancelImportResultSchema,
} from "../gen/import_pb";
import { StatusResultSchema } from "../gen/system_pb";
import { SafeHtml, html } from "../components";
import { setStatusMessage } from "../utils";
import { setupBrowseMultiButton } from "../cards";
import { refreshDashboard } from "./dashboard";
import { refreshGallery } from "./gallery";

let importProgressTimer: any = null;
let scanProgressTimer: any = null;

export function setupImport() {
  const importForm = document.getElementById("import-form");
  const importInput = document.getElementById("import-path-input") as HTMLInputElement;
  const importMsg = document.getElementById("import-status-msg");
  const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("import-dismiss-btn") as HTMLButtonElement | null;

  if (importInput) {
    setupBrowseMultiButton("browse-file-btn", importInput, false);
    setupBrowseMultiButton("browse-folder-btn", importInput, true);
  }

  dismissBtn?.addEventListener("click", () => {
    stopScanProgressPolling();
    if (importProgressTimer) {
      clearInterval(importProgressTimer);
      importProgressTimer = null;
    }
    const panel = document.getElementById("import-progress-panel");
    if (panel) panel.style.display = "none";
    if (importMsg) importMsg.textContent = "";
    if (dismissBtn) dismissBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "none";
  });

  cancelBtn?.addEventListener("click", async () => {
    if (!cancelBtn) return;
    cancelBtn.disabled = true;
    cancelBtn.innerHTML = `<i class="bi bi-hourglass-split"></i> Cancelling...`;
    try {
      const resp = await typedCall("ImportService.CancelImport", null, null, CancelImportResultSchema);
      if (resp.success) {
        if (importMsg) setStatusMessage(importMsg, "Cancelling import operation...", "loading");
      }
    } catch (e) {
      console.error("Failed to cancel import:", e);
    }
  });

  importForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!importInput || !importMsg) return;

    const rawValue = importInput.value;
    const paths = rawValue
      .split(/[\r\n;]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (paths.length === 0) {
      setStatusMessage(importMsg, "Please specify at least one valid path.", "error");
      return;
    }

    setStatusMessage(importMsg, `Starting import scan for ${paths.length} path(s)...`, "loading");

    const panel = document.getElementById("import-progress-panel");
    const title = document.getElementById("import-progress-title");
    const percent = document.getElementById("import-progress-percent");
    const bar = document.getElementById("import-progress-bar");
    const indexedCount = document.getElementById("import-indexed-count");
    const pendingCount = document.getElementById("import-pending-count");
    const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
    const dismissBtn = document.getElementById("import-dismiss-btn") as HTMLButtonElement | null;

    if (panel) panel.style.display = "block";
    if (title) title.textContent = "Scanning directories...";
    if (bar) bar.style.width = "0%";
    if (percent) percent.textContent = "0%";
    if (indexedCount) indexedCount.textContent = "Discovering files...";
    if (pendingCount) pendingCount.textContent = "Queuing jobs...";
    if (dismissBtn) dismissBtn.style.display = "none";
    if (cancelBtn) {
      cancelBtn.style.display = "inline-flex";
      cancelBtn.disabled = false;
      cancelBtn.innerHTML = `<i class="bi bi-x-circle"></i> Cancel`;
    }

    startScanProgressPolling();

    try {
      const resp = await typedCall(
        "ImportService.ImportImage",
        ImportImageRequestSchema,
        { paths, path: paths[0] || "" },
        ImportResultSchema
      );
      stopScanProgressPolling();

      const { importedCount, folderId, folderIds } = resp;
      const targetFolderIds = folderIds && folderIds.length > 0 ? folderIds.map(Number) : (folderId ? [Number(folderId)] : []);

      if (importedCount && targetFolderIds.length > 0) {
        setStatusMessage(importMsg, `Import completed! Queued ${importedCount} image(s) across ${targetFolderIds.length} folder(s) for indexing...`, "loading");
        startImportProgressPolling(targetFolderIds, importedCount);
      } else {
        if (cancelBtn) cancelBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "inline-flex";
        setStatusMessage(importMsg, "Import completed.", "success");
      }
      importInput.value = "";
      importInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e: any) {
      stopScanProgressPolling();
      if (cancelBtn) cancelBtn.style.display = "none";
      if (dismissBtn) dismissBtn.style.display = "inline-flex";
      const errStr = e?.message || String(e);
      if (errStr.includes("cancelled")) {
        setStatusMessage(importMsg, "Import was cancelled by user.", "error");
        if (title) title.textContent = "Import Cancelled";
        if (bar) bar.style.width = "0%";
        if (percent) percent.textContent = "Cancelled";
      } else {
        setStatusMessage(importMsg, `Import Error: ${errStr}`, "error");
      }
    }
  });

  // Check if an import is already in flight when opening
  checkActiveImportState();
}

async function checkActiveImportState() {
  try {
    const prog = await typedCall("ImportService.GetImportProgress", null, null, ImportProgressSchema);
    if (prog.running) {
      const panel = document.getElementById("import-progress-panel");
      const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
      if (panel) panel.style.display = "block";
      if (cancelBtn) {
        cancelBtn.style.display = "inline-flex";
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `<i class="bi bi-x-circle"></i> Cancel`;
      }
      startScanProgressPolling();
    }
  } catch (_) {}
}

function startScanProgressPolling() {
  if (scanProgressTimer) clearInterval(scanProgressTimer);

  const title = document.getElementById("import-progress-title");
  const percent = document.getElementById("import-progress-percent");
  const bar = document.getElementById("import-progress-bar");
  const indexedCount = document.getElementById("import-indexed-count");
  const pendingCount = document.getElementById("import-pending-count");
  const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("import-dismiss-btn") as HTMLButtonElement | null;

  scanProgressTimer = setInterval(async () => {
    try {
      const prog = await typedCall("ImportService.GetImportProgress", null, null, ImportProgressSchema);
      if (!prog.running && prog.phase === "idle") return;

      const phase = prog.phase;
      const discovered = Number(prog.discoveredFiles);
      const processed = Number(prog.processedFiles);
      const total = Number(prog.totalFiles);

      if (phase === "discovering") {
        if (title) title.textContent = "Discovering supported media files...";
        if (percent) percent.textContent = `${discovered} found`;
        if (bar) bar.style.width = "15%";
        if (indexedCount) indexedCount.textContent = `Files found: ${discovered}`;
        if (pendingCount) pendingCount.textContent = "Scanning directories...";
      } else if (phase === "extracting") {
        const pct = total > 0 ? Math.min(90, Math.round((processed / total) * 90)) : 0;
        if (title) title.textContent = `Extracting metadata & hashing (${processed} / ${total})...`;
        if (percent) percent.textContent = `${Math.round((processed / Math.max(1, total)) * 100)}%`;
        if (bar) bar.style.width = `${pct}%`;
        if (indexedCount) indexedCount.textContent = `Processed: ${processed} / ${total}`;
        if (pendingCount) pendingCount.textContent = "Extracting media info...";
      } else if (phase === "writing_db") {
        if (title) title.textContent = `Saving records to library (${processed} / ${total})...`;
        if (percent) percent.textContent = "95%";
        if (bar) bar.style.width = "95%";
        if (indexedCount) indexedCount.textContent = `Saved: ${processed} / ${total}`;
        if (pendingCount) pendingCount.textContent = "Writing to database...";
      } else if (phase === "cancelled") {
        if (title) title.textContent = "Cancelling import...";
        if (percent) percent.textContent = "Cancelled";
        if (cancelBtn) cancelBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "inline-flex";
      } else if (phase === "complete" || phase === "failed") {
        if (cancelBtn) cancelBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "inline-flex";
      }
    } catch (_) {}
  }, 200);
}

function stopScanProgressPolling() {
  if (scanProgressTimer) {
    clearInterval(scanProgressTimer);
    scanProgressTimer = null;
  }
}

function startImportProgressPolling(targetFolderIds: number[], expectedBatchCount: number) {
  const panel = document.getElementById("import-progress-panel");
  const title = document.getElementById("import-progress-title");
  const percent = document.getElementById("import-progress-percent");
  const bar = document.getElementById("import-progress-bar");
  const indexedCount = document.getElementById("import-indexed-count");
  const pendingCount = document.getElementById("import-pending-count");
  const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("import-dismiss-btn") as HTMLButtonElement | null;
  const statusMsg = document.getElementById("import-status-msg");

  if (cancelBtn) cancelBtn.style.display = "none";
  if (dismissBtn) dismissBtn.style.display = "none";
  if (!panel || !bar || !percent) return;
  panel.style.display = "block";
  if (title) title.textContent = `Processing Vector Indexing (${expectedBatchCount} images)...`;
  bar.style.width = "0%";
  percent.textContent = "0%";
  if (indexedCount) indexedCount.textContent = `Indexed Vectors: 0 / Total Images: ${expectedBatchCount}`;
  if (pendingCount) pendingCount.textContent = `Pending Jobs: ${expectedBatchCount}`;

  if (importProgressTimer) clearInterval(importProgressTimer);

  importProgressTimer = setInterval(async () => {
    try {
      const foldersResp = await typedCall("ImportService.GetImportedFolders", null, null, ImportedFoldersResultSchema);
      const statusResp = await typedCall("SystemService.GetStatus", null, null, StatusResultSchema);

      const pendingWorkerJobs = Number(statusResp.pendingJobs) + Number(statusResp.preprocessingJobs);
      const targetFolders = foldersResp.folders
        .map(folderDetailsFromProto)
        .filter((f) => targetFolderIds.includes(f.id));

      if (targetFolders.length > 0) {
        const total = targetFolders.reduce((acc, f) => acc + f.image_count, 0) || expectedBatchCount;
        const ready = targetFolders.reduce((acc, f) => acc + f.vector_ready, 0);

        if (indexedCount) indexedCount.textContent = `Indexed Vectors: ${ready} / Total Images: ${total}`;
        if (pendingCount) pendingCount.textContent = `Pending Jobs: ${pendingWorkerJobs}`;

        if (total > 0) {
          const pct = Math.min(100, Math.round((ready / total) * 100));
          bar.style.width = `${pct}%`;
          percent.textContent = `${pct}%`;

          if (ready >= total && pendingWorkerJobs === 0) {
            bar.style.width = "100%";
            percent.textContent = "100%";
            if (title) title.textContent = "✓ Import & Vector Indexing Complete!";
            if (statusMsg) setStatusMessage(statusMsg, `Successfully imported and indexed all ${total} images across ${targetFolders.length} folder(s)!`, "success");
            if (dismissBtn) dismissBtn.style.display = "inline-flex";
            clearInterval(importProgressTimer);
            importProgressTimer = null;
            refreshDashboard();
            refreshGallery();
          }
        }
      }
    } catch (_) {}
  }, 400);
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderImportHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title"><i class="bi bi-box-arrow-in-down"></i> Import Images / Folders</div>
      <form id="import-form">
        <div class="form-group">
          <div class="input-wrapper" style="flex: 1; min-width: 250px;">
            <input class="input-field has-clear" id="import-path-input" placeholder="Enter file or folder path(s) (e.g. C:\\Photos; D:\\Art)..." style="width: 100%;" required />
            <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
          </div>
          <button type="button" class="win-button" id="browse-file-btn"><i class="bi bi-file-earmark"></i> Files...</button>
          <button type="button" class="win-button" id="browse-folder-btn"><i class="bi bi-folder"></i> Folders...</button>
          <button type="submit" class="win-button primary" id="start-import-btn"><i class="bi bi-download"></i> Start Import</button>
        </div>
      </form>

      <div id="import-progress-panel" style="display: none; margin-top: 16px; padding: 14px; background: var(--sys-menu-bg); border: 1px solid var(--sys-menu-border); border-radius: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span id="import-progress-title" style="font-weight: 600; font-size: 13px;">Processing Import...</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button type="button" class="win-button" id="import-cancel-btn" style="display: none; font-size: 11px; padding: 2px 8px; color: #a80000;" title="Cancel ongoing import">
              <i class="bi bi-x-circle"></i> Cancel
            </button>
            <button type="button" class="win-button" id="import-dismiss-btn" style="display: none; font-size: 11px; padding: 2px 8px;" title="Clear progress display">
              <i class="bi bi-x-lg"></i> Clear
            </button>
            <span id="import-progress-percent" style="font-weight: 700; color: var(--sys-border-focus); font-size: 13px;">0%</span>
          </div>
        </div>
        <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden; margin-bottom: 10px;">
          <div id="import-progress-bar" style="width: 0%; height: 100%; background-color: var(--sys-primary, #0078d4); transition: width 0.3s ease;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--sys-text-subtle);">
          <span id="import-indexed-count">Files: 0 / 0</span>
          <span id="import-pending-count">Pending Jobs: 0</span>
        </div>
      </div>
      <p style="font-size: 11px; color: #555555; margin-top: 10px;" id="import-status-msg"></p>
    </div>
  `;
}



