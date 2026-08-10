import { typedCall } from "../ipc";
import { folderDetailsFromProto } from "../proto-adapters";
import { ImportImageRequestSchema, ImportResultSchema, ImportedFoldersResultSchema } from "../gen/import_pb";
import { StatusResultSchema } from "../gen/system_pb";
import { SafeHtml, html } from "../components";
import { setStatusMessage } from "../utils";
import { setupBrowseButton } from "../cards";
import { refreshDashboard } from "./dashboard";
import { refreshGallery } from "./gallery";

let importProgressTimer: any = null;

export function setupImport() {
  const importForm = document.getElementById("import-form");
  const importInput = document.getElementById("import-path-input") as HTMLInputElement;
  const importMsg = document.getElementById("import-status-msg");

  if (importInput) {
    setupBrowseButton("browse-file-btn", importInput, false);
    setupBrowseButton("browse-folder-btn", importInput, true);
  }

  importForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!importInput || !importMsg) return;

    setStatusMessage(importMsg, "Scanning directory & queuing import jobs...", "loading");

    const panel = document.getElementById("import-progress-panel");
    const title = document.getElementById("import-progress-title");
    const percent = document.getElementById("import-progress-percent");
    const bar = document.getElementById("import-progress-bar");
    const indexedCount = document.getElementById("import-indexed-count");
    const pendingCount = document.getElementById("import-pending-count");

    if (panel) panel.style.display = "block";
    if (title) title.textContent = "Scanning Directory & Queuing Import Jobs...";
    if (bar) bar.style.width = "0%";
    if (percent) percent.textContent = "0%";
    if (indexedCount) indexedCount.textContent = "Scanning folder...";
    if (pendingCount) pendingCount.textContent = "Queuing jobs...";

    try {
      const resp = await typedCall("ImportService.ImportImage", ImportImageRequestSchema, { path: importInput.value }, ImportResultSchema);
      const { importedCount, folderId } = resp;
      if (folderId && importedCount) {
        setStatusMessage(importMsg, `Started import! Processing ${importedCount} image(s)...`, "loading");
        startImportProgressPolling(Number(folderId), importedCount);
      }
      importInput.value = "";
      importInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      setStatusMessage(importMsg, `IPC Error: ${e}`, "error");
      if (panel) panel.style.display = "none";
    }
  });
}

function startImportProgressPolling(targetFolderId: number, expectedBatchCount: number) {
  const panel = document.getElementById("import-progress-panel");
  const title = document.getElementById("import-progress-title");
  const percent = document.getElementById("import-progress-percent");
  const bar = document.getElementById("import-progress-bar");
  const indexedCount = document.getElementById("import-indexed-count");
  const pendingCount = document.getElementById("import-pending-count");
  const statusMsg = document.getElementById("import-status-msg");

  if (!panel || !bar || !percent) return;
  panel.style.display = "block";
  if (title) title.textContent = `Processing Import & Vector Indexing (${expectedBatchCount} images)...`;
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
      const folder = foldersResp.folders.map(folderDetailsFromProto).find((f) => f.id === targetFolderId);
      if (folder) {
        const total = folder.image_count || expectedBatchCount;
        const ready = folder.vector_ready;

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
            if (statusMsg) setStatusMessage(statusMsg, `Successfully imported and indexed all ${total} images!`, "success");
            clearInterval(importProgressTimer);
            importProgressTimer = null;
            refreshDashboard();
            refreshGallery();
          }
        }
      }
    } catch (e) {
      console.error("Error polling import progress", e);
    }
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
            <input class="input-field has-clear" id="import-path-input" placeholder="Enter file or folder path (e.g. C:\\Photos)..." style="width: 100%;" required />
            <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
          </div>
          <button type="button" class="win-button" id="browse-file-btn"><i class="bi bi-file-earmark"></i> File...</button>
          <button type="button" class="win-button" id="browse-folder-btn"><i class="bi bi-folder"></i> Folder...</button>
          <button type="submit" class="win-button primary" id="start-import-btn"><i class="bi bi-download"></i> Start Import</button>
        </div>
      </form>

      <div id="import-progress-panel" style="display: none; margin-top: 16px; padding: 14px; background: var(--sys-menu-bg); border: 1px solid var(--sys-menu-border); border-radius: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span id="import-progress-title" style="font-weight: 600; font-size: 13px;">Processing Import &amp; Vector Indexing...</span>
          <span id="import-progress-percent" style="font-weight: 700; color: var(--sys-border-focus); font-size: 13px;">0%</span>
        </div>
        <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden; margin-bottom: 10px;">
          <div id="import-progress-bar" style="width: 0%; height: 100%; background-color: var(--sys-primary, #0078d4); transition: width 0.3s ease;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--sys-text-subtle);">
          <span id="import-indexed-count">Indexed: 0 / 0</span>
          <span id="import-pending-count">Pending Jobs: 0</span>
        </div>
      </div>
      <p style="font-size: 11px; color: #555555; margin-top: 10px;" id="import-status-msg"></p>
    </div>
  `;
}
