import { decodeEntities, formatDateTime, navigate, setBanner } from "../state";
import { checkFeedOnline, fetchFeedWithRevalidation, openExternal } from "../api";
import {
  addBookmark,
  getBookmarkPermalinks,
  getCached,
  getHistoryPermalinks,
  removeBookmark,
} from "../db";
import { renderTagPill } from "../components/tag-pill";
import { renderPager } from "../components/pager";
import { browseCovers } from "./browse-covers";
import type { Feed, FeedChapter } from "../types/api";

export const FEED_TAB_TO_URL: Record<string, string> = {
  releases: "/chapters.json",
  added: "/chapters/added.json",
};
export const FEED_TAB_TO_KEY: Record<string, string> = {
  releases: "feed:releases",
  added: "feed:added",
};

export interface FeedTabReload {
  (host: HTMLElement, tabId: string, page: number): Promise<void>;
}

/**
 * Renders one releases/added feed page: cache-first feed data, per-item read/
 * bookmark state, lazy cover hydration, a revalidation status footer, and a
 * background ETag revalidation banner.
 */
export async function renderFeed(
  host: HTMLElement,
  tabId: string,
  page: number,
  reload: FeedTabReload,
): Promise<void> {
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

  browseCovers.beginPage(host);

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
  if (browseCovers.coversEnabled) {
    const coverTargets = feed.chapters.map((c) => browseCovers.getItemCoverInfo(c));
    await browseCovers.preloadBatch(coverTargets);
  }

  const currentTopPermalink = feed.chapters[0]?.permalink;

  for (const ch of feed.chapters) {
    host.appendChild(feedItem(ch, readSet.has(ch.permalink), bookmarkSet.has(ch.permalink)));
  }

  host.appendChild(
    renderPager(feed.total_pages, feed.current_page, (p) => void reload(host, tabId, p)),
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
        const head = await revalidateFeedHead(tabId);
        if (head.status === "new-chapters") {
          currentEtag = head.etag || currentEtag;
          updateFeedStatusFooter(statusFooter, {
            cachedAt: Date.now(),
            etag: currentEtag,
            status: "New releases available",
            etagStatus: "Updated (200 OK)",
            isStale: false,
          });
          showFeedUpdateBanner(host, tabId, reload);
          btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> Update Ready';
          btn.disabled = false;
        } else if (head.status === "unchanged") {
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
        } else {
          // no-baseline / error: nothing to compare against — keep the footer
          // as-is and just restore the button (no banner, no false claims).
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

      // Disconnect observer + pause pumps during the animation so 20+ flying
      // elements never trigger observations. Keep hydration paused until the
      // scroll has genuinely settled (scrollend / arrival / poll guard).
      browseCovers.scrollToTop();

      dsView.scrollTo({ top: 0, behavior: "smooth" });

      let settled = false;
      let topTimer: number | null = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        dsView.removeEventListener("scroll", checkArrival);
        dsView.removeEventListener("scrollend", settle);
        if (topTimer !== null) {
          window.clearInterval(topTimer);
          topTimer = null;
        }
        if (host === browseCovers.currentHydrationHost) {
          browseCovers.resumeAfterScrollToTop(host);
        }
      };

      const checkArrival = () => {
        if (dsView.scrollTop <= 0) settle();
      };

      dsView.addEventListener("scrollend", settle, { passive: true });
      dsView.addEventListener("scroll", checkArrival, { passive: true });
      // Poll guard: never re-arm the observer while the view is still moving
      // (the original 1500ms one-shot could fire mid-animation on long feeds).
      topTimer = window.setInterval(() => {
        if (dsView.scrollTop <= 0) settle();
      }, 200);
    },
  });
  host.appendChild(statusFooter);

  // Background revalidation (stale-while-revalidate). The footer reports the
  // current page's own freshness, but the "new chapters available" banner is
  // driven by the feed HEAD (page 1, position 0) — the only place new releases
  // ever land. Comparing a deeper page's top against its cached copy fires on
  // mere list-shifting, so the banner never uses the viewed page's data.
  if (page === 1 && revalidatePromise) {
    // The viewed page IS the head: reuse the in-flight page-1 revalidation.
    void revalidatePromise.then((reval) => {
      if (host !== browseCovers.currentHydrationHost) return;
      if (reval) {
        currentEtag = reval.etag || currentEtag;
        const freshTop = reval.data.chapters?.[0]?.permalink;
        if (freshTop && freshTop !== currentTopPermalink) {
          showFeedUpdateBanner(host, tabId, reload);
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
  } else if (revalidatePromise) {
    // Deeper page: keep the viewed page's cache fresh for its footer, but never
    // let its shifted top drive the banner. New chapters are detected against
    // the head separately.
    void revalidatePromise.then((reval) => {
      if (host !== browseCovers.currentHydrationHost) return;
      if (reval) {
        currentEtag = reval.etag || currentEtag;
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
    void revalidateFeedHead(tabId).then((head) => {
      if (host !== browseCovers.currentHydrationHost) return;
      if (head.hasNew) showFeedUpdateBanner(host, tabId, reload);
    });
  }
}

/**
 * Revalidates the feed HEAD (page 1) to detect genuinely new chapters.
 *
 * New releases always land at position 0 of page 1, so this is the only page
 * whose top permalink can signal "new chapters". `hasNew` is true when the
 * fresh head differs from the last cached head. A deeper page revalidating
 * 200 simply means its contents shifted — never a new-chapters signal.
 */
async function revalidateFeedHead(tabId: string): Promise<{
  hasNew: boolean;
  etag?: string;
  status: "unchanged" | "new-chapters" | "no-baseline" | "error";
}> {
  const url = FEED_TAB_TO_URL[tabId]; // head = page 1
  const key = `${FEED_TAB_TO_KEY[tabId]}:1`;
  const cached = await getCached(key);
  const cachedTop = cached ? parseFeedTop(cached.json_payload) : undefined;
  try {
    const res = await checkFeedOnline(url, key, cached?.etag);
    if (res.status === 200 && res.data) {
      const freshTop = res.data.chapters?.[0]?.permalink;
      if (cachedTop !== undefined && freshTop && freshTop !== cachedTop) {
        return { hasNew: true, etag: res.etag, status: "new-chapters" };
      }
      return {
        hasNew: false,
        etag: res.etag,
        status: cachedTop === undefined ? "no-baseline" : "unchanged",
      };
    }
    if (res.status === 304) {
      return { hasNew: false, etag: res.etag ?? cached?.etag, status: "unchanged" };
    }
    return { hasNew: false, etag: cached?.etag, status: "error" };
  } catch {
    return { hasNew: false, etag: cached?.etag, status: "error" };
  }
}

/** First chapter permalink from a cached feed payload, or undefined. */
function parseFeedTop(json: string): string | undefined {
  try {
    return (JSON.parse(json) as Feed).chapters?.[0]?.permalink;
  } catch {
    return undefined;
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
  },
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

function showFeedUpdateBanner(host: HTMLElement, tabId: string, reload: FeedTabReload): void {
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
    // New chapters always land at the head of the feed, so "update" must jump
    // to page 1 — reloading the current deeper page would not surface them.
    void reload(host, tabId, 1);
  });
  host.insertBefore(banner, host.firstChild);
}

function feedItem(ch: FeedChapter, isRead = false, isBookmarked = false): HTMLElement {
  const item = document.createElement("div");
  item.className = `ds-item ds-feed-item${isRead ? " ds-item-read" : ""}`;
  item.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 8px;";

  const coverInfo = browseCovers.getItemCoverInfo(ch);

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

  browseCovers.observe(coverWrap);
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
    metaRow.appendChild(renderTagPill(t));
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
