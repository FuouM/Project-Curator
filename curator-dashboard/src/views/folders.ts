import { invoke } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { logJS, escapeHtml, formatDate } from "../utils";
import { maskPath } from "../components";
import type { DuplicateFolderGroup } from "../types";

let duplicateGroups: DuplicateFolderGroup[] = [];

export async function refreshFolders() {
  const container = document.getElementById("folders-content");
  if (!container) return;
  container.innerHTML = '<p style="color: #666; font-style: italic;">Loading folders...</p>';

  try {
    const resp = await callService({ GetImportedFolders: null });
    if (!("ImportedFoldersResult" in resp)) {
      container.innerHTML = '<p style="color: #a80000;">Failed to load folders.</p>';
      return;
    }

    const folders = resp.ImportedFoldersResult.folders;
    if (folders.length === 0) {
      container.innerHTML = '<p style="color: #999; font-style: italic;">No folders imported yet. Use Import Images to add folders.</p>';
      return;
    }

    let html = `<div style="margin-bottom: 8px; display: flex; gap: 6px;">
      <button class="win-button" id="folders-reconcile-btn" style="font-size: 11px; padding: 3px 10px;">
        <i class="bi bi-arrow-left-right"></i> Reconcile Duplicates
      </button>
    </div>`;

    html += `<table class="folders-table">
      <thead>
        <tr>
          <th style="text-align: left;">Status</th>
          <th style="text-align: left;">Folder Name</th>
          <th style="text-align: left;">Path</th>
          <th style="text-align: right;">Images</th>
          <th style="text-align: right;">Vectors</th>
          <th style="text-align: left;">Imported</th>
          <th style="text-align: center;">Actions</th>
        </tr>
      </thead>
      <tbody>`;

    for (const folder of folders) {
      const totalVectors = folder.vector_ready + folder.vector_pending;
      const vectorText = totalVectors > 0
        ? `<span style="color: #2e7d32;">${folder.vector_ready}</span> / ${totalVectors}`
        : '<span style="color: #999;">—</span>';

      const statusIcon = folder.is_missing
        ? '<i class="bi bi-exclamation-triangle" style="color: #e8912d;" title="Folder missing from disk"></i>'
        : '<i class="bi bi-check-circle" style="color: #2e7d32;" title="Folder exists"></i>';

      const rowClass = folder.is_missing ? 'folders-row missing' : 'folders-row';

      html += `<tr class="${rowClass}" data-folder-id="${folder.id}" data-folder-path="${escapeHtml(folder.path)}">
        <td style="text-align: center;">${statusIcon}</td>
        <td style="font-weight: 600;">${escapeHtml(folder.name)}</td>
        <td style="font-size: 11px; color: #555; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(folder.path)}">${maskPath(folder.path)}</td>
        <td style="text-align: right;">${folder.image_count}</td>
        <td style="text-align: right;">${vectorText}</td>
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
          </button>`;
      }

      html += `</td></tr>`;
    }

    html += '</tbody></table>';
    html += '<div id="folders-reconcile-panel" style="display: none; margin-top: 12px;"></div>';
    container.innerHTML = html;

    // Reconcile button
    document.getElementById("folders-reconcile-btn")?.addEventListener("click", handleReconcileClick);

    // Existing button handlers
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

    container.querySelectorAll<HTMLElement>(".folders-update-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const folderId = parseInt(btn.getAttribute("data-folder-id") || "0");
        if (!folderId) return;

        try {
          const selected: string | null = await invoke("select_path", { isDirectory: true });
          if (selected) {
            const updateResp = await callService({ UpdateFolderPath: { id: folderId, new_path: selected } });
            if ("UpdateFolderPathResult" in updateResp && updateResp.UpdateFolderPathResult.success) {
              logJS("Folder path updated successfully");
              refreshFolders();
            } else if ("Error" in updateResp) {
              logJS("Failed to update folder path: " + updateResp.Error.message);
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
          const deleteResp = await callService({ DeleteFolder: { id: folderId } });
          if ("DeleteFolderResult" in deleteResp && deleteResp.DeleteFolderResult.success) {
            logJS("Folder record removed");
            refreshFolders();
          } else if ("Error" in deleteResp) {
            logJS("Failed to remove folder: " + deleteResp.Error.message);
          }
        } catch (err: any) {
          logJS("Failed to remove folder: " + (err?.message || String(err)));
        }
      });
    });
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}

async function handleReconcileClick() {
  const panel = document.getElementById("folders-reconcile-panel");
  if (!panel) return;

  panel.style.display = "block";
  panel.innerHTML = '<p style="color: #666; font-style: italic;">Scanning for duplicate folders...</p>';

  try {
    const resp = await callService({ DetectDuplicateFolders: null });
    if (!("DuplicateFoldersResult" in resp)) {
      panel.innerHTML = '<p style="color: #a80000;">Failed to detect duplicates.</p>';
      return;
    }

    duplicateGroups = resp.DuplicateFoldersResult.groups;

    if (duplicateGroups.length === 0) {
      panel.innerHTML = `
        <div class="group-box">
          <div class="group-box-title"><i class="bi bi-check-circle"></i> No Duplicates Found</div>
          <p style="color: #666; font-size: 12px;">All imported folders contain unique images.</p>
        </div>`;
      return;
    }

    let html = `
      <div class="group-box">
        <div class="group-box-title"><i class="bi bi-arrow-left-right"></i> Duplicate Folders Detected</div>
        <p style="color: #555; font-size: 12px; margin: 0 0 10px 0;">
          Found ${duplicateGroups.length} group(s) of folders sharing images by SHA-256.
          Choose which folder to keep in each group — the others will be merged into it.
        </p>`;

    for (let gi = 0; gi < duplicateGroups.length; gi++) {
      const group = duplicateGroups[gi];
      html += `
        <div style="border: 1px solid #d0d0d0; border-radius: 3px; padding: 8px; margin-bottom: 8px; background: #fafafa;">
          <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px; color: #333;">
            Group ${gi + 1} — ${group.shared_image_count} shared image(s)
          </div>`;

      for (const folder of group.folders) {
        html += `
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

      html += `</div>`;
    }

    html += `</div>`;
    panel.innerHTML = html;

    // Attach merge handlers
    panel.querySelectorAll<HTMLElement>(".folders-merge-keep-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupIdx = parseInt(btn.getAttribute("data-group") || "0");
        const keepId = parseInt(btn.getAttribute("data-folder-id") || "0");
        if (!keepId) return;

        const group = duplicateGroups[groupIdx];
        const mergeIds = group.folders.filter(f => f.id !== keepId).map(f => f.id);

        if (mergeIds.length === 0) return;

        const keepFolder = group.folders.find(f => f.id === keepId);
        const msg = `Keep "${keepFolder?.name}" and merge ${mergeIds.length} other folder(s) into it?\n\nThe other folder records will be deleted. Images will be reassigned.`;
        if (!confirm(msg)) return;

        let moved = 0;
        for (const mergeId of mergeIds) {
          try {
            const mergeResp = await callService({ MergeFolders: { keep_folder_id: keepId, merge_folder_id: mergeId } });
            if ("MergeFoldersResult" in mergeResp && mergeResp.MergeFoldersResult.success) {
              moved += mergeResp.MergeFoldersResult.images_moved;
            } else if ("Error" in mergeResp) {
              logJS("Merge failed: " + mergeResp.Error.message);
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
