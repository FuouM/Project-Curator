import { getOrHydrateItemCover } from "../api";
import { getBatchCached, deleteCached } from "../db";
import type { FeedChapter } from "../types/api";

const PH = window.PluginHost;

export interface CoverTarget {
  coverKey: string;
  chapterPermalink: string;
  seriesPermalink: string | null;
  seriesType: string | null;
}

export interface ItemCoverInfo {
  coverKey: string;
  chapterPermalink: string;
  seriesPermalink: string;
  seriesName: string;
  seriesType: string;
  isStandalone: boolean;
}

interface PendingDomUpdate {
  coverKey: string;
  coverPath: string;
  host: HTMLElement;
}

const SCROLL_IDLE_MS = 400; // conservative — covers only load when truly idle

/**
 * Feed cover-hydration engine. Singleton instance because only one feed view is
 * ever rendered at a time and the lazy observers live for the plugin's lifetime.
 *
 * Diagnostics: a persisted `coversEnabled` toggle disables all cover imagery for
 * A/B scroll testing.
 */
export class BrowseCovers {
  private readonly memoryCache = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly queue: CoverTarget[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly pendingDomUpdates: PendingDomUpdate[] = [];
  private readonly MAX_CONCURRENCY = 2;
  private activeWorkers = 0;
  private hydrationHost: HTMLElement | null = null;
  private enabled: boolean;
  private lazyObserver: IntersectionObserver | null = null;
  private isScrolling = false;
  private scrollIdleTimer: number | null = null;
  private scrollTrackingAttached = false;

  constructor() {
    try {
      const saved = localStorage.getItem("ds_covers_enabled");
      this.enabled = saved !== null ? saved === "true" : true;
    } catch {
      this.enabled = true;
    }
  }

  clearMemoryCache(): void {
    this.memoryCache.clear();
    this.queuedKeys.clear();
    this.queue.length = 0;
    this.pendingDomUpdates.length = 0;
  }

  get coversEnabled(): boolean {
    return this.enabled;
  }

  setCoversEnabled(v: boolean): void {
    this.enabled = v;
    try {
      localStorage.setItem("ds_covers_enabled", v ? "true" : "false");
    } catch {}
    if (!v) {
      this.queue.length = 0;
      this.queuedKeys.clear();
      this.pendingDomUpdates.length = 0;
      if (this.lazyObserver) {
        this.lazyObserver.disconnect();
        this.lazyObserver = null;
      }
    }
  }

  get currentHydrationHost(): HTMLElement | null {
    return this.hydrationHost;
  }

  /** Maps a feed chapter to its cover key + series metadata. */
  getItemCoverInfo(ch: FeedChapter): ItemCoverInfo {
    // A chapter is part of an official series if ch.series is a non-empty string
    const isOfficialSeries = Boolean(ch.series && ch.series.trim().length > 0);

    const seriesTag = (ch.tags ?? []).find((t) => {
      const type = (t.type ?? "").toLowerCase();
      return type === "series" || type === "anthology" || type === "issue";
    });

    const doujinTag = (ch.tags ?? []).find((t) => {
      const type = (t.type ?? "").toLowerCase();
      return type === "doujin" || type === "doujinshi";
    });

    // 1. Official serialized series (e.g. Citrus +, Bloom Into You, The Blue Star on That Day)
    if (isOfficialSeries) {
      const seriesPermalink =
        seriesTag?.permalink ||
        (ch.series
          ? ch.series
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_+|_+$/g, "")
          : "");
      const seriesName = ch.series || seriesTag?.name || "";
      const seriesType = seriesTag?.type || "series";

      return {
        coverKey: `series:${seriesPermalink}`,
        chapterPermalink: ch.permalink,
        seriesPermalink,
        seriesName,
        seriesType,
        isStandalone: false,
      };
    }

    // 2. Doujins, fan works, and standalone oneshots (ch.series is null)
    // The Doujin tag represents the franchise being parodied (e.g. Kamiina Botan, Touhou, BanG Dream),
    // but the cover must be the chapter's own Page 1 cover art.
    const franchisePermalink = doujinTag?.permalink || seriesTag?.permalink || "";
    const franchiseName = doujinTag?.name || seriesTag?.name || "";
    const franchiseType = doujinTag?.type || seriesTag?.type || "doujin";

    return {
      coverKey: `chapter:${ch.permalink}`,
      chapterPermalink: ch.permalink,
      seriesPermalink: franchisePermalink,
      seriesName: franchiseName,
      seriesType: franchiseType,
      isStandalone: true,
    };
  }

  /** Resets per-page hydration state and attaches scroll tracking once. */
  beginPage(host: HTMLElement): void {
    this.hydrationHost = host;
    this.queue.length = 0; // reset queue for new page
    this.queuedKeys.clear();
    this.pendingDomUpdates.length = 0; // discard buffered updates from previous page
    if (this.lazyObserver) {
      this.lazyObserver.disconnect();
      this.lazyObserver = null;
    }

    // Attach scroll tracking to #ds-view on first ever feed render.
    if (!this.scrollTrackingAttached && this.enabled) {
      this.scrollTrackingAttached = true;
      this.attachScrollTracking();
    }
  }

  /** Pre-loads locally cached covers from SQLite in a single batch query. */
  async preloadBatch(coverTargets: CoverTarget[]): Promise<void> {
    if (!this.enabled) return;
    const uniqueCoverKeys = new Map<string, CoverTarget>();
    const keysToQuery: string[] = [];

    for (const ct of coverTargets) {
      if (!uniqueCoverKeys.has(ct.coverKey)) {
        uniqueCoverKeys.set(ct.coverKey, ct);
        if (!this.memoryCache.has(ct.coverKey)) {
          keysToQuery.push(`cover:${ct.coverKey}`);
        }
      }
    }

    if (keysToQuery.length > 0) {
      try {
        const cachedMap = await getBatchCached(keysToQuery);
        for (const [fullKey, payload] of cachedMap) {
          const rawKey = fullKey.replace(/^cover:/, "");
          if (payload) this.memoryCache.set(rawKey, payload);
        }
      } catch {}
    }
  }

  /** Observes a cover wrap; enqueues hydration when it nears the viewport. */
  observe(wrap: HTMLElement): void {
    if (!this.enabled) return;
    this.getLazyObserver().observe(wrap);
  }

  /** Pauses hydration pumps during the scroll-to-top animation. */
  scrollToTop(): void {
    // Keep hydration paused for the whole animation. We must NOT arm the idle
    // timer here: Chromium's programmatic smooth scroll does not emit JS scroll
    // events for its full duration, so a 400ms idle timer would fire mid-flight,
    // flip isScrolling to false, and let the pump run while covers are still
    // flying past — causing scroll jank.
    if (!this.enabled) return;
    if (this.scrollIdleTimer !== null) {
      window.clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = null;
    }
    this.isScrolling = true;
    // Deliberately keep the observer connected: covers flying past the
    // viewport get queued (not pumped — isScrolling is true), so they hydrate
    // in the background once the scroll settles. Covers that were scrolled past
    // quickly on the way DOWN were queued but never hydrated; dropping them
    // here (the old behavior) forced a fresh re-hydration on the way back up.
    // Keeping the queue + observer lets the idle pump drain them while the user
    // rests at the top, so the return trip is all cache hits.
  }

  /**
   * Re-arms cover observation after a scroll-to-top has fully settled, then
   * resumes the normal idle-gated pump so covers only load once scrolling is
   * genuinely stable again.
   */
  resumeAfterScrollToTop(host: HTMLElement): void {
    if (!this.enabled) return;
    // Force the paused state so re-observed covers only get queued, never
    // pumped immediately — even if the idle timer fired mid-animation (scroll
    // events on a long smooth scroll can be more than SCROLL_IDLE_MS apart).
    this.isScrolling = true;
    this.reobserveUnloadedCovers(host);
    if (this.scrollIdleTimer !== null) {
      window.clearTimeout(this.scrollIdleTimer);
    }
    this.scrollIdleTimer = window.setTimeout(() => {
      this.isScrolling = false;
      this.scrollIdleTimer = null;
      this.flushPendingDomUpdates();
      this.pumpCoverHydration();
    }, SCROLL_IDLE_MS);
  }

  /** Re-observes wraps that never got an image (e.g. after scroll-to-top). */
  reobserveUnloadedCovers(host: HTMLElement): void {
    if (!this.enabled) return;
    const observer = this.getLazyObserver();
    const unmountedWraps = host.querySelectorAll<HTMLElement>(
      ".ds-feed-cover-wrap:not(:has(img.ds-feed-cover))",
    );
    unmountedWraps.forEach((wrap) => observer.observe(wrap));
  }

  private attachScrollTracking(): void {
    // Primary: attach directly to the scrollable container so the event is guaranteed.
    const dsView = document.getElementById("ds-view");
    if (dsView) {
      dsView.addEventListener("scroll", this.onScrollActive, { passive: true });
    } else {
      console.warn("[ds-covers] #ds-view not found — scroll tracking may miss events");
    }
    // Fallback: document capture for any other scroll sources.
    document.addEventListener("scroll", this.onScrollActive, { capture: true, passive: true });
  }

  private readonly onScrollActive = (): void => {
    if (!this.isScrolling) {
      this.isScrolling = true;
    }
    if (this.scrollIdleTimer !== null) window.clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => {
      this.isScrolling = false;
      this.scrollIdleTimer = null;
      this.flushPendingDomUpdates();
      this.pumpCoverHydration();
    }, SCROLL_IDLE_MS);
  };

  private applyCoverToNode(node: HTMLElement, coverKey: string, coverPath: string): void {
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
      // Evict broken path from memory and SQLite cache
      this.memoryCache.delete(coverKey);
      void deleteCached(`cover:${coverKey}`);
    });
    node.appendChild(img);
  }

  private flushPendingDomUpdates(): void {
    if (this.pendingDomUpdates.length === 0) return;
    const updates = this.pendingDomUpdates.splice(0);
    requestAnimationFrame(() => {
      if (this.isScrolling) {
        // Scroll resumed before this frame — re-buffer; flushed on next idle.
        this.pendingDomUpdates.push(...updates);
        return;
      }
      for (const { coverKey, coverPath, host } of updates) {
        if (host !== this.hydrationHost) continue;
        const nodes = host.querySelectorAll<HTMLElement>(`[data-feed-cover="${coverKey}"]`);
        for (const node of nodes) this.applyCoverToNode(node, coverKey, coverPath);
      }
    });
  }

  private scheduleCoverDomUpdate(coverKey: string, coverPath: string, host: HTMLElement): void {
    if (this.isScrolling) {
      // Buffer the update — will be flushed in a single RAF batch when scroll goes idle.
      this.pendingDomUpdates.push({ coverKey, coverPath, host });
      return;
    }
    requestAnimationFrame(() => {
      if (this.isScrolling) {
        // Scroll resumed before this frame — re-buffer; flushed on next idle.
        this.pendingDomUpdates.push({ coverKey, coverPath, host });
        return;
      }
      if (host !== this.hydrationHost) return;
      const nodes = host.querySelectorAll<HTMLElement>(`[data-feed-cover="${coverKey}"]`);
      for (const node of nodes) this.applyCoverToNode(node, coverKey, coverPath);
    });
  }

  private getLazyObserver(): IntersectionObserver {
    if (!this.lazyObserver) {
      this.lazyObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const el = entry.target as HTMLElement;
              if (!this.enabled) continue;

              const coverKey = el.dataset.feedCover;
              const chapterPermalink = el.dataset.chapterPermalink;
              const seriesPermalink = el.dataset.seriesPermalink;
              const seriesType = el.dataset.seriesType;

              if (coverKey) {
                // undefined = not resolved yet; null = known-missing; string = cached.
                const resolved = this.memoryCache.get(coverKey);
                if (resolved !== undefined) {
                  // Hydration resolved — stop watching this wrap permanently.
                  this.lazyObserver?.unobserve(el);
                  if (resolved && this.hydrationHost) {
                    this.scheduleCoverDomUpdate(coverKey, resolved, this.hydrationHost);
                  }
                } else if (chapterPermalink) {
                  // Unhydrated. Keep observing so a re-entry (up-scroll) moves it
                  // to the front of the queue — the pump pops nearest-viewport
                  // first in BOTH directions. A stale down-scroll LIFO order
                  // would hydrate covers already passed while covers being
                  // approached stay placeholders.
                  if (!this.queuedKeys.has(coverKey)) {
                    this.queuedKeys.add(coverKey);
                    this.queue.unshift({
                      coverKey,
                      chapterPermalink,
                      seriesPermalink: seriesPermalink || null,
                      seriesType: seriesType || null,
                    });
                  } else {
                    const idx = this.queue.findIndex((t) => t.coverKey === coverKey);
                    if (idx > 0) {
                      const [target] = this.queue.splice(idx, 1);
                      this.queue.unshift(target);
                    }
                  }
                  if (!this.isScrolling) this.pumpCoverHydration();
                }
              }
            }
          }
        },
        { rootMargin: "150px" },
      );
    }
    return this.lazyObserver;
  }

  private pumpCoverHydration(): void {
    // Hard gate — no IPC work if disabled or while scrolling.
    if (!this.enabled || this.isScrolling || !this.hydrationHost || this.queue.length === 0) return;

    while (
      !this.isScrolling &&
      this.activeWorkers < this.MAX_CONCURRENCY &&
      this.queue.length > 0
    ) {
      // Front-pop: the observer pushes/re-prioritizes nearest-viewport covers to
      // the front on every entry, so this stays correct for down- AND up-scrolls.
      const target = this.queue.shift();
      if (!target) break;

      this.activeWorkers++;
      const host = this.hydrationHost;

      void (async () => {
        try {
          let task = this.inflight.get(target.coverKey);
          if (!task) {
            task = getOrHydrateItemCover(
              target.coverKey,
              target.chapterPermalink,
              target.seriesPermalink,
              target.seriesType,
            );
            this.inflight.set(target.coverKey, task);
          }

          const coverPath = await task;
          this.memoryCache.set(target.coverKey, coverPath);

          if (coverPath && host === this.hydrationHost) {
            this.scheduleCoverDomUpdate(target.coverKey, coverPath, host);
          }
        } catch (err) {
          console.warn(`[ds-covers] worker error: ${target.coverKey}`, err);
        } finally {
          this.inflight.delete(target.coverKey);
          this.activeWorkers--;
          // Yield one tick then resume if still idle.
          setTimeout(() => {
            if (!this.isScrolling) this.pumpCoverHydration();
          }, 0);
        }
      })();
    }
  }
}

export const browseCovers = new BrowseCovers();
