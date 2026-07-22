import { callService } from "../ipc";
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
      const resp = await callService({ ImportImage: { path: importInput.value } });
      if ("ImportResult" in resp) {
        const { imported_count, folder_id } = resp.ImportResult;
        if (folder_id && imported_count) {
          setStatusMessage(importMsg, `Started import! Processing ${imported_count} image(s)...`, "loading");
          startImportProgressPolling(folder_id, imported_count);
        }
        importInput.value = "";
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else if ("Error" in resp) {
        setStatusMessage(importMsg, `Error: ${resp.Error.message}`, "error");
        if (panel) panel.style.display = "none";
      }
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
      const foldersResp = await callService({ GetImportedFolders: null });
      const statusResp = await callService({ GetStatus: null });

      let pendingWorkerJobs = 0;
      if ("StatusResult" in statusResp) {
        pendingWorkerJobs = statusResp.StatusResult.pending_jobs + statusResp.StatusResult.preprocessing_jobs;
      }

      if ("ImportedFoldersResult" in foldersResp) {
        const folder = foldersResp.ImportedFoldersResult.folders.find((f: any) => f.id === targetFolderId);
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
      }
    } catch (e) {
      console.error("Error polling import progress", e);
    }
  }, 400);
}
