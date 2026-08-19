/**
 * Library view: Followed series, Bookmarks, and Reading history.
 * All data is local (SQLite) — fully offline-safe, no network traffic.
 */

import { Route, decodeEntities, formatDate, navigate, setActions, setBanner } from "./state";
import { openExternal, refreshFollowedSeriesCover } from "./api";
import {
  FollowedSeriesRow,
  BookmarkRow,
  HistoryRow,
  getFollowedSeriesPage,
  getBookmarksPage,
  getHistoryPage,
  getFullyCachedChapterPermalinks,
  removeBookmark,
  removeHistory,
  clearHistory,
} from "./db";
import { createConfirmDeleteButton } from "./components/button";
import { renderCoverImage } from "./components/cover";
import { renderPager } from "./components/pager";
import { attachDelayedLoading } from "./components/loading";

function createLibraryPanel(titleHtml: string): {
  panel: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
} {
  const panel = document.createElement("div");
  panel.className = "group-box ds-library-panel";

  const head = document.createElement("div");
  head.className = "group-box-title";
  head.innerHTML = titleHtml;

  const body = document.createElement("div");
  body.className = "ds-library-panel-body";

  const footer = document.createElement("div");
  footer.className = "ds-library-panel-footer";
  footer.classList.add("ds-hidden");

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(footer);
  return { panel, head, body, footer };
}

export function renderLibrary(container: HTMLElement, _route: Route): void {
  // If library panels are already mounted, refresh rows and actions in-place without rebuilding grid
  const existingGrid = container.querySelector<HTMLElement>(".ds-library-grid");
  if (existingGrid) {
    const bodies = container.querySelectorAll<HTMLElement>(".ds-library-panel-body");
    const footers = container.querySelectorAll<HTMLElement>(".ds-library-panel-footer");
    if (bodies.length >= 3 && footers.length >= 3) {
      setupLibraryActions(
        bodies[0],
        footers[0],
        bodies[1],
        footers[1],
        bodies[2],
        footers[2],
      );
      void loadAll(bodies[0], footers[0], bodies[1], footers[1], bodies[2], footers[2]);
      return;
    }
  }

  container.innerHTML = "";

  const root = document.createElement("div");
  root.id = "ds-library-container";
  container.appendChild(root);

  const grid = document.createElement("div");
  grid.className = "ds-library-grid";
  root.appendChild(grid);

  const {
    panel: followedPanel,
    body: followedBody,
    footer: followedFooter,
  } = createLibraryPanel('<i class="bi bi-bookmark-heart"></i> Followed Series');
  grid.appendChild(followedPanel);

  const {
    panel: bookmarksPanel,
    body: bookmarksBody,
    footer: bookmarksFooter,
  } = createLibraryPanel('<i class="bi bi-bookmark"></i> Bookmarks');
  grid.appendChild(bookmarksPanel);

  const {
    panel: historyPanel,
    head: historyHead,
    body: historyBody,
    footer: historyFooter,
  } = createLibraryPanel(
    '<span class="ds-flex-row"><i class="bi bi-clock-history"></i> Reading History</span>',
  );

  const clearHistoryBtn = createConfirmDeleteButton(
    "Clear all reading history",
    async () => {
      await clearHistory();
      setBanner("All reading history cleared.");
      void loadHistoryPage(historyBody, historyFooter, 1);
    },
    '<i class="bi bi-trash3"></i> Clear',
  );
  clearHistoryBtn.style.cssText =
    "font-size:10px;padding:0 5px;height:18px;line-height:18px;margin-left:auto;";
  historyHead.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;width:calc(100% - 16px);right:8px;";
  historyHead.appendChild(clearHistoryBtn);

  grid.appendChild(historyPanel);

  setupLibraryActions(
    followedBody,
    followedFooter,
    bookmarksBody,
    bookmarksFooter,
    historyBody,
    historyFooter,
  );

  void loadAll(
    followedBody,
    followedFooter,
    bookmarksBody,
    bookmarksFooter,
    historyBody,
    historyFooter,
  );
}

function setupLibraryActions(
  followedBody: HTMLElement,
  followedFooter: HTMLElement,
  bookmarksBody: HTMLElement,
  bookmarksFooter: HTMLElement,
  historyBody: HTMLElement,
  historyFooter: HTMLElement,
): void {
  setActions((host) => {
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.id = "ds-library-refresh-btn";
    refreshBtn.className = "win-button ds-btn-sm";
    refreshBtn.title = "Refresh library from local database";
    refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Refresh Library';
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      const prevHtml = refreshBtn.innerHTML;
      refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise ds-spin"></i> Refreshing...';
      try {
        await loadAll(
          followedBody,
          followedFooter,
          bookmarksBody,
          bookmarksFooter,
          historyBody,
          historyFooter,
        );
        refreshBtn.innerHTML = '<i class="bi bi-check2"></i> Updated';
        setTimeout(() => {
          refreshBtn.innerHTML = prevHtml;
          refreshBtn.disabled = false;
        }, 1200);
      } catch {
        refreshBtn.innerHTML = prevHtml;
        refreshBtn.disabled = false;
      }
    });
    host.appendChild(refreshBtn);

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
}

async function loadAll(
  followedBody: HTMLElement,
  followedFooter: HTMLElement,
  bookmarksBody: HTMLElement,
  bookmarksFooter: HTMLElement,
  historyBody: HTMLElement,
  historyFooter: HTMLElement,
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

async function loadFollowedPage(
  body: HTMLElement,
  footer: HTMLElement,
  page: number,
): Promise<void> {
  footer.innerHTML = "";
  footer.classList.add("ds-hidden");
  const cancelLoading = attachDelayedLoading(body, 140);

  try {
    const res = await getFollowedSeriesPage(page, 10);
    cancelLoading();
    renderFollowed(
      body,
      footer,
      res.rows,
      res.totalPages,
      res.currentPage,
      (p) => void loadFollowedPage(body, footer, p),
    );
  } catch (err) {
    cancelLoading();
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
  onPage: (p: number) => void,
): void {
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.classList.add("ds-hidden");
    const empty = document.createElement("div");
    empty.style.cssText =
      "display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:8px 0;";
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
    body.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "group-box";
    card.style.cssText =
      "display:flex;gap:10px;align-items:center;cursor:pointer;margin-bottom:4px;";

    const coverSlot = document.createElement("div");
    coverSlot.style.cssText = "flex-shrink:0;";
    coverSlot.appendChild(renderCoverImage(row.cover, row.name));
    card.appendChild(coverSlot);

    void (async () => {
      const fresh = await refreshFollowedSeriesCover(row.permalink, row.cover);
      if (fresh && fresh !== row.cover) {
        coverSlot.innerHTML = "";
        coverSlot.appendChild(renderCoverImage(fresh, row.name));
      }
    })();

    const info = document.createElement("div");
    info.className = "ds-fill";
    const name = document.createElement("div");
    name.className = "ds-truncate";
    name.style.cssText = "font-size:12px;font-weight:600;";
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
    frag.appendChild(card);
  }

  body.replaceChildren(frag);

  if (totalPages > 1) {
    footer.classList.remove("ds-hidden");
    footer.appendChild(renderPager(totalPages, currentPage, onPage));
  } else {
    footer.classList.add("ds-hidden");
  }
}

async function loadBookmarksPage(
  body: HTMLElement,
  footer: HTMLElement,
  page: number,
): Promise<void> {
  footer.innerHTML = "";
  footer.classList.add("ds-hidden");
  const cancelLoading = attachDelayedLoading(body, 140);

  try {
    const [res, fullyCachedSet] = await Promise.all([
      getBookmarksPage(page, 15),
      getFullyCachedChapterPermalinks(),
    ]);
    cancelLoading();
    renderBookmarks(
      body,
      footer,
      res.rows,
      res.totalPages,
      res.currentPage,
      (p) => void loadBookmarksPage(body, footer, p),
      fullyCachedSet,
    );
  } catch (err) {
    cancelLoading();
    body.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Failed to load bookmarks: ${msg}`);
  }
}

function renderBookmarks(
  body: HTMLElement,
  footer: HTMLElement,
  rows: BookmarkRow[],
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void,
  fullyCachedSet: Set<string> = new Set(),
): void {
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.classList.add("ds-hidden");
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "No bookmarks yet.";
    body.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "ds-item ds-flex-row";
    item.style.cssText = "padding:4px 6px;";

    const isFullyCached = fullyCachedSet.has(row.chapter_permalink);
    const info = document.createElement("div");
    info.className = "ds-fill ds-clickable";
    const title = document.createElement("div");
    title.className = "ds-item-title";
    title.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;";
    title.innerHTML = `<span>${decodeEntities(row.chapter_title)}</span>${
      isFullyCached
        ? '<i class="bi bi-cloud-check-fill ds-offline-icon" style="color:var(--sys-primary,#0078d4);font-size:11px;" title="Available Offline (Fully Cached)"></i>'
        : ""
    }`;
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
    frag.appendChild(item);
  }

  body.replaceChildren(frag);

  if (totalPages > 1) {
    footer.classList.remove("ds-hidden");
    footer.appendChild(renderPager(totalPages, currentPage, onPage));
  } else {
    footer.classList.add("ds-hidden");
  }
}

async function loadHistoryPage(
  body: HTMLElement,
  footer: HTMLElement,
  page: number,
): Promise<void> {
  footer.innerHTML = "";
  footer.classList.add("ds-hidden");
  const cancelLoading = attachDelayedLoading(body, 140);

  try {
    const [res, fullyCachedSet] = await Promise.all([
      getHistoryPage(page, 15),
      getFullyCachedChapterPermalinks(),
    ]);
    cancelLoading();
    renderHistory(
      body,
      footer,
      res.rows,
      res.totalPages,
      res.currentPage,
      (p) => void loadHistoryPage(body, footer, p),
      fullyCachedSet,
    );
  } catch (err) {
    cancelLoading();
    body.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Failed to load history: ${msg}`);
  }
}

function renderHistory(
  body: HTMLElement,
  footer: HTMLElement,
  rows: HistoryRow[],
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void,
  fullyCachedSet: Set<string> = new Set(),
): void {
  footer.innerHTML = "";
  if (rows.length === 0) {
    footer.classList.add("ds-hidden");
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "Nothing read yet.";
    body.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "ds-item ds-flex-row";
    item.style.cssText = "padding:4px 6px;";

    const isFullyCached = fullyCachedSet.has(row.chapter_permalink);
    const info = document.createElement("div");
    info.className = "ds-fill ds-clickable";
    const title = document.createElement("div");
    title.className = "ds-item-title";
    title.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;";
    title.innerHTML = `<span>${decodeEntities(row.chapter_title)}</span>${
      isFullyCached
        ? '<i class="bi bi-cloud-check-fill ds-offline-icon" style="color:var(--sys-primary,#0078d4);font-size:11px;" title="Available Offline (Fully Cached)"></i>'
        : ""
    }`;
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
    frag.appendChild(item);
  }

  body.replaceChildren(frag);

  if (totalPages > 1) {
    footer.classList.remove("ds-hidden");
    footer.appendChild(renderPager(totalPages, currentPage, onPage));
  } else {
    footer.classList.add("ds-hidden");
  }
}
