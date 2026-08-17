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
import { setStatusMessage, escapeHtml } from "../utils";
import { invoke } from "@tauri-apps/api/core";
import { refreshDashboard } from "./dashboard";
import { refreshGallery } from "./gallery";

let importProgressTimer: any = null;
let scanProgressTimer: any = null;
let stagedPaths: string[] = [];

/**
 * Safely parse multi-line or semicolon-delimited paths while preserving spaces
 * and stripping surrounding double/single quotes.
 */
export function parseImportPaths(raw: string): string[] {
  if (!raw || !raw.trim()) return [];

  const results: string[] = [];
  const lines = raw.split(/[\r\n]+/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Handle semicolon separation if present
    const parts = trimmed.split(";");
    for (let part of parts) {
      part = part.trim();
      // Remove enclosing quotes if user copied as "C:\My Photos\Folder"
      if (
        (part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'"))
      ) {
        part = part.slice(1, -1).trim();
      }
      if (part.length > 0 && !results.includes(part)) {
        results.push(part);
      }
    }
  }
  return results;
}

function getPathBasename(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : p;
}

function isLikelyFile(p: string): boolean {
  return /\.(png|jpe?g|webp|bmp|gif|tiff?|mp4|webm)$/i.test(p);
}

function renderStagedTable() {
  const container = document.getElementById("import-staged-container");
  const countEl = document.getElementById("import-staged-count");
  const listEl = document.getElementById("import-staged-list");
  const startBtn = document.getElementById("start-import-btn") as HTMLButtonElement | null;

  if (!container || !listEl || !countEl) return;

  if (stagedPaths.length === 0) {
    container.style.display = "none";
    if (startBtn) {
      startBtn.innerHTML = `<i class="bi bi-download"></i> Start Import`;
      startBtn.disabled = true;
    }
    return;
  }

  container.style.display = "block";
  countEl.textContent = `${stagedPaths.length} item(s) staged for import`;

  if (startBtn) {
    startBtn.innerHTML = `<i class="bi bi-download"></i> Start Import (${stagedPaths.length} items)`;
    startBtn.disabled = false;
  }

  listEl.innerHTML = stagedPaths
    .map((p, idx) => {
      const isFile = isLikelyFile(p);
      const icon = isFile
        ? `<i class="bi bi-file-earmark-image" style="color: var(--sys-primary, #0078d4); font-size: 15px;"></i>`
        : `<i class="bi bi-folder-fill" style="color: var(--sys-warning, #d89b00); font-size: 15px;"></i>`;
      const basename = escapeHtml(getPathBasename(p));
      const fullPath = escapeHtml(p);

      return `
        <div class="staged-path-row" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--sys-border-subtle, rgba(0,0,0,0.06)); background: var(--sys-window-bg); gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; min-width: 0; flex: 1;">
            ${icon}
            <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;" title="${fullPath}">
              <span style="font-weight: 600; font-size: 12px; color: var(--sys-control-text);">${basename}</span>
              <span style="font-size: 11px; color: var(--sys-text-subtle); margin-left: 6px;">${fullPath}</span>
            </div>
          </div>
          <button type="button" class="win-button danger btn-remove-staged" data-index="${idx}" style="padding: 2px 6px; height: 22px; font-size: 11px;" title="Remove path">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      `;
    })
    .join("");
}

export function setupImport() {
  const importForm = document.getElementById("import-form");
  const importInput = document.getElementById("import-path-input") as HTMLInputElement;
  const importMsg = document.getElementById("import-status-msg");
  const cancelBtn = document.getElementById("import-cancel-btn") as HTMLButtonElement | null;
  const dismissBtn = document.getElementById("import-dismiss-btn") as HTMLButtonElement | null;
  const clearStagedBtn = document.getElementById("clear-staged-btn");
  const addPathBtn = document.getElementById("add-path-btn");
  const listEl = document.getElementById("import-staged-list");

  // Browse multiple files
  document.getElementById("browse-file-btn")?.addEventListener("click", async () => {
    try {
      const selected: string[] = await invoke("select_paths", { isDirectory: false });
      if (selected && selected.length > 0) {
        for (const p of selected) {
          if (!stagedPaths.includes(p)) stagedPaths.push(p);
        }
        renderStagedTable();
        if (importInput) importInput.value = "";
      }
    } catch (err) {
      console.error("Files dialog error:", err);
    }
  });

  // Browse multiple folders
  document.getElementById("browse-folder-btn")?.addEventListener("click", async () => {
    try {
      const selected: string[] = await invoke("select_paths", { isDirectory: true });
      if (selected && selected.length > 0) {
        for (const p of selected) {
          if (!stagedPaths.includes(p)) stagedPaths.push(p);
        }
        renderStagedTable();
        if (importInput) importInput.value = "";
      }
    } catch (err) {
      console.error("Folders dialog error:", err);
    }
  });

  // Add path manually or on Enter
  const addCurrentInputToStaged = () => {
    if (!importInput || !importInput.value.trim()) return;
    const parsed = parseImportPaths(importInput.value);
    for (const p of parsed) {
      if (!stagedPaths.includes(p)) stagedPaths.push(p);
    }
    importInput.value = "";
    renderStagedTable();
  };

  addPathBtn?.addEventListener("click", addCurrentInputToStaged);

  importInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCurrentInputToStaged();
    }
  });

  // On paste, automatically stage if multi-line or delimited
  importInput?.addEventListener("paste", () => {
    setTimeout(() => {
      if (importInput.value.includes("\n") || importInput.value.includes(";")) {
        addCurrentInputToStaged();
      }
    }, 50);
  });

  // Remove individual staged path delegation
  listEl?.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest(
      ".btn-remove-staged",
    ) as HTMLButtonElement | null;
    if (target && target.dataset.index !== undefined) {
      const idx = parseInt(target.dataset.index, 10);
      if (!isNaN(idx) && idx >= 0 && idx < stagedPaths.length) {
        stagedPaths.splice(idx, 1);
        renderStagedTable();
      }
    }
  });

  // Clear all staged paths
  clearStagedBtn?.addEventListener("click", () => {
    stagedPaths = [];
    renderStagedTable();
  });

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
      const resp = await typedCall(
        "ImportService.CancelImport",
        null,
        null,
        CancelImportResultSchema,
      );
      if (resp.success) {
        if (importMsg) setStatusMessage(importMsg, "Cancelling import operation...", "loading");
      }
    } catch (e) {
      console.error("Failed to cancel import:", e);
    }
  });

  importForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!importMsg) return;

    // Collect any unsaved text in input
    if (importInput && importInput.value.trim()) {
      const parsed = parseImportPaths(importInput.value);
      for (const p of parsed) {
        if (!stagedPaths.includes(p)) stagedPaths.push(p);
      }
      importInput.value = "";
      renderStagedTable();
    }

    if (stagedPaths.length === 0) {
      setStatusMessage(
        importMsg,
        "Please add at least one folder or file to the import queue.",
        "error",
      );
      return;
    }

    const pathsToImport = [...stagedPaths];
    setStatusMessage(
      importMsg,
      `Starting import scan for ${pathsToImport.length} path(s)...`,
      "loading",
    );

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
        { paths: pathsToImport, path: pathsToImport[0] || "" },
        ImportResultSchema,
      );
      stopScanProgressPolling();

      const { importedCount, folderId, folderIds, warning } = resp;
      const targetFolderIds =
        folderIds && folderIds.length > 0
          ? folderIds.map(Number)
          : folderId
            ? [Number(folderId)]
            : [];

      if (warning) {
        setStatusMessage(importMsg, warning, "error");
        if (cancelBtn) cancelBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "inline-flex";
        const title = document.getElementById("import-progress-title");
        const percent = document.getElementById("import-progress-percent");
        const bar = document.getElementById("import-progress-bar");
        const indexedCount = document.getElementById("import-indexed-count");
        const pendingCount = document.getElementById("import-pending-count");
        if (title) title.textContent = "Import Complete";
        if (bar) bar.style.width = "100%";
        if (percent) percent.textContent = "Done";
        if (indexedCount)
          indexedCount.textContent = `Imported: ${importedCount} image(s)`;
        if (pendingCount)
          pendingCount.textContent = "Vector indexing skipped (models not downloaded)";
        refreshDashboard();
        refreshGallery();
      } else if (importedCount && targetFolderIds.length > 0) {
        setStatusMessage(
          importMsg,
          `Import completed! Queued ${importedCount} image(s) across ${targetFolderIds.length} folder(s) for indexing...`,
          "loading",
        );
        startImportProgressPolling(targetFolderIds, importedCount);
      } else {
        if (cancelBtn) cancelBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "inline-flex";
        setStatusMessage(importMsg, "Import completed.", "success");
      }

      // Clear staged list on successful submission
      stagedPaths = [];
      renderStagedTable();
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

  // Render initial staged table if any
  renderStagedTable();

  // Check if an import is already in flight when opening
  checkActiveImportState();
}

async function checkActiveImportState() {
  try {
    const prog = await typedCall(
      "ImportService.GetImportProgress",
      null,
      null,
      ImportProgressSchema,
    );
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
      const prog = await typedCall(
        "ImportService.GetImportProgress",
        null,
        null,
        ImportProgressSchema,
      );
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
  if (indexedCount)
    indexedCount.textContent = `Indexed Vectors: 0 / Total Images: ${expectedBatchCount}`;
  if (pendingCount) pendingCount.textContent = `Pending Jobs: ${expectedBatchCount}`;

  if (importProgressTimer) clearInterval(importProgressTimer);

  importProgressTimer = setInterval(async () => {
    try {
      const foldersResp = await typedCall(
        "ImportService.GetImportedFolders",
        null,
        null,
        ImportedFoldersResultSchema,
      );
      const statusResp = await typedCall("SystemService.GetStatus", null, null, StatusResultSchema);

      const pendingWorkerJobs =
        Number(statusResp.pendingJobs) + Number(statusResp.preprocessingJobs);
      const targetFolders = foldersResp.folders
        .map(folderDetailsFromProto)
        .filter((f) => targetFolderIds.includes(f.id));

      if (targetFolders.length > 0) {
        const total =
          targetFolders.reduce((acc, f) => acc + f.image_count, 0) || expectedBatchCount;
        const ready = targetFolders.reduce((acc, f) => acc + f.vector_ready, 0);

        if (indexedCount)
          indexedCount.textContent = `Indexed Vectors: ${ready} / Total Images: ${total}`;
        if (pendingCount) pendingCount.textContent = `Pending Jobs: ${pendingWorkerJobs}`;

        if (total > 0) {
          const pct = Math.min(100, Math.round((ready / total) * 100));
          bar.style.width = `${pct}%`;
          percent.textContent = `${pct}%`;

          if (ready >= total && pendingWorkerJobs === 0) {
            bar.style.width = "100%";
            percent.textContent = "100%";
            if (title) title.textContent = "✓ Import & Vector Indexing Complete!";
            if (statusMsg)
              setStatusMessage(
                statusMsg,
                `Successfully imported and indexed all ${total} images across ${targetFolders.length} folder(s)!`,
                "success",
              );
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
      <div class="group-box-title">
        <i class="bi bi-box-arrow-in-down"></i> Import Images &amp; Folders
      </div>
      <form id="import-form">
        <div
          class="form-group"
          style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;"
        >
          <div class="input-wrapper" style="flex: 1; min-width: 250px;">
            <input
              class="input-field has-clear"
              id="import-path-input"
              placeholder="Enter or paste folder/file path(s) (supports spaces &amp; multi-line)..."
              style="width: 100%;"
            />
            <button type="button" class="input-clear-btn" tabindex="-1">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
          <button type="button" class="win-button" id="add-path-btn">
            <i class="bi bi-plus-lg"></i> Add
          </button>
          <button type="button" class="win-button" id="browse-file-btn">
            <i class="bi bi-file-earmark-image"></i> Files...
          </button>
          <button type="button" class="win-button" id="browse-folder-btn">
            <i class="bi bi-folder-fill"></i> Folders...
          </button>
        </div>

        <!-- Staged Import Queue -->
        <div
          id="import-staged-container"
          style="display: none; margin-top: 12px; border: 1px solid var(--sys-border); border-radius: 4px; background: var(--sys-window-bg); overflow: hidden;"
        >
          <div
            style="display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: var(--sys-menu-bg); border-bottom: 1px solid var(--sys-border); font-size: 11px; font-weight: 600;"
          >
            <span id="import-staged-count" style="color: var(--sys-control-text);"
              >0 items staged</span
            >
            <button
              type="button"
              class="win-button danger"
              id="clear-staged-btn"
              style="padding: 1px 6px; height: 20px; font-size: 11px;"
            >
              <i class="bi bi-trash"></i> Clear All
            </button>
          </div>
          <div id="import-staged-list" style="max-height: 220px; overflow-y: auto;"></div>
          <div
            style="padding: 8px 10px; background: var(--sys-menu-bg); border-top: 1px solid var(--sys-border); display: flex; justify-content: flex-end;"
          >
            <button
              type="submit"
              class="win-button primary"
              id="start-import-btn"
              style="font-weight: 600; padding: 4px 14px; height: 26px;"
            >
              <i class="bi bi-download"></i> Start Import
            </button>
          </div>
        </div>
      </form>

      <div
        id="import-progress-panel"
        style="display: none; margin-top: 16px; padding: 14px; background: var(--sys-menu-bg); border: 1px solid var(--sys-menu-border); border-radius: 6px;"
      >
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"
        >
          <span id="import-progress-title" style="font-weight: 600; font-size: 13px;"
            >Processing Import...</span
          >
          <div style="display: flex; align-items: center; gap: 8px;">
            <button
              type="button"
              class="win-button"
              id="import-cancel-btn"
              style="display: none; font-size: 11px; padding: 2px 8px; color: #a80000;"
              title="Cancel ongoing import"
            >
              <i class="bi bi-x-circle"></i> Cancel
            </button>
            <button
              type="button"
              class="win-button"
              id="import-dismiss-btn"
              style="display: none; font-size: 11px; padding: 2px 8px;"
              title="Clear progress display"
            >
              <i class="bi bi-x-lg"></i> Clear
            </button>
            <span
              id="import-progress-percent"
              style="font-weight: 700; color: var(--sys-border-focus); font-size: 13px;"
              >0%</span
            >
          </div>
        </div>
        <div
          style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden; margin-bottom: 10px;"
        >
          <div
            id="import-progress-bar"
            style="width: 0%; height: 100%; background-color: var(--sys-primary, #0078d4); transition: width 0.3s ease;"
          ></div>
        </div>
        <div
          style="display: flex; justify-content: space-between; font-size: 11px; color: var(--sys-text-subtle);"
        >
          <span id="import-indexed-count">Files: 0 / 0</span>
          <span id="import-pending-count">Pending Jobs: 0</span>
        </div>
      </div>
      <p style="font-size: 11px; color: #555555; margin-top: 10px;" id="import-status-msg"></p>
    </div>
  `;
}
