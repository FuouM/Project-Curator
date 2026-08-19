import type { ReaderController } from "./reader-controller";

/**
 * Bounded page download pool for a single chapter session.
 *
 * Every page is fetched exactly once via `HttpDownload` (written to
 * `.curator/plugin_data/dynasty-scans/pages/` and indexed in `cached_pages`),
 * then rendered from disk through `convertFileSrc`. A small concurrency cap
 * keeps the request rate polite while overlapping downloads for a 30-60 page
 * chapter (the priority-sorted queue keeps order sensible).
 */
export class ReaderQueue {
  private static readonly MAX_CONCURRENT = 3;
  private readonly queue: number[] = [];
  private readonly inFlight = new Set<number>();
  private readonly retrying = new Set<number>();
  private readonly failed = new Set<number>();
  private firstErrorShown = false;

  constructor(private readonly c: ReaderController) {}

  get failedSet(): Set<number> {
    return this.failed;
  }

  isFailed(index: number): boolean {
    return this.failed.has(index);
  }

  clearFailed(index: number): void {
    this.failed.delete(index);
  }

  isRetrying(index: number): boolean {
    return this.retrying.has(index);
  }

  markRetrying(index: number): void {
    this.retrying.add(index);
  }

  /** Marks a page as needing a (re)download. Priorities jump to the queue head. */
  enqueue(index: number, priority = false): void {
    const pages = this.c.pages;
    if (index < 0 || index >= pages.length) return;
    if (this.inFlight.has(index) || this.failed.has(index)) return;
    if (!this.queue.includes(index)) {
      if (priority) {
        this.queue.unshift(index);
      } else {
        this.queue.push(index);
      }
    }
    // Keep queue sorted by proximity to the user's reading position
    this.queue.sort((a, b) => {
      const distA = Math.abs(a - this.c.currentIndex) + (a < this.c.currentIndex ? 1000 : 0);
      const distB = Math.abs(b - this.c.currentIndex) + (b < this.c.currentIndex ? 1000 : 0);
      return distA - distB;
    });
    this.pump();
  }

  private pump(): void {
    while (this.inFlight.size < ReaderQueue.MAX_CONCURRENT && this.queue.length > 0) {
      const idx = this.queue.shift() as number;
      if (this.inFlight.has(idx)) continue;
      this.inFlight.add(idx);
      void this.downloadPage(idx).finally(() => {
        this.inFlight.delete(idx);
        this.pump();
      });
    }
  }

  private async downloadPage(index: number): Promise<void> {
    const c = this.c;
    const page = c.pages[index];
    if (!page) return;
    const slot = c.slots[index];
    const outPath = c.pageOutputPath(index, page.url);
    try {
      // If the file already exists at the canonical path, skip the network entirely
      const existing = await c.fileResolve(outPath);
      let absPath: string;
      let sizeBytes = 0;
      if (existing) {
        absPath = existing;
      } else {
        const res = await c.httpDownloadFull(c.absUrl(page.url), outPath);
        absPath = res.absolutePath;
        sizeBytes = res.sizeBytes;
      }
      await c.setCachedPage(index, absPath, sizeBytes);
      c.cachedMap.set(index, absPath);
      if (!c.disposed && slot) {
        c.renderSlotImg(slot, absPath, index + 1);
      }
      c.updateCacheCount();
    } catch (err) {
      if (c.disposed) return;
      this.failed.add(index);
      const msg = err instanceof Error ? err.message : String(err);
      if (slot) c.renderSlotState(slot, "error", `Download failed: ${msg}`);
      if (!this.firstErrorShown) {
        this.firstErrorShown = true;
        c.setBanner(
          `Page download failed (page ${index + 1} of ${c.pages.length}). Use the slot's Retry.`,
        );
      }
    }
  }
}
