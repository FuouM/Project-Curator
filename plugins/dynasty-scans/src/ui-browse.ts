/**
 * Browse view: Recent Releases / Recently Added feeds, Series & Tags
 * directories, a search typeahead (delegates to the user's browser), and a
 * "Open by URL" box for jumping straight to a series/chapter permalink.
 *
 * Permalinks are only ever taken from server JSON (feeds, directories) — never
 * guessed. Suggestions carry {id, name, type} only, so selecting one opens the
 * site's own search results in the default browser.
 */

import {
  Route,
  decodeEntities,
  formatDateTime,
  navigate,
  setBanner,
  tagClass,
  tagStyle,
} from "./state";
import {
  FeedChapter,
  DirectoryGroup,
  SuggestResult,
  directoryGroups,
  fetchDirectory,
  fetchFeed,
  fetchFeedWithRevalidation,
  checkFeedOnline,
  getLocalCover,
  getOrHydrateItemCover,
  openExternal,
  parseDynastyUrl,
  suggest,
} from "./api";
import {
  addBookmark,
  getBatchCached,
  getBookmarkPermalinks,
  getHistoryPermalinks,
  removeBookmark,
} from "./db";

const PH = window.PluginHost;

interface BrowseTab {
  id: string;
  label: string;
}

const TABS: BrowseTab[] = [
  { id: "releases", label: "Recent Releases" },
  { id: "added", label: "Recently Added" },
  { id: "series-dir", label: "Series Directory" },
  { id: "tags-dir", label: "Tags" },
];

const FEED_TAB_TO_URL: Record<string, string> = {
  releases: "/chapters.json",
  added: "/chapters/added.json",
};
const FEED_TAB_TO_KEY: Record<string, string> = {
  releases: "feed:releases",
  added: "feed:added",
};

export function renderBrowse(container: HTMLElement, route: Route): void {
  container.innerHTML = "";

  // ── Search + Open-by-URL ────────────────────────────────────────────────
  const searchBox = document.createElement("div");
  searchBox.className = "group-box";
  searchBox.style.cssText = "margin-bottom:8px;";
  searchBox.innerHTML =
    '<div class="group-box-title"><i class="bi bi-search"></i> Search &amp; Go</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;">' +
    '  <div class="ds-row">' +
    '    <div class="ds-search-wrap" style="flex:1;">' +
    '      <input type="text" class="input-field" id="ds-search-input"' +
    '        placeholder="Search dynasty-scans (opens in your browser)..." style="width:100%;" />' +
    '      <div class="ds-typeahead" id="ds-search-suggest" style="display:none;"></div>' +
    "    </div>" +
    '    <button type="button" class="win-button" id="ds-search-btn">' +
    '      <i class="bi bi-box-arrow-up-right"></i> Search' +
    "    </button>" +
    "  </div>" +
    '  <div class="ds-row">' +
    '    <input type="text" class="input-field" id="ds-url-input" style="flex:1;"' +
    '      placeholder="Paste a dynasty-scans.com series or chapter URL..." />' +
    '    <button type="button" class="win-button" id="ds-url-btn">' +
    '      <i class="bi bi-link-45deg"></i> Open Locally' +
    "    </button>" +
    "  </div>" +
    '  <div class="ds-muted" style="margin-top:2px;">' +
    "    Accepted: https://dynasty-scans.com/series/&lt;permalink&gt; or /chapters/&lt;permalink&gt; (or the .json form)." +
    "  </div>" +
    "</div>";
  container.appendChild(searchBox);

  // ── Sub-tabs ────────────────────────────────────────────────────────────
  const tabsRow = document.createElement("div");
  tabsRow.className = "ds-subtabs";
  container.appendChild(tabsRow);

  const content = document.createElement("div");
  content.id = "ds-browse-content";
  content.style.cssText = "margin-top:8px;";
  container.appendChild(content);

  const currentTab = route.browseTab ?? "releases";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `win-button ds-subtab${tab.id === currentTab ? " active" : ""}`;
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      route.browseTab = tab.id;
      for (const b of tabsRow.children) b.classList.remove("active");
      btn.classList.add("active");
      void renderTabContent(content, tab.id, 1);
    });
    tabsRow.appendChild(btn);
  }

  // ── Cover toggle (diagnostic) ───────────────────────────────────────────
  const coverToggleBtn = document.createElement("button");
  coverToggleBtn.type = "button";
  coverToggleBtn.id = "ds-cover-toggle";
  coverToggleBtn.className = "win-button ds-cover-toggle-btn";
  coverToggleBtn.title = "Toggle cover image loading (diagnostic)";
  const updateCoverToggleLabel = (): void => {
    coverToggleBtn.innerHTML = coversEnabled
      ? '<i class="bi bi-image"></i> Covers: ON'
      : '<i class="bi bi-image-slash"></i> Covers: OFF';
    coverToggleBtn.style.opacity = coversEnabled ? "1" : "0.5";
  };
  updateCoverToggleLabel();
  coverToggleBtn.addEventListener("click", () => {
    coversEnabled = !coversEnabled;
    try {
      localStorage.setItem("ds_covers_enabled", coversEnabled ? "true" : "false");
    } catch {}
    updateCoverToggleLabel();
    console.log(`[ds-covers] covers ${coversEnabled ? "enabled" : "disabled"} — re-rendering feed`);
    // Re-render the current tab so feedItem picks up the new flag.
    const activeTab = tabsRow.querySelector<HTMLButtonElement>(".ds-subtab.active");
    const activeTabId = activeTab?.dataset.tabId ?? currentTab;
    void renderTabContent(content, activeTabId, 1);
  });
  tabsRow.appendChild(coverToggleBtn);

  // Store tabId on each tab button so the toggle can re-render correctly.
  for (const btn of tabsRow.querySelectorAll<HTMLButtonElement>(".ds-subtab")) {
    const label = btn.textContent?.trim() ?? "";
    const tab = TABS.find((t) => t.label === label);
    if (tab) btn.dataset.tabId = tab.id;
  }

  // ── Typeahead + URL parsing wiring ─────────────────────────────────────
  const input = searchBox.querySelector<HTMLInputElement>("#ds-search-input");
  const suggestEl = searchBox.querySelector<HTMLElement>("#ds-search-suggest");
  const searchBtn = searchBox.querySelector<HTMLButtonElement>("#ds-search-btn");
  let debounceTimer: number | undefined;

  const runSearch = (): void => {
    const q = (input?.value ?? "").trim();
    if (!q) return;
    void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(q)}`);
  };

  searchBtn?.addEventListener("click", runSearch);
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runSearch();
  });
  input?.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    const q = (input.value ?? "").trim();
    if (!suggestEl) return;
    if (!q) {
      suggestEl.style.display = "none";
      return;
    }
    debounceTimer = window.setTimeout(() => {
      void loadSuggestions(q, suggestEl);
    }, 250);
  });
  input?.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (suggestEl) suggestEl.style.display = "none";
    }, 150);
  });

  const urlInput = searchBox.querySelector<HTMLInputElement>("#ds-url-input");
  const urlBtn = searchBox.querySelector<HTMLButtonElement>("#ds-url-btn");
  const openByUrl = (): void => {
    const raw = (urlInput?.value ?? "").trim();
    if (!raw) {
      setBanner("Paste a dynasty-scans.com series or chapter URL first.");
      return;
    }
    const parsed = parseDynastyUrl(raw);
    if (!parsed) {
      setBanner("Unrecognized URL. Use https://dynasty-scans.com/series/<permalink> or /chapters/<permalink>.");
      return;
    }
    if (parsed.kind === "chapter") {
      navigate({ view: "reader", chapterPermalink: parsed.permalink, chapterTitle: parsed.permalink });
    } else {
      navigate({ view: "series", seriesPermalink: parsed.permalink, seriesName: parsed.permalink });
    }
  };
  urlBtn?.addEventListener("click", openByUrl);
  urlInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") openByUrl();
  });

  void renderTabContent(content, currentTab, 1);
}

async function loadSuggestions(q: string, host: HTMLElement): Promise<void> {
  let results: SuggestResult[];
  try {
    results = await suggest(q);
  } catch (err) {
    host.style.display = "none";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Search suggestions failed: ${msg}`);
    return;
  }
  host.innerHTML = "";
  if (results.length === 0) {
    host.style.display = "none";
    return;
  }
  for (const r of results.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "ds-typeahead-item";
    const name = document.createElement("span");
    name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    name.textContent = decodeEntities(r.name);
    const type = document.createElement("span");
    type.className = "ds-typeahead-type";
    type.textContent = r.type;
    item.appendChild(name);
    item.appendChild(type);
    item.addEventListener("mousedown", () => {
      void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(r.name)}`);
    });
    host.appendChild(item);
  }
  host.style.display = "block";
}

async function renderTabContent(host: HTMLElement, tabId: string, page: number): Promise<void> {
  host.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading…";
  host.appendChild(loading);

  try {
    if (tabId === "releases" || tabId === "added") {
      await renderFeed(host, tabId, page);
    } else if (tabId === "series-dir") {
      await renderDirectory(host, "series", page);
    } else {
      await renderDirectory(host, "tags", page);
    }
  } catch (err) {
    host.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Browse failed: ${msg}`);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "win-button";
    retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
    retry.addEventListener("click", () => void renderTabContent(host, tabId, page));
    host.appendChild(retry);
  }
}

function pager(totalPages: number, currentPage: number, onPage: (p: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "ds-row";
  row.style.cssText = "margin-top:8px;";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "win-button";
  prev.style.cssText = "font-size:10px;padding:1px 8px;";
  prev.innerHTML = '<i class="bi bi-chevron-left"></i>';
  prev.disabled = currentPage <= 1;
  prev.addEventListener("click", () => onPage(currentPage - 1));
  const label = document.createElement("span");
  label.className = "ds-progress-text";
  label.textContent = `Page ${currentPage} of ${totalPages}`;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "win-button";
  next.style.cssText = "font-size:10px;padding:1px 8px;";
  next.innerHTML = '<i class="bi bi-chevron-right"></i>';
  next.disabled = currentPage >= totalPages;
  next.addEventListener("click", () => onPage(currentPage + 1));
  row.appendChild(prev);
  row.appendChild(label);
  row.appendChild(next);
  return row;
}

interface CoverTarget {
  coverKey: string;
  chapterPermalink: string;
  seriesPermalink: string | null;
  seriesType: string | null;
}

const feedCoverMemoryCache = new Map<string, string | null>();
const inflightCovers = new Map<string, Promise<string | null>>();
const coverHydrationQueue: CoverTarget[] = [];
const queuedCoverKeys = new Set<string>();
// Completed cover paths buffered during active scroll — flushed as a single RAF batch on idle.
const pendingDomUpdates: Array<{ coverKey: string; coverPath: string; host: HTMLElement }> = [];
const MAX_COVER_CONCURRENCY = 2;
let activeCoverWorkers = 0;
let currentHydrationHost: HTMLElement | null = null;
/** Diagnostic toggle — disables all cover image loading for A/B scroll testing. Persisted in localStorage. */
let coversEnabled = (() => {
  try {
    const saved = localStorage.getItem("ds_covers_enabled");
    return saved !== null ? saved === "true" : true;
  } catch {
    return true;
  }
})();
let coverLazyObserver: IntersectionObserver | null = null;
let isScrolling = false;
let scrollIdleTimer: number | null = null;
const SCROLL_IDLE_MS = 400; // conservative — covers only load when truly idle

function onScrollActive(): void {
  if (!isScrolling) {
    console.log("[ds-covers] scroll start — hydration paused");
    isScrolling = true;
  }
  if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
  scrollIdleTimer = window.setTimeout(() => {
    isScrolling = false;
    scrollIdleTimer = null;
    console.log(`[ds-covers] scroll idle — flushing ${pendingDomUpdates.length} buffered updates, queue=${coverHydrationQueue.length}`);
    flushPendingDomUpdates();
    pumpCoverHydration();
  }, SCROLL_IDLE_MS);
}

/**
 * Must be called from renderFeed to attach the scroll listener directly to #ds-view.
 * Also keeps a document-level capture listener as a belt-and-suspenders fallback.
 */
function attachScrollTracking(): void {
  // Primary: attach directly to the scrollable container so the event is guaranteed.
  const dsView = document.getElementById("ds-view");
  if (dsView) {
    dsView.addEventListener("scroll", onScrollActive, { passive: true });
  } else {
    console.warn("[ds-covers] #ds-view not found — scroll tracking may miss events");
  }
  // Fallback: document capture for any other scroll sources.
  document.addEventListener("scroll", onScrollActive, { capture: true, passive: true });
}

let scrollTrackingAttached = false;

function applyCoverToNode(node: HTMLElement, coverKey: string, coverPath: string): void {
  if (node.querySelector("img.ds-feed-cover")) return;
  node.innerHTML = "";
  const img = document.createElement("img");
  img.className = "ds-feed-cover";
  img.alt = coverKey;
  img.width = 42;
  img.height = 58;
  img.decoding = "async";
  img.src = PH.convertFileSrc(coverPath);
  img.addEventListener("error", () => {
    img.style.display = "none";
    const ph = document.createElement("div");
    ph.className = "ds-feed-cover-placeholder";
    ph.innerHTML = '<i class="bi bi-book"></i>';
    node.appendChild(ph);
  });
  node.appendChild(img);
}

function flushPendingDomUpdates(): void {
  if (pendingDomUpdates.length === 0) return;
  const updates = pendingDomUpdates.splice(0);
  requestAnimationFrame(() => {
    for (const { coverKey, coverPath, host } of updates) {
      if (host !== currentHydrationHost) continue;
      const nodes = host.querySelectorAll<HTMLElement>(`[data-feed-cover="${coverKey}"]`);
      for (const node of nodes) applyCoverToNode(node, coverKey, coverPath);
    }
  });
}

function scheduleCoverDomUpdate(coverKey: string, coverPath: string, host: HTMLElement): void {
  if (isScrolling) {
    // Buffer the update — will be flushed in a single RAF batch when scroll goes idle.
    pendingDomUpdates.push({ coverKey, coverPath, host });
    return;
  }
  requestAnimationFrame(() => {
    if (host !== currentHydrationHost) return;
    const nodes = host.querySelectorAll<HTMLElement>(`[data-feed-cover="${coverKey}"]`);
    for (const node of nodes) applyCoverToNode(node, coverKey, coverPath);
  });
}

function getCoverLazyObserver(): IntersectionObserver {
  if (!coverLazyObserver) {
    coverLazyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            coverLazyObserver?.unobserve(el);
            if (!coversEnabled) continue;

            const coverKey = el.dataset.feedCover;
            const chapterPermalink = el.dataset.chapterPermalink;
            const seriesPermalink = el.dataset.seriesPermalink;
            const seriesType = el.dataset.seriesType;

            if (coverKey) {
              const cached = feedCoverMemoryCache.get(coverKey);
              if (cached && currentHydrationHost) {
                scheduleCoverDomUpdate(coverKey, cached, currentHydrationHost);
              } else if (chapterPermalink && !queuedCoverKeys.has(coverKey)) {
                queuedCoverKeys.add(coverKey);
                coverHydrationQueue.push({
                  coverKey,
                  chapterPermalink,
                  seriesPermalink: seriesPermalink || null,
                  seriesType: seriesType || null,
                });
                if (!isScrolling) pumpCoverHydration();
              }
            }
          }
        }
      },
      { rootMargin: "150px" }
    );
  }
  return coverLazyObserver;
}

function reobserveUnloadedCovers(host: HTMLElement): void {
  if (!coversEnabled) return;
  const observer = getCoverLazyObserver();
  const unmountedWraps = host.querySelectorAll<HTMLElement>(".ds-feed-cover-wrap:not(:has(img.ds-feed-cover))");
  unmountedWraps.forEach((wrap) => observer.observe(wrap));
}

function pumpCoverHydration(): void {
  // Hard gate — no IPC work while scrolling.
  if (isScrolling || !currentHydrationHost || coverHydrationQueue.length === 0) return;

  console.log(`[ds-covers] pump: workers=${activeCoverWorkers}/${MAX_COVER_CONCURRENCY} queue=${coverHydrationQueue.length} scrolling=${isScrolling}`);

  while (!isScrolling && activeCoverWorkers < MAX_COVER_CONCURRENCY && coverHydrationQueue.length > 0) {
    // LIFO: prioritise covers closest to current viewport.
    const target = coverHydrationQueue.pop();
    if (!target) break;

    activeCoverWorkers++;
    const host = currentHydrationHost;
    console.log(`[ds-covers] worker start: ${target.coverKey}`);

    void (async () => {
      try {
        let task = inflightCovers.get(target.coverKey);
        if (!task) {
          task = getOrHydrateItemCover(
            target.coverKey,
            target.chapterPermalink,
            target.seriesPermalink,
            target.seriesType
          );
          inflightCovers.set(target.coverKey, task);
        }

        const coverPath = await task;
        feedCoverMemoryCache.set(target.coverKey, coverPath);
        console.log(`[ds-covers] worker done: ${target.coverKey} → ${coverPath ? "hit" : "miss"} isScrolling=${isScrolling}`);

        if (coverPath && host === currentHydrationHost) {
          scheduleCoverDomUpdate(target.coverKey, coverPath, host);
        }
      } catch (err) {
        console.warn(`[ds-covers] worker error: ${target.coverKey}`, err);
      } finally {
        inflightCovers.delete(target.coverKey);
        activeCoverWorkers--;
        // Yield one tick then resume if still idle.
        setTimeout(() => {
          if (!isScrolling) pumpCoverHydration();
        }, 0);
      }
    })();
  }
}

function getItemCoverInfo(ch: FeedChapter): {
  coverKey: string;
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  seriesType: string;
  isStandalone: boolean;
} {
  const seriesTag = (ch.tags ?? []).find((t) => {
    const type = (t.type ?? "").toLowerCase();
    return type === "series" || type === "doujin" || type === "doujinshi" || type === "anthology" || type === "issue";
  });
  const seriesPermalink = seriesTag?.permalink || (ch.series ? ch.series.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") : "");
  const seriesName = ch.series || seriesTag?.name || "";
  const seriesType = seriesTag?.type || "series";

  if (seriesPermalink) {
    return {
      coverKey: `series:${seriesPermalink}`,
      chapterPermalink: ch.permalink,
      seriesPermalink,
      seriesName,
      seriesType,
      isStandalone: false,
    };
  }

  return {
    coverKey: `chapter:${ch.permalink}`,
    chapterPermalink: ch.permalink,
    seriesPermalink: "",
    seriesName: "",
    seriesType: "",
    isStandalone: true,
  };
}

async function renderFeed(host: HTMLElement, tabId: string, page: number): Promise<void> {
  const url = `${FEED_TAB_TO_URL[tabId]}?page=${page}`;
  const key = `${FEED_TAB_TO_KEY[tabId]}:${page}`;
  const feedResult = await fetchFeedWithRevalidation(url, key);
  const feed = feedResult.data;
  const revalidatePromise = feedResult.revalidatePromise;
  host.innerHTML = "";

  if (!feed.chapters || feed.chapters.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "No chapters on this page.";
    host.appendChild(empty);
    return;
  }

  currentHydrationHost = host;
  coverHydrationQueue.length = 0; // reset queue for new page
  queuedCoverKeys.clear();
  pendingDomUpdates.length = 0; // discard any buffered updates from previous page
  if (coverLazyObserver) {
    coverLazyObserver.disconnect();
    coverLazyObserver = null;
  }

  // Attach scroll tracking to #ds-view on first ever feed render.
  if (!scrollTrackingAttached) {
    scrollTrackingAttached = true;
    attachScrollTracking();
    console.log("[ds-covers] scroll tracking attached to #ds-view");
  }

  const permalinks = feed.chapters.map((c) => c.permalink);
  let readSet = new Set<string>();
  let bookmarkSet = new Set<string>();
  try {
    const [h, b] = await Promise.all([
      getHistoryPermalinks(permalinks),
      getBookmarkPermalinks(permalinks),
    ]);
    readSet = h;
    bookmarkSet = b;
  } catch {
    readSet = new Set();
    bookmarkSet = new Set();
  }

  // Pre-load locally cached covers from SQLite in a single batch query (only if covers are enabled)
  if (coversEnabled) {
    const coverTargets = feed.chapters.map((c) => getItemCoverInfo(c));
    const uniqueCoverKeys = new Map<string, CoverTarget>();
    const keysToQuery: string[] = [];

    for (const ct of coverTargets) {
      if (!uniqueCoverKeys.has(ct.coverKey)) {
        uniqueCoverKeys.set(ct.coverKey, ct);
        if (!feedCoverMemoryCache.has(ct.coverKey)) {
          keysToQuery.push(`cover:${ct.coverKey}`);
        }
      }
    }

    if (keysToQuery.length > 0) {
      try {
        const cachedMap = await getBatchCached(keysToQuery);
        for (const [fullKey, payload] of cachedMap) {
          const rawKey = fullKey.replace(/^cover:/, "");
          if (payload) feedCoverMemoryCache.set(rawKey, payload);
        }
      } catch {}
    }
  }

  const currentTopPermalink = feed.chapters[0]?.permalink;

  for (const ch of feed.chapters) {
    host.appendChild(feedItem(ch, readSet.has(ch.permalink), bookmarkSet.has(ch.permalink)));
  }

  host.appendChild(
    pager(feed.total_pages, feed.current_page, (p) => void renderTabContent(host, tabId, p))
  );

  let currentEtag = feedResult.etag;

  const statusFooter = feedStatusFooter({
    cachedAt: feedResult.cachedAt,
    etag: currentEtag,
    status:
      feedResult.source === "sqlite"
        ? feedResult.isStale
          ? "Stale (Revalidating...)"
          : "SQLite (Cached)"
        : "Fresh (Dynasty Scans)",
    etagStatus: currentEtag ? "Cached" : "None",
    isStale: feedResult.isStale,
    onCheckUpdates: async (btn) => {
      btn.disabled = true;
      const prevHtml = btn.innerHTML;
      btn.innerHTML = '<i class="bi bi-arrow-clockwise ds-spin"></i> Checking...';
      try {
        const res = await checkFeedOnline(url, key, currentEtag);
        if (res.status === 304) {
          updateFeedStatusFooter(statusFooter, {
            cachedAt: Date.now(),
            etag: currentEtag,
            status: "Synced (304 Not Modified)",
            etagStatus: "Matches Server (304)",
            isStale: false,
          });
          btn.innerHTML = '<i class="bi bi-check-lg"></i> Up to Date';
          setTimeout(() => {
            btn.innerHTML = prevHtml;
            btn.disabled = false;
          }, 2000);
        } else if (res.status === 200 && res.data) {
          currentEtag = res.etag || currentEtag;
          updateFeedStatusFooter(statusFooter, {
            cachedAt: Date.now(),
            etag: currentEtag,
            status: "New releases available",
            etagStatus: "Updated (200 OK)",
            isStale: false,
          });
          showFeedUpdateBanner(host, tabId, page);
          btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Update Ready';
          btn.disabled = false;
        } else {
          btn.innerHTML = prevHtml;
          btn.disabled = false;
        }
      } catch (err) {
        console.warn("Manual check updates failed:", err);
        btn.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Failed';
        setTimeout(() => {
          btn.innerHTML = prevHtml;
          btn.disabled = false;
        }, 2000);
      }
    },
    onScrollTop: () => {
      const dsView = document.getElementById("ds-view");
      if (!dsView || dsView.scrollTop <= 0) return;

      // Disconnect observer during scroll to top so 20+ flying elements don't trigger observations
      if (coverLazyObserver) {
        coverLazyObserver.disconnect();
        coverLazyObserver = null;
      }
      coverHydrationQueue.length = 0;
      queuedCoverKeys.clear();
      pendingDomUpdates.length = 0;
      onScrollActive();

      dsView.scrollTo({ top: 0, behavior: "smooth" });

      let topTimer: number | null = null;
      const done = () => {
        dsView.removeEventListener("scroll", checkArrival);
        if (topTimer) {
          clearTimeout(topTimer);
          topTimer = null;
        }
        if (host === currentHydrationHost) {
          reobserveUnloadedCovers(host);
        }
      };

      const checkArrival = () => {
        if (dsView.scrollTop <= 0) done();
      };

      dsView.addEventListener("scroll", checkArrival, { passive: true });
      topTimer = window.setTimeout(done, 1500);
    },
  });
  host.appendChild(statusFooter);

  // Background revalidation: if new releases arrive, show a non-intrusive notification banner
  if (revalidatePromise) {
    void revalidatePromise.then((reval) => {
      if (host !== currentHydrationHost) return;
      if (reval) {
        currentEtag = reval.etag || currentEtag;
        const freshTop = reval.data.chapters?.[0]?.permalink;
        if (freshTop && freshTop !== currentTopPermalink) {
          showFeedUpdateBanner(host, tabId, page);
        }
        updateFeedStatusFooter(statusFooter, {
          cachedAt: Date.now(),
          etag: currentEtag,
          status: "Updated (200 OK)",
          etagStatus: "Updated (200 OK)",
          isStale: false,
        });
      } else {
        updateFeedStatusFooter(statusFooter, {
          cachedAt: feedResult.cachedAt,
          etag: currentEtag,
          status: "Synced (304 Not Modified)",
          etagStatus: "Matches Server (304)",
          isStale: false,
        });
      }
    });
  }
}

function feedStatusFooter(info: {
  cachedAt?: number;
  etag?: string;
  status: string;
  etagStatus?: string;
  isStale: boolean;
  onCheckUpdates: (btn: HTMLButtonElement) => Promise<void>;
  onScrollTop: () => void;
}): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "ds-feed-status-bar";
  footer.innerHTML = `
    <div class="ds-feed-status-left">
      <span class="ds-status-item ds-status-db" title="Timestamp when metadata was stored in local SQLite database">
        <i class="bi bi-database"></i> DB Cache: <b>${formatDateTime(info.cachedAt)}</b>
      </span>
      <span class="ds-status-item ds-status-state" title="Current cache state">
        <i class="bi bi-hdd-network"></i> Status: <span class="ds-status-pill ${info.isStale ? "stale" : "fresh"}">${info.status}</span>
      </span>
      <span class="ds-status-item ds-status-etag-wrap" title="HTTP ETag conditional caching status">
        <i class="bi bi-shield-check"></i> ETag: <span class="ds-etag-status-label">${info.etagStatus || "Cached"}</span>
        ${
          info.etag
            ? `<span class="ds-etag-tag" title="HTTP ETag: ${info.etag}"><i class="bi bi-hash"></i> ${info.etag.replace(/^"|"$/g, "").slice(0, 8)}</span>`
            : ""
        }
      </span>
    </div>
    <div class="ds-feed-status-right">
      <button type="button" class="win-button ds-status-refresh-btn" title="Force check for updates online without reloading page">
        <i class="bi bi-arrow-clockwise"></i> Check Updates
      </button>
      <button type="button" class="win-button ds-scroll-top-btn" title="Scroll to top of list">
        <i class="bi bi-arrow-up"></i> Top
      </button>
    </div>
  `;

  const checkBtn = footer.querySelector<HTMLButtonElement>(".ds-status-refresh-btn");
  checkBtn?.addEventListener("click", () => {
    void info.onCheckUpdates(checkBtn);
  });

  const topBtn = footer.querySelector<HTMLButtonElement>(".ds-scroll-top-btn");
  topBtn?.addEventListener("click", () => {
    info.onScrollTop();
  });

  return footer;
}

function updateFeedStatusFooter(
  footer: HTMLElement,
  info: {
    cachedAt?: number;
    etag?: string;
    status: string;
    etagStatus?: string;
    isStale: boolean;
  }
): void {
  const dbEl = footer.querySelector(".ds-status-db b");
  if (dbEl && info.cachedAt) {
    dbEl.textContent = formatDateTime(info.cachedAt);
  }
  const stateEl = footer.querySelector(".ds-status-pill");
  if (stateEl) {
    stateEl.className = `ds-status-pill ${info.isStale ? "stale" : "fresh"}`;
    stateEl.textContent = info.status;
  }
  const etagStatusLabel = footer.querySelector(".ds-etag-status-label");
  if (etagStatusLabel && info.etagStatus) {
    etagStatusLabel.textContent = info.etagStatus;
  }
  if (info.etag) {
    let etagEl = footer.querySelector(".ds-etag-tag");
    if (!etagEl) {
      const etagWrap = footer.querySelector(".ds-status-etag-wrap");
      if (etagWrap) {
        etagEl = document.createElement("span");
        etagEl.className = "ds-etag-tag";
        etagWrap.appendChild(etagEl);
      }
    }
    if (etagEl) {
      etagEl.setAttribute("title", `HTTP ETag: ${info.etag}`);
      etagEl.innerHTML = `<i class="bi bi-hash"></i> ${info.etag.replace(/^"|"$/g, "").slice(0, 8)}`;
    }
  }
}

function showFeedUpdateBanner(host: HTMLElement, tabId: string, page: number): void {
  if (host.querySelector(".ds-feed-update-banner")) return;
  const banner = document.createElement("div");
  banner.className = "ds-feed-update-banner";
  banner.innerHTML = `
    <button type="button" class="win-button ds-feed-update-btn">
      <i class="bi bi-arrow-clockwise"></i> New chapters available — Click to update
    </button>
  `;
  const btn = banner.querySelector("button");
  btn?.addEventListener("click", () => {
    void renderTabContent(host, tabId, page);
  });
  host.insertBefore(banner, host.firstChild);
}

function tagPill(t: { type: string; name: string; permalink?: string }): HTMLElement {
  const pill = document.createElement("span");
  pill.className = tagClass(t.type, t.name);
  pill.style.cssText = tagStyle(t.type, t.name) + "font-size:10px;padding:1px 6px;border-radius:2px;";
  pill.textContent = t.name;
  pill.title = `${t.type}: ${t.name} (click to open)`;

  pill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const type = (t.type ?? "").toLowerCase();
    if (type === "series" || type === "anthology" || type === "issue") {
      navigate({
        view: "series",
        seriesPermalink: t.permalink || t.name,
        seriesName: t.name,
      });
      return;
    }

    let url = "";
    if (type === "author" || type === "artist") {
      url = t.permalink
        ? `https://dynasty-scans.com/authors/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "scanlator" || type === "group") {
      url = t.permalink
        ? `https://dynasty-scans.com/scanlators/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "doujin" || type === "doujinshi" || type === "copyright" || type === "parody") {
      url = t.permalink
        ? `https://dynasty-scans.com/doujins/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "pairing") {
      url = t.permalink
        ? `https://dynasty-scans.com/pairings/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else {
      url = t.permalink
        ? `https://dynasty-scans.com/tags/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    }
    void openExternal(url);
  });

  return pill;
}

function feedItem(ch: FeedChapter, isRead = false, isBookmarked = false): HTMLElement {
  const item = document.createElement("div");
  item.className = `ds-item${isRead ? " ds-item-read" : ""}`;
  item.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 8px;";

  const coverInfo = getItemCoverInfo(ch);

  // Left cover thumbnail container
  const coverWrap = document.createElement("div");
  coverWrap.className = "ds-feed-cover-wrap";
  coverWrap.style.cssText = "flex-shrink:0;cursor:pointer;";
  coverWrap.dataset.feedCover = coverInfo.coverKey;
  coverWrap.dataset.chapterPermalink = coverInfo.chapterPermalink;
  coverWrap.dataset.seriesPermalink = coverInfo.seriesPermalink;
  coverWrap.dataset.seriesType = coverInfo.seriesType || "";

  if (!coverInfo.isStandalone) {
    coverWrap.title = `View series: ${decodeEntities(coverInfo.seriesName || coverInfo.seriesPermalink)}`;
    coverWrap.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "series",
        seriesPermalink: coverInfo.seriesPermalink,
        seriesName: coverInfo.seriesName || coverInfo.seriesPermalink,
      });
    });
  } else {
    coverWrap.title = `Read "${decodeEntities(ch.title)}"`;
    coverWrap.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "reader",
        chapterPermalink: ch.permalink,
        chapterTitle: ch.title,
      });
    });
  }

  const ph = document.createElement("div");
  ph.className = "ds-feed-cover-placeholder";
  ph.innerHTML = '<i class="bi bi-book"></i>';
  coverWrap.appendChild(ph);

  if (coversEnabled) {
    getCoverLazyObserver().observe(coverWrap);
  }
  item.appendChild(coverWrap);

  const info = document.createElement("div");
  info.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;";

  const title = document.createElement("div");
  title.className = "ds-item-title";
  title.style.cssText = "font-weight:600;";
  title.textContent = decodeEntities(ch.title);
  info.appendChild(title);

  const metaRow = document.createElement("div");
  metaRow.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  if (ch.series) {
    const seriesLink = document.createElement("span");
    seriesLink.className = "ds-series-link";
    seriesLink.textContent = decodeEntities(ch.series);
    seriesLink.title = `Go to series: ${decodeEntities(ch.series)}`;
    seriesLink.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "series",
        seriesPermalink: coverInfo.seriesPermalink || ch.series,
        seriesName: ch.series,
      });
    });
    metaRow.appendChild(seriesLink);
  }

  const tags = (ch.tags ?? []).filter((t) => (t.type ?? "").toLowerCase() !== "series").slice(0, 8);
  for (const t of tags) {
    metaRow.appendChild(tagPill(t));
  }
  info.appendChild(metaRow);

  let bookmarked = isBookmarked;
  const bookmarkBtn = document.createElement("button");
  bookmarkBtn.type = "button";
  bookmarkBtn.className = `win-button${bookmarked ? " primary" : ""}`;
  bookmarkBtn.style.cssText = "font-size:11px;padding:2px 8px;flex-shrink:0;";
  bookmarkBtn.title = bookmarked ? "Remove from Read Later" : "Save for Read Later";
  bookmarkBtn.innerHTML = bookmarked
    ? '<i class="bi bi-bookmark-fill"></i> Saved'
    : '<i class="bi bi-bookmark-plus"></i> Read Later';

  bookmarkBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    bookmarkBtn.disabled = true;
    try {
      if (bookmarked) {
        await removeBookmark(ch.permalink);
        bookmarked = false;
        bookmarkBtn.className = "win-button";
        bookmarkBtn.innerHTML = '<i class="bi bi-bookmark-plus"></i> Read Later';
        bookmarkBtn.title = "Save for Read Later";
        setBanner(`Removed "${ch.title}" from bookmarks.`);
      } else {
        await addBookmark({
          chapterPermalink: ch.permalink,
          seriesPermalink: "",
          seriesName: ch.series ?? "",
          chapterTitle: ch.title,
          pageIndex: 0,
        });
        bookmarked = true;
        bookmarkBtn.className = "win-button primary";
        bookmarkBtn.innerHTML = '<i class="bi bi-bookmark-fill"></i> Saved';
        bookmarkBtn.title = "Remove from Read Later";
        setBanner(`Saved "${ch.title}" to Read Later!`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBanner(`Bookmark failed: ${msg}`);
    }
    bookmarkBtn.disabled = false;
  });

  const extBtn = document.createElement("button");
  extBtn.type = "button";
  extBtn.className = "win-button";
  extBtn.style.cssText = "font-size:11px;padding:2px 6px;flex-shrink:0;";
  extBtn.title = `Open "${decodeEntities(ch.title)}" on Dynasty Scans in browser`;
  extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
  extBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openExternal(`https://dynasty-scans.com/chapters/${ch.permalink}`);
  });

  item.appendChild(info);
  item.appendChild(bookmarkBtn);
  item.appendChild(extBtn);

  item.addEventListener("click", () => {
    navigate({
      view: "reader",
      chapterPermalink: ch.permalink,
      chapterTitle: ch.title,
      seriesName: ch.series,
    });
  });
  return item;
}

async function renderDirectory(host: HTMLElement, kind: "series" | "tags", page: number): Promise<void> {
  const url = kind === "series" ? `/series.json?page=${page}` : `/tags.json?page=${page}`;
  const key = `${kind === "series" ? "dir:series" : "dir:tags"}:${page}`;
  const dir = await fetchDirectory(url, key);
  const groups: DirectoryGroup[] = directoryGroups(dir);
  host.innerHTML = "";

  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "No entries on this page.";
    host.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const header = document.createElement("div");
    header.className = "ds-vol-header";
    header.textContent = group.letter;
    host.appendChild(header);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;";
    for (const entry of group.entries) {
      const item = document.createElement("div");
      item.className = "ds-item";
      item.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:3px 6px;";
      const title = document.createElement("div");
      title.className = "ds-item-title";
      title.style.cssText = "flex:1;min-width:0;cursor:pointer;";
      title.textContent = decodeEntities(entry.name);
      item.appendChild(title);

      const extBtn = document.createElement("button");
      extBtn.type = "button";
      extBtn.className = "win-button";
      extBtn.style.cssText = "font-size:10px;padding:1px 5px;flex-shrink:0;";
      extBtn.title = kind === "series" ? "Open series in browser" : "Search tag in browser";
      extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
      extBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (kind === "series") {
          openExternal(`https://dynasty-scans.com/series/${entry.permalink}`);
        } else {
          openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(entry.name)}`);
        }
      });
      item.appendChild(extBtn);

      if (kind === "series") {
        title.addEventListener("click", () => {
          navigate({
            view: "series",
            seriesPermalink: entry.permalink,
            seriesName: entry.name,
          });
        });
      } else {
        title.addEventListener("click", () => {
          void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(entry.name)}`);
        });
      }
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  host.appendChild(
    pager(dir.total_pages, dir.current_page, (p) => void renderTabContent(host, kind === "series" ? "series-dir" : "tags-dir", p))
  );
}