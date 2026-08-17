/**
 * Download history view for the aria2-downloader tab.
 *
 * Owns history schema bootstrap (`initHistory`), the search-driven reload
 * (`refreshHistoryUI`), row deletion (`removeHistoryRecord`), and the history
 * table DOM (`renderHistory` / `renderHistoryRow`).
 */

import { formatBytes } from "../../lib";
import { revealInFolder } from "./ipc";
import { ensureHistorySchema, queryHistory, removeHistoryEntry, searchHistory } from "./history";
import { state } from "./state";
import { el, log } from "./ui-core";
import { applyColumnWidths } from "./columns";
import { formatDateTime, hostFromUrl } from "./ui-utils";
import { redownloadUrl } from "./queue";
import type { HistoryRecord } from "./history";

export async function initHistory(): Promise<void> {
  await ensureHistorySchema();
  await refreshHistoryUI("");
}

export async function refreshHistoryUI(term: string): Promise<void> {
  try {
    state.history = term.trim()
      ? await searchHistory(term.trim())
      : await queryHistory(200);
  } catch (err) {
    log(`History load failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  renderHistory(state.history);
}

export async function removeHistoryRecord(id: number): Promise<void> {
  try {
    await removeHistoryEntry(id);
    state.history = state.history.filter((r) => r.id !== id);
    renderHistory(state.history);
    log("Removed history entry.", "info");
  } catch (err) {
    log(`Remove failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export function renderHistory(records: HistoryRecord[], listEl?: HTMLElement): void {
  const list = listEl ?? el("ad-history-list");
  if (!list) return;
  list.innerHTML = "";
  if (!records.length) {
    list.innerHTML = '<div class="ad-empty">No downloads recorded yet.</div>';
    return;
  }
  const table = document.createElement("table");
  table.className = "ad-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    '<th class="col-status">Status</th>' +
    '<th class="col-hoster">Hoster</th>' +
    '<th class="col-file">File</th>' +
    '<th class="col-size">Size</th>' +
    '<th class="col-hdate">Completed</th>' +
    '<th class="col-actions">Actions</th>' +
    "</tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const rec of records) {
    tbody.appendChild(renderHistoryRow(rec));
  }
  table.appendChild(tbody);
  list.appendChild(table);
  applyColumnWidths();
}

function renderHistoryRow(rec: HistoryRecord): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "ad-table-row";

  const tdStatus = document.createElement("td");
  tdStatus.className = "col-status";
  const badge = document.createElement("span");
  badge.className = `ad-badge ${rec.status}`;
  badge.textContent = rec.status;
  tdStatus.appendChild(badge);

  const tdHoster = document.createElement("td");
  tdHoster.className = "col-hoster";
  const hoster = document.createElement("span");
  hoster.className = "ad-meta";
  hoster.style.cssText = "display:block;width:100%;";
  hoster.textContent = hostFromUrl(rec.url);
  hoster.title = rec.url;
  tdHoster.appendChild(hoster);

  const tdFile = document.createElement("td");
  tdFile.className = "col-file";
  const name = document.createElement("div");
  name.className = "ad-row-mono";
  name.textContent = rec.filename;
  name.title = rec.file_path;
  tdFile.appendChild(name);

  const tdSize = document.createElement("td");
  tdSize.className = "col-size";
  const size = document.createElement("span");
  size.className = "ad-meta";
  size.style.cssText = "display:block;width:100%;";
  size.textContent = formatBytes(rec.file_size);
  tdSize.appendChild(size);

  const tdDate = document.createElement("td");
  tdDate.className = "col-hdate";
  const date = document.createElement("span");
  date.className = "ad-meta";
  date.style.cssText = "display:block;width:100%;";
  date.textContent = formatDateTime(rec.completed_at);
  tdDate.appendChild(date);

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
  mk("bi bi-folder2-open", "Open in Explorer (highlight)", () => {
    void (async () => {
      const ok = await revealInFolder(rec.file_path);
      if (!ok) log("Could not reveal output file in Explorer.", "error");
    })();
  });
  mk("bi bi-clipboard", "Copy path", () => void navigator.clipboard?.writeText(rec.file_path));
  mk("bi bi-link-45deg", "Copy URL", () => void navigator.clipboard?.writeText(rec.url));
  mk("bi bi-arrow-repeat", "Re-download", () => void redownloadUrl(rec.url));
  mk("bi bi-x-lg", "Remove from history", () => void removeHistoryRecord(rec.id));
  tdActions.appendChild(actions);

  tr.appendChild(tdStatus);
  tr.appendChild(tdHoster);
  tr.appendChild(tdFile);
  tr.appendChild(tdSize);
  tr.appendChild(tdDate);
  tr.appendChild(tdActions);
  return tr;
}
