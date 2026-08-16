/**
 * Library view: Followed series, Bookmarks, and Reading history.
 * All data is local (SQLite) — fully offline-safe, no network traffic.
 */

import { Route, decodeEntities, formatDate, navigate, setActions, setBanner } from "./state";
import { openExternal } from "./api";
import {
  FollowedSeriesRow,
  BookmarkRow,
  HistoryRow,
  getFollowedSeriesPage,
  getBookmarksPage,
  getHistoryPage,
  removeBookmark,
  removeHistory,
  clearHistory,
} from "./db";
import { createConfirmDeleteButton } from "./components/button";
import { renderCoverImage } from "./components/cover";
import { renderPager } from "./components/pager";

function createLibraryPanel(titleHtml: string): { panel: HTMLElement; head: HTMLElement; body: HTMLElement; footer: HTMLElement } {
  const panel = document.createElement("div");
  panel.className = "group-box ds-library-panel";

  const head = document.createElement("div");
  head.className = "group-box-title";
  head.innerHTML = titleHtml;

  const body = document.createElement("div");
  body.className = "ds-library-panel-body";

  const footer = document.createElement("div");
  footer.className = "ds-library-panel-footer";
  footer.style.display = "none";

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(footer);
  return { panel, head, body, footer };
}

export function renderLibrary(container: HTMLElement, _route: Route): void {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.id = "ds-library-container";
  container.appendChild(root);

  setActions((host) => {
    const cacheBtn = document.createElement("button");
    cacheBtn.type = "button";
    cacheBtn.className = "win-button";
    cacheBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    cacheBtn.innerHTML = '<i class="bi bi-hdd-stack"></i> Cache Management';
    cacheBtn.title = "View cache storage statistics and manage cached series/pages";
    cacheBtn.addEventListener("click", () => {
      navigate({ view: "cache" });
    });
    host.appendChild(cacheBtn);
  });

  const grid = document.createElement("div");
  grid.className = "ds-library-grid";
  root.appendChild(grid);

  const { panel: followedPanel, body: followedBody, footer: followedFooter } = createLibraryPanel(
    '<i class="bi bi-bookmark-heart"></i> Followed Series'
  );
  grid.appendChild(followedPanel);

  const { panel: bookmarksPanel, body: bookmarksBody, footer: bookmarksFooter } = createLibraryPanel(
    '<i class="bi bi-bookmark"></i> Bookmarks'
  );
  grid.appendChild(bookmarksPanel);

  const { panel: historyPanel, head: historyHead, body: historyBody, footer: historyFooter } = createLibraryPanel(
    '<span style="display:flex;align-items:center;gap:6px;"><i class="bi bi-clock-history"></i> Reading History</span>'
  );

  const clearHistoryBtn = createConfirmDeleteButton(
    "Clear all reading history",
    async () => {
      await clearHistory();
      setBanner("All reading history cleared.");
      void loadHistoryPage(historyBody, historyFooter, 1);
    },
    '<i class="bi bi-trash3"></i> Clear'
  );
  clearHistoryBtn.style.cssText = "font-size:10px;padding:0 5px;height:18px;line-height:18px;margin-left:auto;";
  historyHead.style.cssText = "display:flex;align-items:center;justify-content:space-between;width:calc(100% - 16px);right:8px;";
  historyHead.appendChild(clearHistoryBtn);

  grid.appendChild(historyPanel);

  void loadAll(followedBody, followedFooter, bookmarksBody, bookmarksFooter, historyBody, historyFooter);
}

async function loadAll(
  followedBody: HTMLElement,
  followedFooter: HTMLElement,
  bookmarksBody: HTMLElement,
  bookmarksFooter: HTMLElement,
  historyBody: HTMLElement,
  historyFooter: HTMLElement
): Promise<void> {
  try {
    await Promise.all([
      loadFollowedPage(followedBody, followedFooter, 1),
      loadBookmarksPage(bookmarksBody, bookmarksFooter, 1),
      loadHistoryPage(historyBody, historyFooter, 1),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Library failed to load: ${msg}`);
  }
}

async function loadFollowedPage(body: HTMLElement, footer: HTMLElement, page: number): Promise<void> {
  body.innerHTML = "";
  footer.innerHTML = "";
  footer.style.display = "none";

  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading followed series…";
  body.appendChild(loading);

  try {
    const res = await getFollowedSeriesPage(page, 10);
    renderFollowed(body, footer, res.rows, res.totalPages, res.currentPage, (p) => void loadFollowedPage(body, footer, p));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    body.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "ds-muted";
    errEl.textContent = `Failed to load followed series: ${msg}`;
    body.appendChild(errEl);
  }
}

function renderFollowed(
  body: HTMLElement,
  footer: HTMLElement,
  rows: FollowedSeriesRow[],
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void
): void {
  body.innerHTML = "";
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.style.display = "none";
    const empty = document.createElement("div");
    empty.style.cssText = "display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:8px 0;";
    const emptyText = document.createElement("div");
    emptyText.className = "ds-muted";
    emptyText.textContent = "No followed series yet.";
    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "win-button";
    browseBtn.style.cssText = "font-size:11px;";
    browseBtn.innerHTML = '<i class="bi bi-compass"></i> Browse Series';
    browseBtn.addEventListener("click", () => {
      navigate({ view: "browse", browseTab: "series-dir" });
    });
    empty.appendChild(emptyText);
    empty.appendChild(browseBtn);
    body.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "group-box";
    card.style.cssText = "display:flex;gap:10px;align-items:center;cursor:pointer;margin-bottom:4px;";
    card.appendChild(renderCoverImage(row.cover, row.name));

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";
    const name = document.createElement("div");
    name.style.cssText = "font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    name.textContent = decodeEntities(row.name);
    const latest = document.createElement("div");
    latest.className = "ds-muted";
    latest.textContent = row.latest_chapter_title
      ? `Latest: ${decodeEntities(row.latest_chapter_title)}`
      : "No chapters read yet";
    info.appendChild(name);
    info.appendChild(latest);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "win-button";
    open.style.cssText = "font-size:11px;padding:2px 10px;";
    open.innerHTML = '<i class="bi bi-book"></i> Open';
    open.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({ view: "series", seriesPermalink: row.permalink, seriesName: row.name });
    });
    info.addEventListener("click", () => {
      navigate({ view: "series", seriesPermalink: row.permalink, seriesName: row.name });
    });

    card.appendChild(info);

    const extBtn = document.createElement("button");
    extBtn.type = "button";
    extBtn.className = "win-button";
    extBtn.style.cssText = "font-size:11px;padding:2px 6px;";
    extBtn.title = "Open series on Dynasty Scans in browser";
    extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
    extBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openExternal(`https://dynasty-scans.com/series/${row.permalink}`);
    });
    card.appendChild(extBtn);

    card.appendChild(open);
    body.appendChild(card);
  }

  if (totalPages > 1) {
    footer.style.display = "block";
    footer.appendChild(renderPager(totalPages, currentPage, onPage, { showLabels: true }));
  } else {
    footer.style.display = "none";
  }
}

async function loadBookmarksPage(body: HTMLElement, footer: HTMLElement, page: number): Promise<void> {
  body.innerHTML = "";
  footer.innerHTML = "";
  footer.style.display = "none";

  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading bookmarks…";
  body.appendChild(loading);

  try {
    const res = await getBookmarksPage(page, 15);
    renderBookmarks(body, footer, res.rows, res.totalPages, res.currentPage, (p) => void loadBookmarksPage(body, footer, p));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    body.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "ds-muted";
    errEl.textContent = `Failed to load bookmarks: ${msg}`;
    body.appendChild(errEl);
  }
}

function renderBookmarks(
  body: HTMLElement,
  footer: HTMLElement,
  rows: BookmarkRow[],
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void
): void {
  body.innerHTML = "";
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.style.display = "none";
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "No bookmarks yet.";
    body.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "ds-item";
    item.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;";

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;cursor:pointer;";
    const title = document.createElement("div");
    title.className = "ds-item-title";
    title.textContent = decodeEntities(row.chapter_title);
    const meta = document.createElement("div");
    meta.className = "ds-item-meta";
    meta.textContent = `${decodeEntities(row.series_name)} · page ${row.page_index + 1}`;
    info.appendChild(title);
    info.appendChild(meta);
    info.addEventListener("click", () => {
      navigate({
        view: "reader",
        chapterPermalink: row.chapter_permalink,
        chapterTitle: row.chapter_title,
        seriesPermalink: row.series_permalink,
        seriesName: row.series_name,
        startPage: row.page_index,
      });
    });

    const extBtn = document.createElement("button");
    extBtn.type = "button";
    extBtn.className = "win-button";
    extBtn.style.cssText = "font-size:10px;padding:2px 6px;flex-shrink:0;";
    extBtn.title = "Open chapter on Dynasty Scans in browser";
    extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
    extBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openExternal(`https://dynasty-scans.com/chapters/${row.chapter_permalink}`);
    });

    const removeBtn = createConfirmDeleteButton("Remove bookmark", async () => {
      await removeBookmark(row.chapter_permalink);
      void loadBookmarksPage(body, footer, currentPage);
    });

    item.appendChild(info);
    item.appendChild(extBtn);
    item.appendChild(removeBtn);
    body.appendChild(item);
  }

  if (totalPages > 1) {
    footer.style.display = "block";
    footer.appendChild(renderPager(totalPages, currentPage, onPage, { showLabels: true }));
  } else {
    footer.style.display = "none";
  }
}

async function loadHistoryPage(body: HTMLElement, footer: HTMLElement, page: number): Promise<void> {
  body.innerHTML = "";
  footer.innerHTML = "";
  footer.style.display = "none";

  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading history…";
  body.appendChild(loading);

  try {
    const res = await getHistoryPage(page, 15);
    renderHistory(body, footer, res.rows, res.totalPages, res.currentPage, (p) => void loadHistoryPage(body, footer, p));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    body.innerHTML = "";
    const errEl = document.createElement("div");
    errEl.className = "ds-muted";
    errEl.textContent = `Failed to load history: ${msg}`;
    body.appendChild(errEl);
  }
}

function renderHistory(
  body: HTMLElement,
  footer: HTMLElement,
  rows: HistoryRow[],
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void
): void {
  body.innerHTML = "";
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.style.display = "none";
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "Nothing read yet.";
    body.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "ds-item";
    item.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;";

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;cursor:pointer;";
    const title = document.createElement("div");
    title.className = "ds-item-title";
    title.textContent = decodeEntities(row.chapter_title);
    const meta = document.createElement("div");
    meta.className = "ds-item-meta";
    meta.textContent = `${decodeEntities(row.series_name)} · ${formatDate(Number(row.read_at))}`;
    info.appendChild(title);
    info.appendChild(meta);
    info.addEventListener("click", () => {
      navigate({
        view: "reader",
        chapterPermalink: row.chapter_permalink,
        chapterTitle: row.chapter_title,
        seriesPermalink: row.series_permalink,
        seriesName: row.series_name,
      });
    });

    const extBtn = document.createElement("button");
    extBtn.type = "button";
    extBtn.className = "win-button";
    extBtn.style.cssText = "font-size:10px;padding:2px 6px;flex-shrink:0;";
    extBtn.title = "Open chapter on Dynasty Scans in browser";
    extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
    extBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openExternal(`https://dynasty-scans.com/chapters/${row.chapter_permalink}`);
    });

    const removeBtn = createConfirmDeleteButton("Remove from history", async () => {
      await removeHistory(row.id);
      void loadHistoryPage(body, footer, currentPage);
    });

    item.appendChild(info);
    item.appendChild(extBtn);
    item.appendChild(removeBtn);
    body.appendChild(item);
  }

  if (totalPages > 1) {
    footer.style.display = "block";
    footer.appendChild(renderPager(totalPages, currentPage, onPage, { showLabels: true }));
  } else {
    footer.style.display = "none";
  }
}