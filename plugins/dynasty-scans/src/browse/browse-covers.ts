import { getOrHydrateItemCover } from "../api";
import { getBatchCached } from "../db";
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

  get coversEnabled(): boolean {
    return this.enabled;
  }

  setCoversEnabled(v: boolean): void {
    this.enabled = v;
    try {
      localStorage.setItem("ds_covers_enabled", v ? "true" : "false");
    } catch {}
  }

  get currentHydrationHost(): HTMLElement | null {
    return this.hydrationHost;
  }

  /** Maps a feed chapter to its cover key + series metadata. */
  getItemCoverInfo(ch: FeedChapter): ItemCoverInfo {
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
    if (!this.scrollTrackingAttached) {
      this.scrollTrackingAttached = true;
      this.attachScrollTracking();
      console.log("[ds-covers] scroll tracking attached to #ds-view");
    }
  }

  /** Pre-loads locally cached covers from SQLite in a single batch query. */
  async preloadBatch(coverTargets: CoverTarget[]): Promise<void> {
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

  /** Tears down hydration state and pauses pumps (used on scroll-to-top). */
  scrollToTop(): void {
    if (this.lazyObserver) {
      this.lazyObserver.disconnect();
      this.lazyObserver = null;
    }
    this.queue.length = 0;
    this.queuedKeys.clear();
    this.pendingDomUpdates.length = 0;
    this.onScrollActive();
  }

  /** Re-observes wraps that never got an image (e.g. after scroll-to-top). */
  reobserveUnloadedCovers(host: HTMLElement): void {
    if (!this.enabled) return;
    const observer = this.getLazyObserver();
    const unmountedWraps = host.querySelectorAll<HTMLElement>(".ds-feed-cover-wrap:not(:has(img.ds-feed-cover))");
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
      console.log("[ds-covers] scroll start — hydration paused");
      this.isScrolling = true;
    }
    if (this.scrollIdleTimer !== null) window.clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => {
      this.isScrolling = false;
      this.scrollIdleTimer = null;
      console.log(`[ds-covers] scroll idle — flushing ${this.pendingDomUpdates.length} buffered updates, queue=${this.queue.length}`);
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
    });
    node.appendChild(img);
  }

  private flushPendingDomUpdates(): void {
    if (this.pendingDomUpdates.length === 0) return;
    const updates = this.pendingDomUpdates.splice(0);
    requestAnimationFrame(() => {
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
              this.lazyObserver?.unobserve(el);
              if (!this.enabled) continue;

              const coverKey = el.dataset.feedCover;
              const chapterPermalink = el.dataset.chapterPermalink;
              const seriesPermalink = el.dataset.seriesPermalink;
              const seriesType = el.dataset.seriesType;

              if (coverKey) {
                const cached = this.memoryCache.get(coverKey);
                if (cached && this.hydrationHost) {
                  this.scheduleCoverDomUpdate(coverKey, cached, this.hydrationHost);
                } else if (chapterPermalink && !this.queuedKeys.has(coverKey)) {
                  this.queuedKeys.add(coverKey);
                  this.queue.push({
                    coverKey,
                    chapterPermalink,
                    seriesPermalink: seriesPermalink || null,
                    seriesType: seriesType || null,
                  });
                  if (!this.isScrolling) this.pumpCoverHydration();
                }
              }
            }
          }
        },
        { rootMargin: "150px" }
      );
    }
    return this.lazyObserver;
  }

  private pumpCoverHydration(): void {
    // Hard gate — no IPC work while scrolling.
    if (this.isScrolling || !this.hydrationHost || this.queue.length === 0) return;

    console.log(`[ds-covers] pump: workers=${this.activeWorkers}/${this.MAX_CONCURRENCY} queue=${this.queue.length} scrolling=${this.isScrolling}`);

    while (!this.isScrolling && this.activeWorkers < this.MAX_CONCURRENCY && this.queue.length > 0) {
      // LIFO: prioritise covers closest to current viewport.
      const target = this.queue.pop();
      if (!target) break;

      this.activeWorkers++;
      const host = this.hydrationHost;
      console.log(`[ds-covers] worker start: ${target.coverKey}`);

      void (async () => {
        try {
          let task = this.inflight.get(target.coverKey);
          if (!task) {
            task = getOrHydrateItemCover(
              target.coverKey,
              target.chapterPermalink,
              target.seriesPermalink,
              target.seriesType
            );
            this.inflight.set(target.coverKey, task);
          }

          const coverPath = await task;
          this.memoryCache.set(target.coverKey, coverPath);
          console.log(`[ds-covers] worker done: ${target.coverKey} → ${coverPath ? "hit" : "miss"} isScrolling=${this.isScrolling}`);

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