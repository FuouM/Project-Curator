/**
 * Cache Management View: Full dedicated view for inspecting storage statistics,
 * disk space usage, cached series/chapters, and executing granular or bulk cleanup.
 */

import {
  Route,
  decodeEntities,
  formatBytes,
  formatDate,
  navigate,
  setActions,
  setBanner,
} from "./state";
import {
  clearAllCacheStorage,
  clearAllCachedPages,
  clearAllCachedCovers,
  clearCachedGroupPages,
  getCacheOverviewStats,
  getCachedSeriesGroups,
} from "./db";
import { createConfirmDeleteButton } from "./components/button";
import { renderFeedCover } from "./components/cover";
import { browseCovers } from "./browse/browse-covers";
import { renderLoading } from "./components/loading";

export function renderCache(container: HTMLElement, _route: Route): void {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.id = "ds-cache-view-container";
  root.style.cssText =
    "display:flex;flex-direction:column;gap:12px;padding:8px 4px;width:100%;box-sizing:border-box;";
  container.appendChild(root);

  const loadView = async (): Promise<void> => {
    root.innerHTML = "";
    root.appendChild(renderLoading());

    try {
      const [stats, groups] = await Promise.all([getCacheOverviewStats(), getCachedSeriesGroups()]);
      root.innerHTML = "";

      // Setup Top Bar Actions
      setActions((host) => {
        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.className = "win-button";
        backBtn.style.cssText = "font-size:11px;padding:2px 8px;";
        backBtn.innerHTML = '<i class="bi bi-arrow-left"></i> Back to Library';
        backBtn.addEventListener("click", () => navigate({ view: "library" }));
        host.appendChild(backBtn);

        const refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.className = "win-button";
        refreshBtn.style.cssText = "font-size:11px;padding:2px 8px;";
        refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Refresh';
        refreshBtn.addEventListener("click", () => void loadView());
        host.appendChild(refreshBtn);
      });

      // 1. Overview Storage Metrics Grid
      const statsBox = document.createElement("div");
      statsBox.className = "group-box";
      const statsHead = document.createElement("div");
      statsHead.className = "group-box-title";
      statsHead.innerHTML = '<i class="bi bi-pie-chart"></i> Disk Space &amp; Storage Overview';
      statsBox.appendChild(statsHead);

      const statsGrid = document.createElement("div");
      statsGrid.className = "ds-stats-grid";
      statsGrid.style.cssText = "grid-template-columns: repeat(4, 1fr);";

      const diskCard = document.createElement("div");
      diskCard.className = "ds-stat-card";
      diskCard.innerHTML = `<span class="ds-stat-val">${formatBytes(stats.totalSizeBytes)}</span><span class="ds-stat-lbl">Disk Space Taken</span>`;
      statsGrid.appendChild(diskCard);

      const pagesCard = document.createElement("div");
      pagesCard.className = "ds-stat-card";
      pagesCard.innerHTML = `<span class="ds-stat-val">${stats.totalCachedPages}</span><span class="ds-stat-lbl">Cached Page Scans</span>`;
      statsGrid.appendChild(pagesCard);

      const chCard = document.createElement("div");
      chCard.className = "ds-stat-card";
      chCard.innerHTML = `<span class="ds-stat-val">${stats.totalCachedChapters}</span><span class="ds-stat-lbl">Cached Chapters</span>`;
      statsGrid.appendChild(chCard);

      const seriesCard = document.createElement("div");
      seriesCard.className = "ds-stat-card";
      seriesCard.innerHTML = `<span class="ds-stat-val">${groups.length}</span><span class="ds-stat-lbl">Cached Works</span>`;
      statsGrid.appendChild(seriesCard);

      statsBox.appendChild(statsGrid);
      root.appendChild(statsBox);

      // 2. Global Quick Actions
      const actBox = document.createElement("div");
      actBox.className = "group-box";
      const actHead = document.createElement("div");
      actHead.className = "group-box-title";
      actHead.innerHTML = '<i class="bi bi-tools"></i> Global Maintenance';
      actBox.appendChild(actHead);

      const actRow = document.createElement("div");
      actRow.className = "ds-cache-actions";

      const clearAllBtn = createConfirmDeleteButton(
        "Purge all cached pages, covers, and metadata",
        async () => {
          await clearAllCacheStorage();
          browseCovers.clearMemoryCache();
          setBanner("All cache storage successfully purged.");
          await loadView();
        },
        '<i class="bi bi-trash3"></i> Clear All Cache Storage',
      );
      actRow.appendChild(clearAllBtn);

      const clearPagesBtn = createConfirmDeleteButton(
        "Purge only high-res reader page scans on disk",
        async () => {
          await clearAllCachedPages();
          setBanner("All cached reader page scans cleared.");
          await loadView();
        },
        '<i class="bi bi-images"></i> Clear Page Scans Only',
      );
      actRow.appendChild(clearPagesBtn);

      const clearCoversBtn = createConfirmDeleteButton(
        "Purge only cached cover thumbnails on disk",
        async () => {
          await clearAllCachedCovers();
          browseCovers.clearMemoryCache();
          setBanner("All cached covers cleared.");
          await loadView();
        },
        '<i class="bi bi-card-image"></i> Clear Cached Covers Only',
      );
      actRow.appendChild(clearCoversBtn);

      actBox.appendChild(actRow);
      root.appendChild(actBox);

      // 3. Granular Cached Works Section
      const listBox = document.createElement("div");
      listBox.className = "group-box";
      listBox.style.cssText = "display:flex;flex-direction:column;";
      const listHead = document.createElement("div");
      listHead.className = "group-box-title";
      listHead.innerHTML = `<i class="bi bi-collection"></i> Cached Works &amp; Series (${groups.length})`;
      listBox.appendChild(listHead);

      if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ds-muted";
        empty.style.cssText = "padding:24px;text-align:center;";
        empty.textContent = "No cached chapters or series found on disk.";
        listBox.appendChild(empty);
      } else {
        const toolbar = document.createElement("div");
        toolbar.style.cssText =
          "display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;";

        const filterInput = document.createElement("input");
        filterInput.type = "text";
        filterInput.className = "win-textbox";
        filterInput.placeholder = "Filter cached works by name or permalink...";
        filterInput.style.cssText = "flex:1;min-width:200px;font-size:11px;padding:3px 6px;";

        const sortWrap = document.createElement("div");
        sortWrap.className = "ds-flex-row";

        const sortLabel = document.createElement("span");
        sortLabel.className = "ds-item-meta";
        sortLabel.style.cssText = "font-size:11px;white-space:nowrap;";
        sortLabel.textContent = "Sort by:";

        const sortSelect = document.createElement("select");
        sortSelect.className = "win-textbox";
        sortSelect.style.cssText = "font-size:11px;padding:2px 6px;cursor:pointer;";
        sortSelect.innerHTML = `
          <option value="size-desc">Disk Size (Largest first)</option>
          <option value="size-asc">Disk Size (Smallest first)</option>
          <option value="date-desc">Date Cached (Newest first)</option>
          <option value="date-asc">Date Cached (Oldest first)</option>
          <option value="pages-desc">Page Count (Most pages)</option>
          <option value="name-asc">Title (A → Z)</option>
        `;

        sortWrap.appendChild(sortLabel);
        sortWrap.appendChild(sortSelect);

        toolbar.appendChild(filterInput);
        toolbar.appendChild(sortWrap);

        const listEl = document.createElement("div");
        listEl.className = "ds-cache-list";
        listEl.style.cssText = "max-height:none;";

        const renderItems = (): void => {
          listEl.innerHTML = "";
          const ft = filterInput.value.toLowerCase().trim();
          const sortMode = sortSelect.value;

          const filtered = groups.filter(
            (g) =>
              g.seriesName.toLowerCase().includes(ft) ||
              g.seriesPermalink.toLowerCase().includes(ft),
          );

          filtered.sort((a, b) => {
            switch (sortMode) {
              case "size-desc":
                return b.totalSizeBytes - a.totalSizeBytes;
              case "size-asc":
                return a.totalSizeBytes - b.totalSizeBytes;
              case "date-asc":
                return a.lastCachedAt - b.lastCachedAt;
              case "date-desc":
                return b.lastCachedAt - a.lastCachedAt;
              case "pages-desc":
                return b.pageCount - a.pageCount;
              case "name-asc":
                return a.seriesName.localeCompare(b.seriesName);
              default:
                return b.totalSizeBytes - a.totalSizeBytes;
            }
          });

          if (filtered.length === 0) {
            const noMatch = document.createElement("div");
            noMatch.className = "ds-muted";
            noMatch.style.cssText = "padding:12px;";
            noMatch.textContent = "No matching cached works found.";
            listEl.appendChild(noMatch);
            return;
          }

          for (const item of filtered) {
            const row = document.createElement("div");
            row.className = "ds-cache-item";
            row.style.cssText = "padding:8px 10px;";

            // Cover thumbnail
            if (item.coverPath) {
              const img = renderFeedCover(
                item.coverPath,
                item.seriesName,
                "width:36px;height:50px;cursor:pointer;",
              );
              img.title = "Click to view";
              img.addEventListener("click", () => {
                if (item.isStandalone) {
                  navigate({
                    view: "reader",
                    chapterPermalink: item.seriesPermalink,
                    chapterTitle: item.seriesName,
                  });
                } else {
                  navigate({
                    view: "series",
                    seriesPermalink: item.seriesPermalink,
                    seriesName: item.seriesName,
                  });
                }
              });
              row.appendChild(img);
            } else {
              const ph = renderFeedCover(
                null,
                item.seriesName,
                "width:36px;height:50px;font-size:12px;",
              );
              ph.innerHTML = '<i class="bi bi-book"></i>';
              row.appendChild(ph);
            }

            // Info
            const info = document.createElement("div");
            info.className = "ds-fill";
            const name = document.createElement("div");
            name.style.cssText = "font-size:12px;font-weight:600;cursor:pointer;";
            name.textContent = decodeEntities(item.seriesName);
            name.addEventListener("click", () => {
              if (item.isStandalone) {
                navigate({
                  view: "reader",
                  chapterPermalink: item.seriesPermalink,
                  chapterTitle: item.seriesName,
                });
              } else {
                navigate({
                  view: "series",
                  seriesPermalink: item.seriesPermalink,
                  seriesName: item.seriesName,
                });
              }
            });

            const meta = document.createElement("div");
            meta.className = "ds-item-meta";
            meta.innerHTML = `<strong>${formatBytes(item.totalSizeBytes)}</strong> · ${item.chapterCount} chapter${item.chapterCount > 1 ? "s" : ""} · ${item.pageCount} page${item.pageCount > 1 ? "s" : ""} cached · Cached ${formatDate(item.lastCachedAt)}`;

            info.appendChild(name);
            info.appendChild(meta);
            row.appendChild(info);

            // Delete item button
            const delBtn = createConfirmDeleteButton(
              `Delete all cached files for "${item.seriesName}"`,
              async () => {
                await clearCachedGroupPages(item.chapterPermalinks);
                setBanner(`Cleared cache for "${item.seriesName}".`);
                await loadView();
              },
            );
            row.appendChild(delBtn);

            listEl.appendChild(row);
          }
        };

        filterInput.addEventListener("input", () => renderItems());
        sortSelect.addEventListener("change", () => renderItems());
        renderItems();

        listBox.appendChild(toolbar);
        listBox.appendChild(listEl);
      }

      root.appendChild(listBox);
    } catch (err) {
      root.innerHTML = "";
      const errEl = document.createElement("div");
      errEl.className = "ds-muted";
      errEl.textContent = `Failed to load cache statistics: ${err instanceof Error ? err.message : String(err)}`;
      root.appendChild(errEl);
    }
  };

  void loadView();
}
