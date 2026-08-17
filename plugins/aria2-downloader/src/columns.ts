/**
 * Persisted, resizable table-column widths for the aria2-downloader tables.
 *
 * Installs a single set of document-level mouse handlers (idempotent) that
 * lets users drag table header borders. Widths are stored per-column in
 * localStorage and restored on each `applyColumnWidths` call.
 */

const COL_WIDTH_KEY = "aria2-downloader-col-";

interface ColumnResizeState {
  th: HTMLTableCellElement;
  colKey: string;
  startX: number;
  startWidth: number;
  liveWidth: number;
}

let columnResizeState: ColumnResizeState | null = null;

/** Restore persisted widths onto table headers (idempotent per render). */
export function applyColumnWidths(): void {
  document.querySelectorAll<HTMLTableCellElement>(".ad-table thead th").forEach((th) => {
    const colKey = (th.className.match(/\bcol-\w+/) ?? [""])[0];
    if (!colKey) return;
    const width = localStorage.getItem(COL_WIDTH_KEY + colKey);
    if (width) th.style.width = `${width}px`;
  });
}

function columnResizeMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const th = target.closest?.("th");
  if (!th || !th.closest(".ad-table")) return;
  const rect = th.getBoundingClientRect();
  if (e.clientX < rect.right - 5 || e.clientX > rect.right + 5) return;
  e.preventDefault();
  const colKey = (th.className.match(/\bcol-\w+/) ?? [""])[0];
  if (!colKey) return;
  columnResizeState = {
    th,
    colKey,
    startX: e.clientX,
    startWidth: rect.width,
    liveWidth: rect.width,
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function columnResizeMouseMove(e: MouseEvent): void {
  if (!columnResizeState) return;
  const width = Math.max(40, columnResizeState.startWidth + (e.clientX - columnResizeState.startX));
  columnResizeState.liveWidth = width;
  columnResizeState.th.style.width = `${width}px`;
}

function columnResizeMouseUp(): void {
  if (!columnResizeState) return;
  localStorage.setItem(COL_WIDTH_KEY + columnResizeState.colKey, String(columnResizeState.liveWidth));
  columnResizeState = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

let columnResizeWired = false;
export function wireColumnResize(): void {
  if (columnResizeWired) return;
  columnResizeWired = true;
  document.addEventListener("mousedown", columnResizeMouseDown);
  document.addEventListener("mousemove", columnResizeMouseMove);
  document.addEventListener("mouseup", columnResizeMouseUp);
}
