import { invoke } from "@tauri-apps/api/core";
import { typedCall } from "../ipc";
import { logJS, escapeHtml, formatDate } from "../utils";
import { maskPath, SafeHtml, html } from "../components";
import { folderDetailsFromProto, duplicateFolderInfoFromProto } from "../proto-adapters";
import {
  RescanFolderRequestSchema,
  RescanFolderResultSchema,
  IndexFolderRequestSchema,
  IndexFolderResultSchema,
  ImportedFoldersResultSchema,
  ClassifyFolderSafetyRequestSchema,
  ClassifyFolderSafetyResultSchema,
} from "../gen/import_pb";
import {
  UpdateFolderPathRequestSchema,
  UpdateFolderPathResultSchema,
  DeleteFolderRequestSchema,
  DeleteFolderResultSchema,
  DuplicateFoldersResultSchema,
  MergeFoldersRequestSchema,
  MergeFoldersResultSchema,
} from "../gen/folders_pb";
import type { DuplicateFolderGroup as PDuplicateFolderGroup } from "../gen/common_pb";
import type { DuplicateFolderGroup, FolderDetails } from "../types";

let duplicateGroups: DuplicateFolderGroup[] = [];

function duplicateFolderGroupFromProto(g: PDuplicateFolderGroup): DuplicateFolderGroup {
  return {
    folders: g.folders.map(duplicateFolderInfoFromProto),
    shared_image_count: Number(g.sharedImageCount),
  };
}

function folderRowHtml(folder: FolderDetails): string {
  const totalVectors = folder.vector_ready + folder.vector_pending;
  const vectorText =
    totalVectors > 0
      ? `<span style="color: #2e7d32;">${folder.vector_ready}</span> / ${totalVectors}`
      : '<span style="color: #999;">0</span>';

  // Media with no vector row yet (not ready, not pending/preprocessing, and
  // excluding files missing from disk) still needs indexing.
  const totalMedia = folder.image_count + folder.video_count;
  const needsIndexCount = Math.max(
    0,
    totalMedia -
      folder.vector_ready -
      folder.vector_pending -
      folder.missing_image_count -
      folder.missing_video_count,
  );

  const safetyText =
    totalMedia > 0
      ? `<span style="color: #2e7d32;">${folder.safety_classified}</span> / ${totalMedia}`
      : '<span style="color: #999;">0</span>';
  const safetyPending = folder.safety_pending;

  const statusIcon = folder.is_missing
    ? '<i class="bi bi-exclamation-triangle" style="color: #e8912d;" title="Folder missing from disk"></i>'
    : folder.missing_image_count > 0 || folder.missing_video_count > 0
      ? `<i class="bi bi-exclamation-circle" style="color: #e8912d;" title="${folder.missing_image_count + folder.missing_video_count} missing file(s)"></i>`
      : '<i class="bi bi-check-circle" style="color: #2e7d32;" title="Folder exists"></i>';

  let rowClass = folder.is_missing ? "folders-row missing" : "folders-row";
  if (needsIndexCount > 0) rowClass += " needs-index";

  let html = `<tr class="${rowClass}" data-folder-id="${folder.id}" data-folder-path="${escapeHtml(folder.path)}">
    <td style="text-align: center;">${statusIcon}</td>
    <td style="font-weight: 600;">${escapeHtml(folder.name)}</td>
    <td style="font-size: 11px; color: #555; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(folder.path)}">${maskPath(folder.path)}</td>
    <td style="white-space: nowrap;"><div style="display: flex; justify-content: flex-end; align-items: center;">${folder.image_count}<i class="bi bi-image" style="color: #1a7f37; margin-left: 4px; font-size: 11px;" title="Image files"></i><span style="display: inline-block; width: 34px; text-align: left; font-size: 10px; color: #e8912d; margin-left: 4px;" title="${folder.missing_image_count} missing">${folder.missing_image_count > 0 ? `(-${folder.missing_image_count})` : ""}</span></div></td>
    <td style="white-space: nowrap;"><div style="display: flex; justify-content: flex-end; align-items: center;">${folder.video_count}<i class="bi bi-film" style="color: #6a3fa0; margin-left: 4px; font-size: 11px;" title="Video files (mp4/webm)"></i><span style="display: inline-block; width: 34px; text-align: left; font-size: 10px; color: #e8912d; margin-left: 4px;" title="${folder.missing_video_count} missing">${folder.missing_video_count > 0 ? `(-${folder.missing_video_count})` : ""}</span></div></td>
    <td style="text-align: right;">${vectorText}${needsIndexCount > 0 ? ` <span style="color: #e8912d; font-size: 10px; font-weight: 600;" title="Media without a vector">(+${needsIndexCount} unindexed)</span>` : ""}</td>
    <td style="text-align: right;">${safetyText}${safetyPending > 0 ? ` <span style="color: #e8912d; font-size: 10px; font-weight: 600;" title="Media without safety classification">(+${safetyPending} unclassified)</span>` : ""}</td>
    <td style="font-size: 11px; color: #555;">${formatDate(folder.imported_at)}</td>
    <td style="text-align: center; white-space: nowrap;">`;

  if (folder.is_missing) {
    html += `
      <button class="win-button folders-update-btn" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px; margin-right: 4px;" title="Update folder path">
        <i class="bi bi-pencil"></i> Update Path
      </button>
      <button class="win-button danger folders-remove-btn" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px;" title="Remove folder record">
        <i class="bi bi-trash"></i> Remove
      </button>`;
  } else {
    html += `
      <button class="win-button folders-open-btn" data-path="${escapeHtml(folder.path)}" style="font-size: 11px; padding: 2px 8px;">
        <i class="bi bi-folder2-open"></i> Open
      </button>
      <button class="win-button folders-rescan-btn" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px; margin-left: 4px;" title="Scan for new images and videos added since import">
        <i class="bi bi-arrow-repeat"></i> Rescan
      </button>
      <button class="win-button folders-index-btn" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px; margin-left: 4px;" title="Queue vector indexing for media without a ready vector">
        <i class="bi bi-cpu"></i> Index
      </button>
      <button class="win-button folders-safety-btn" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px; margin-left: 4px;" title="Classify content safety for unclassified media in this folder">
        <i class="bi bi-shield-check"></i> Safety
      </button>`;
  }

  html += `</td></tr>`;
  return html;
}

function bindFolderActions(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>(".folders-open-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const path = btn.getAttribute("data-path");
      if (path) {
        try {
          await invoke("open_file_externally", { path });
        } catch (err: any) {
          logJS("Failed to open folder: " + (err?.message || String(err)));
        }
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".folders-rescan-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
      if (!folderId) return;

      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="bi bi-arrow-repeat"></i> Scanning...`;
      try {
        const resp = await typedCall(
          "ImportService.RescanFolder",
          RescanFolderRequestSchema,
          { folderId: BigInt(folderId) },
          RescanFolderResultSchema,
        );
        const imported = Number(resp.imported);
        const found = Number(resp.found);
        const msg =
          imported > 0
            ? `Rescan imported ${imported} new media file(s) (${found} supported files found).`
            : `Folder is up to date (${found} supported files found, nothing new).`;
        logJS(msg);
        refreshFolders();
      } catch (err: any) {
        logJS("Rescan error: " + (err?.message || String(err)));
      }
      btn.disabled = false;
      btn.innerHTML = original;
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".folders-index-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
      if (!folderId) return;

      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="bi bi-cpu"></i> Queueing...`;
      try {
        const resp = await typedCall(
          "ImportService.IndexFolder",
          IndexFolderRequestSchema,
          { folderId: BigInt(folderId) },
          IndexFolderResultSchema,
        );
        const queued = Number(resp.queued);
        const msg =
          queued > 0
            ? `Queued ${queued} media file(s) for vector indexing.`
            : "All media in this folder already has a vector.";
        logJS(msg);
        refreshFolders();
      } catch (err: any) {
        logJS("Index error: " + (err?.message || String(err)));
      }
      btn.disabled = false;
      btn.innerHTML = original;
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".folders-safety-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
      if (!folderId) return;

      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="bi bi-shield-shaded"></i> Classifying...`;
      try {
        const resp = await typedCall(
          "ImportService.ClassifyFolderSafety",
          ClassifyFolderSafetyRequestSchema,
          { folderId: BigInt(folderId) },
          ClassifyFolderSafetyResultSchema,
        );
        const processed = Number(resp.processed);
        const msg =
          processed > 0
            ? `Classified content safety for ${processed} media file(s) in this folder.`
            : "All media in this folder is already classified.";
        logJS(msg);
        refreshFolders();
      } catch (err: any) {
        logJS("Safety classification error: " + (err?.message || String(err)));
      }
      btn.disabled = false;
      btn.innerHTML = original;
    });
  });

  container.querySelectorAll<HTMLElement>(".folders-update-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
      if (!folderId) return;

      try {
        const selected: string | null = await invoke("select_path", { isDirectory: true });
        if (selected) {
          const updateResp = await typedCall(
            "FoldersService.UpdateFolderPath",
            UpdateFolderPathRequestSchema,
            { id: BigInt(folderId), newPath: selected },
            UpdateFolderPathResultSchema,
          );
          if (updateResp.success) {
            logJS("Folder path updated successfully");
            refreshFolders();
          }
        }
      } catch (err: any) {
        logJS("Failed to update folder path: " + (err?.message || String(err)));
      }
    });
  });

  container.querySelectorAll<HTMLElement>(".folders-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
      if (!folderId) return;

      if (!confirm("Remove this folder record? Images will not be deleted.")) return;

      try {
        const deleteResp = await typedCall(
          "FoldersService.DeleteFolder",
          DeleteFolderRequestSchema,
          { id: BigInt(folderId) },
          DeleteFolderResultSchema,
        );
        if (deleteResp.success) {
          logJS("Folder record removed");
          refreshFolders();
        }
      } catch (err: any) {
        logJS("Failed to remove folder: " + (err?.message || String(err)));
      }
    });
  });
}

export async function refreshFolders() {
  const container = document.getElementById("folders-content");
  if (!container) return;

  const existingTable = container.querySelector<HTMLTableElement>(".folders-table");
  const firstLoad = !existingTable;

  if (firstLoad) {
    container.innerHTML = '<p style="color: #666; font-style: italic;">Loading folders...</p>';
  }

  try {
    const resp = await typedCall(
      "ImportService.GetImportedFolders",
      null,
      null,
      ImportedFoldersResultSchema,
    );
    const folders = resp.folders.map(folderDetailsFromProto);
    if (folders.length === 0) {
      container.innerHTML =
        '<p style="color: #999; font-style: italic;">No folders imported yet. Use Import Images to add folders.</p>';
      return;
    }

    const rowsHtml = folders.map(folderRowHtml).join("");

    if (firstLoad) {
      container.innerHTML = `
        <div style="margin-bottom: 8px; display: flex; gap: 6px;">
          <button class="win-button" id="folders-reconcile-btn" style="font-size: 11px; padding: 3px 10px;">
            <i class="bi bi-arrow-left-right"></i> Reconcile Duplicates
          </button>
        </div>
        <table class="folders-table">
          <thead>
            <tr>
              <th style="text-align: left;">Status</th>
              <th style="text-align: left;">Folder Name</th>
              <th style="text-align: left;">Path</th>
              <th style="text-align: right; padding-right: 54px;">Images</th>
              <th style="text-align: right; padding-right: 54px;">Videos</th>
              <th style="text-align: right;">Vectors</th>
              <th style="text-align: right;">Safety</th>
              <th style="text-align: left;">Imported</th>

              <th style="text-align: center;">Actions</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div id="folders-reconcile-panel" style="display: none; margin-top: 12px;"></div>`;

      document
        .getElementById("folders-reconcile-btn")
        ?.addEventListener("click", handleReconcileClick);
    } else {
      // In-place refresh: keep header and reconcile panel, only swap the rows.
      const tbody = existingTable!.querySelector<HTMLTableSectionElement>("tbody");
      if (tbody) tbody.innerHTML = rowsHtml;
    }

    bindFolderActions(container);
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}

async function handleReconcileClick() {
  const panel = document.getElementById("folders-reconcile-panel");
  if (!panel) return;

  panel.style.display = "block";
  panel.innerHTML =
    '<p style="color: #666; font-style: italic;">Scanning for duplicate folders...</p>';

  try {
    const resp = await typedCall(
      "FoldersService.DetectDuplicateFolders",
      null,
      null,
      DuplicateFoldersResultSchema,
    );
    duplicateGroups = resp.groups.map(duplicateFolderGroupFromProto);

    if (duplicateGroups.length === 0) {
      panel.innerHTML = `
        <div class="group-box">
          <div class="group-box-title"><i class="bi bi-check-circle"></i> No Duplicates Found</div>
          <p style="color: #666; font-size: 12px;">All imported folders contain unique images.</p>
        </div>`;
      return;
    }

    let reconcileContent = `
      <div class="group-box">
        <div class="group-box-title"><i class="bi bi-arrow-left-right"></i> Duplicate Folders Detected</div>
        <p style="color: #555; font-size: 12px; margin: 0 0 10px 0;">
          Found ${duplicateGroups.length} group(s) of folders sharing images by SHA-256.
          Choose which folder to keep in each group — the others will be merged into it.
        </p>`;

    for (let gi = 0; gi < duplicateGroups.length; gi++) {
      const group = duplicateGroups[gi];
      reconcileContent += `
        <div style="border: 1px solid #d0d0d0; border-radius: 3px; padding: 8px; margin-bottom: 8px; background: #fafafa;">
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px; color: #333;">
            Group ${gi + 1} — ${group.shared_image_count} shared image(s)
          </div>`;

      for (const folder of group.folders) {
        reconcileContent += `
          <div style="display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid #e8e8e8;">
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 600; font-size: 12px;">${escapeHtml(folder.name)}</div>
              <div style="font-size: 11px; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(folder.path)}">${maskPath(folder.path)}</div>
            </div>
            <div style="font-size: 11px; color: #666; white-space: nowrap;">
              ${folder.image_count} images
            </div>
            <button class="win-button folders-merge-keep-btn" data-group="${gi}" data-folder-id="${folder.id}" style="font-size: 11px; padding: 2px 8px; white-space: nowrap;">
              <i class="bi bi-check-lg"></i> Keep
            </button>
          </div>`;
      }

      reconcileContent += `</div>`;
    }

    reconcileContent += `</div>`;
    panel.innerHTML = reconcileContent;

    // Attach merge handlers
    panel.querySelectorAll<HTMLElement>(".folders-merge-keep-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupIdx = parseInt(btn.getAttribute("data-group") || "0");
        const keepId = parseInt(btn.getAttribute("data-folder-id") || "0");
        if (!keepId) return;

        const group = duplicateGroups[groupIdx];
        const mergeIds = group.folders.filter((f) => f.id !== keepId).map((f) => f.id);

        if (mergeIds.length === 0) return;

        const keepFolder = group.folders.find((f) => f.id === keepId);
        const msg = `Keep "${keepFolder?.name}" and merge ${mergeIds.length} other folder(s) into it?\n\nThe other folder records will be deleted. Images will be reassigned.`;
        if (!confirm(msg)) return;

        let moved = 0;
        for (const mergeId of mergeIds) {
          try {
            const mergeResp = await typedCall(
              "FoldersService.MergeFolders",
              MergeFoldersRequestSchema,
              { keepFolderId: BigInt(keepId), mergeFolderId: BigInt(mergeId) },
              MergeFoldersResultSchema,
            );
            if (mergeResp.success) {
              moved += Number(mergeResp.imagesMoved);
            }
          } catch (err: any) {
            logJS("Merge error: " + (err?.message || String(err)));
          }
        }

        logJS(`Merged ${mergeIds.length} folder(s): ${moved} images reassigned`);
        refreshFolders();
      });
    });
  } catch (e: any) {
    panel.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderFoldersHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">Imported Folders</div>
      <div id="folders-content">
        <p style="color: #666; font-style: italic;">Loading folders...</p>
      </div>
    </div>
  `;
}
