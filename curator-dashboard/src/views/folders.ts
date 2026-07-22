import { invoke } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { logJS, escapeHtml, formatDate } from "../utils";
import { maskPath } from "../components";

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

    let html = `<table class="folders-table">
      <thead>
        <tr>
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

      html += `<tr class="folders-row" data-folder-id="${folder.id}" data-folder-path="${escapeHtml(folder.path)}">
        <td style="font-weight: 600;">${escapeHtml(folder.name)}</td>
        <td style="font-size: 11px; color: #555; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(folder.path)}">${maskPath(folder.path)}</td>
        <td style="text-align: right;">${folder.image_count}</td>
        <td style="text-align: right;">${vectorText}</td>
        <td style="font-size: 11px; color: #555;">${formatDate(folder.imported_at)}</td>
        <td style="text-align: center;">
          <button class="win-button folders-open-btn" data-path="${escapeHtml(folder.path)}" style="font-size: 11px; padding: 2px 8px;">
            <i class="bi bi-folder2-open"></i> Open
          </button>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;

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
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}
