/**
 * Browse view: Downloaded Chapters category.
 * Displays all chapters that are fully cached locally for offline reading.
 */

import { decodeEntities, formatBytes, formatDate, navigate, onRouteChange } from "../state";
import { getFullyCachedChapters, type FullyCachedChapterRow } from "../db";
import { renderPager } from "../components/pager";
import { scrollBrowseToTop, updateBrowseTopPager } from "./browse-controller";
import { setupInputClearButtons } from "../components/input-field";

const PAGE_SIZE = 25;
const PH = window.PluginHost;

let downloadedSearchQuery = "";
let cachedChaptersList: FullyCachedChapterRow[] = [];

/** Resets the downloaded-chapters filter/list when leaving the Browse view. */
export function resetDownloadedState(): void {
  downloadedSearchQuery = "";
  cachedChaptersList = [];
}
onRouteChange((view) => {
  if (view !== "browse") resetDownloadedState();
});

export async function renderDownloadedChapters(
  host: HTMLElement,
  page: number,
  reload: (host: HTMLElement, tabId: string, page: number) => Promise<void>,
): Promise<void> {
  // Always fetch fresh list on tab activation or external reload
  cachedChaptersList = await getFullyCachedChapters();

  // If container is already mounted inside host, update in-place without rebuilding input
  const existingContainer = host.querySelector<HTMLElement>("#ds-downloaded-container");
  if (existingContainer) {
    updateDownloadedView(host, page, reload);
    return;
  }

  host.innerHTML = "";

  const container = document.createElement("div");
  container.id = "ds-downloaded-container";
  container.style.cssText = "display:flex;flex-direction:column;";

  // Top header bar with summary stats & quick filter search
  const header = document.createElement("div");
  header.className = "ds-row ds-downloaded-header";
  header.style.cssText =
    "justify-content:space-between;align-items:center;padding:4px 8px;margin-bottom:8px;background:var(--sys-control-bg,#f4f4f4);border:1px solid var(--sys-border-light,#ddd);border-radius:3px;gap:8px;flex-wrap:wrap;";

  const statsSpan = document.createElement("div");
  statsSpan.className = "ds-downloaded-stats";
  statsSpan.style.cssText =
    "font-size:11px;color:var(--sys-window-text,#333);display:flex;align-items:center;gap:6px;";
  header.appendChild(statsSpan);

  // Search filter input
  const filterWrap = document.createElement("div");
  filterWrap.className = "input-wrapper";
  filterWrap.style.cssText = "width:220px;max-width:100%;";
  filterWrap.innerHTML = `
    <input type="text" class="input-field has-clear" placeholder="Filter downloaded chapters..." value="${downloadedSearchQuery}" style="width:100%;box-sizing:border-box;font-size:11px;height:22px;" />
    <button type="button" class="input-clear-btn" tabindex="-1" title="Clear"><i class="bi bi-x-lg"></i></button>
  `;
  const filterInput = filterWrap.querySelector<HTMLInputElement>("input")!;
  filterInput.addEventListener("input", () => {
    downloadedSearchQuery = filterInput.value;
    updateDownloadedView(host, 1, reload);
  });
  setupInputClearButtons(filterWrap);
  header.appendChild(filterWrap);

  container.appendChild(header);

  // List body
  const list = document.createElement("div");
  list.id = "ds-downloaded-list";
  container.appendChild(list);

  // Bottom pager
  const pagerWrap = document.createElement("div");
  pagerWrap.id = "ds-downloaded-pager";
  container.appendChild(pagerWrap);

  host.appendChild(container);

  updateDownloadedView(host, page, reload);
}

function updateDownloadedView(
  host: HTMLElement,
  page: number,
  reload: (host: HTMLElement, tabId: string, page: number) => Promise<void>,
): void {
  scrollBrowseToTop();
  const statsSpan = host.querySelector<HTMLElement>(".ds-downloaded-stats");
  const list = host.querySelector<HTMLElement>("#ds-downloaded-list");
  const pagerWrap = host.querySelector<HTMLElement>("#ds-downloaded-pager");
  if (!list || !pagerWrap) return;

  const totalBytes = cachedChaptersList.reduce((acc, c) => acc + c.totalSizeBytes, 0);
  if (statsSpan) {
    statsSpan.innerHTML = `
      <i class="bi bi-cloud-check-fill" style="color:var(--sys-primary,#0078d4);font-size:13px;"></i>
      <span><b>${cachedChaptersList.length}</b> fully downloaded chapter${cachedChaptersList.length === 1 ? "" : "s"} (${formatBytes(totalBytes)} offline)</span>
    `;
  }

  const queryLower = downloadedSearchQuery.trim().toLowerCase();
  const filtered = queryLower
    ? cachedChaptersList.filter(
        (c) =>
          c.chapterTitle.toLowerCase().includes(queryLower) ||
          (c.seriesName && c.seriesName.toLowerCase().includes(queryLower)) ||
          c.chapterPermalink.toLowerCase().includes(queryLower),
      )
    : cachedChaptersList;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  updateBrowseTopPager(
    totalPages,
    currentPage,
    (p) => updateDownloadedView(host, p, reload),
    "downloaded",
  );

  list.innerHTML = "";
  pagerWrap.innerHTML = "";

  if (pageItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.style.cssText = "padding:24px;text-align:center;font-size:12px;";
    if (downloadedSearchQuery) {
      empty.textContent = `No downloaded chapters matched "${downloadedSearchQuery}".`;
    } else {
      empty.innerHTML = `
        <div style="font-size:24px;margin-bottom:8px;"><i class="bi bi-cloud-arrow-down"></i></div>
        <div>No fully downloaded chapters found yet.</div>
        <div style="font-size:11px;margin-top:4px;color:#888;">
          Enable <b>Auto-Cache</b> in Settings or click <b>Cache Chapter</b> while reading to save chapters for offline reading.
        </div>
      `;
    }
    list.appendChild(empty);
    return;
  }

  const feedList = document.createElement("div");
  feedList.className = "ds-feed-list";
  feedList.style.cssText = "display:flex;flex-direction:column;gap:6px;";

  for (const ch of pageItems) {
    feedList.appendChild(renderDownloadedChapterRow(ch));
  }
  list.appendChild(feedList);

  if (totalPages > 1) {
    const pager = renderPager(totalPages, currentPage, (p) =>
      updateDownloadedView(host, p, reload),
    );
    pagerWrap.appendChild(pager);
  }
}

function renderDownloadedChapterRow(ch: FullyCachedChapterRow): HTMLElement {
  const item = document.createElement("div");
  item.className = "ds-item ds-feed-item";
  item.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 8px;cursor:pointer;";

  // Cover thumbnail
  const coverWrap = document.createElement("div");
  coverWrap.className = "ds-feed-cover-wrap";
  coverWrap.style.cssText =
    "flex-shrink:0;width:38px;height:52px;background:#e2e2e2;border:1px solid #ccc;border-radius:2px;overflow:hidden;display:flex;align-items:center;justify-content:center;";

  if (ch.coverPath) {
    const img = document.createElement("img");
    img.src = PH.convertFileSrc(ch.coverPath);
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    img.loading = "lazy";
    img.onerror = () => {
      coverWrap.innerHTML = '<i class="bi bi-book" style="color:#888;font-size:16px;"></i>';
    };
    coverWrap.appendChild(img);
  } else {
    coverWrap.innerHTML = '<i class="bi bi-book" style="color:#888;font-size:16px;"></i>';
  }
  item.appendChild(coverWrap);

  // Info column
  const info = document.createElement("div");
  info.className = "ds-fill";
  info.style.cssText = "display:flex;flex-direction:column;gap:4px;";

  const titleRow = document.createElement("div");
  titleRow.className = "ds-flex-row";
  titleRow.style.cssText = "flex-wrap:wrap;";

  const title = document.createElement("span");
  title.className = "ds-item-title";
  title.style.cssText = "font-weight:600;font-size:12px;color:var(--sys-window-text,#111);";
  title.textContent = decodeEntities(ch.chapterTitle);
  titleRow.appendChild(title);

  // Offline available icon
  const offlineIcon = document.createElement("span");
  offlineIcon.innerHTML =
    '<i class="bi bi-cloud-check-fill ds-offline-icon" style="color:var(--sys-primary,#0078d4);font-size:11px;" title="Available Offline (Fully Cached)"></i>';
  titleRow.appendChild(offlineIcon);

  info.appendChild(titleRow);

  const metaRow = document.createElement("div");
  metaRow.className = "ds-flex-row";
  metaRow.style.cssText = "flex-wrap:wrap;font-size:11px;";

  if (ch.seriesName && ch.seriesPermalink) {
    const seriesLink = document.createElement("span");
    seriesLink.className = "ds-series-link";
    seriesLink.textContent = decodeEntities(ch.seriesName);
    seriesLink.title = `Go to series: ${decodeEntities(ch.seriesName)}`;
    seriesLink.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "series",
        seriesPermalink: ch.seriesPermalink!,
        seriesName: ch.seriesName!,
      });
    });
    metaRow.appendChild(seriesLink);
  }

  const badgePages = document.createElement("span");
  badgePages.className = "ds-muted";
  badgePages.textContent = `✓ ${ch.pageCount} pages`;
  metaRow.appendChild(badgePages);

  if (ch.totalSizeBytes > 0) {
    const badgeSize = document.createElement("span");
    badgeSize.className = "ds-muted";
    badgeSize.textContent = `· ${formatBytes(ch.totalSizeBytes)}`;
    metaRow.appendChild(badgeSize);
  }

  if (ch.lastCachedAt > 0) {
    const badgeDate = document.createElement("span");
    badgeDate.className = "ds-muted";
    badgeDate.textContent = `· ${formatDate(ch.lastCachedAt)}`;
    metaRow.appendChild(badgeDate);
  }

  info.appendChild(metaRow);
  item.appendChild(info);

  // Read button
  const readBtn = document.createElement("button");
  readBtn.type = "button";
  readBtn.className = "win-button ds-btn-sm";
  readBtn.style.cssText = "font-size:11px;padding:2px 10px;flex-shrink:0;";
  readBtn.innerHTML = '<i class="bi bi-book"></i> Read';
  readBtn.title = `Read "${decodeEntities(ch.chapterTitle)}"`;

  const openChapter = () => {
    navigate({
      view: "reader",
      seriesPermalink: ch.seriesPermalink ?? undefined,
      seriesName: ch.seriesName ?? undefined,
      chapterPermalink: ch.chapterPermalink,
      chapterTitle: ch.chapterTitle,
    });
  };

  readBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openChapter();
  });

  item.addEventListener("click", openChapter);
  item.appendChild(readBtn);

  return item;
}
