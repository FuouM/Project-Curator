import {
  Route,
  ChapterRef,
  PAGES_PREFIX,
  absUrl,
  isOnline,
  navigate,
  setActions,
  setBanner,
} from "../state";
import {
  fetchChapter,
  fetchSeries,
  fileMove,
  fileResolve,
  httpDownloadFull,
  openExternal,
  pageOutputPath,
} from "../api";
import {
  addBookmark,
  addHistory,
  getBookmark,
  getCachedPages,
  getReadingProgress,
  removeBookmark,
  setCachedPage,
  setReadingProgress,
} from "../db";
import type { Chapter, ChapterPage } from "../types/api";
import type { FitMode, ReaderTheme } from "../types/reader";
import { ReaderQueue } from "./reader-queue";
import { ReaderViewport } from "./reader-viewport";
import { ReaderToolbar } from "./reader-toolbar";
import { ReaderShortcuts } from "./reader-shortcuts";
import { renderLoading } from "../components/loading";
import { isAutoCacheChapterEnabled, getPrefetchBuffer } from "./settings";

export { isAutoCacheChapterEnabled, setAutoCacheChapterEnabled, getPrefetchBuffer, setPrefetchBuffer } from "./settings";

/**
 * Coordinates one chapter-reading session: owns the shared DOM/state that the
 * queue, viewport, toolbar, and shortcuts modules operate on, and wires them
 * together once chapter metadata has loaded.
 */
export class ReaderController {
  // Shared reader state ---------------------------------------------------
  disposed = false;
  pages: ChapterPage[] = [];
  permalink = "";
  seriesPermalink: string | null = null;
  seriesName = "";
  chapterTitle = "";
  chapterList: ChapterRef[] = [];

  isHorizontal = false;
  fitMode: FitMode = "width";
  zoomScale = 1.0;
  scrollLock = false;
  currentIndex = 0;
  readerTheme: ReaderTheme = "light";
  isFullscreen = false;

  cachedMap = new Map<number, string>();
  cachedCount = 0;
  atEnd = false;
  lastPersistedIndex = -1;
  persistTimer: number | undefined;
  isProgrammaticScroll = false;
  programmaticScrollTimer: number | null = null;
  scrollRaf: number | null = null;

  // DOM -------------------------------------------------------------------
  container: HTMLElement;
  readerContainer!: HTMLElement;
  viewport!: HTMLElement;
  strip!: HTMLElement;
  slots: HTMLElement[] = [];

  prevChapterBtn!: HTMLButtonElement;
  nextChapterBtn!: HTMLButtonElement;
  prevPageBtn!: HTMLButtonElement;
  nextPageBtn!: HTMLButtonElement;
  positionLabel!: HTMLElement;
  progressFill!: HTMLElement;
  scrollLockBtn!: HTMLButtonElement;
  modeBtn!: HTMLButtonElement;
  fitSelect!: HTMLSelectElement;
  themeBtn!: HTMLButtonElement;
  fullscreenBtn!: HTMLButtonElement;

  queue!: ReaderQueue;
  viewportImpl!: ReaderViewport;
  toolbarImpl!: ReaderToolbar;
  shortcutsImpl!: ReaderShortcuts;

  private readonly cleanup: (() => void)[] = [];

  constructor(
    readonly route: Route,
    container: HTMLElement,
  ) {
    this.container = container;
  }

  onDispose(fn: () => void): void {
    this.cleanup.push(fn);
  }

  // State helpers (re-exported so modules avoid importing state directly) --
  setBanner(msg: string): void {
    setBanner(msg);
  }

  navigate(route: Route): void {
    navigate(route);
  }

  setActions(fn: (host: HTMLElement) => void): void {
    setActions(fn);
  }

  // Transport wrappers ----------------------------------------------------
  absUrl(u: string): string {
    return absUrl(u);
  }

  fileResolve(path: string): Promise<string | null> {
    return fileResolve(path);
  }

  httpDownloadFull(
    url: string,
    outPath: string,
  ): Promise<{ absolutePath: string; sizeBytes: number }> {
    return httpDownloadFull(url, outPath);
  }

  setCachedPage(index: number, absPath: string, sizeBytes: number): Promise<void> {
    return setCachedPage(this.permalink, index, absPath, sizeBytes);
  }

  pageOutputPath(index: number, pageUrl: string): string {
    return pageOutputPath(this.seriesPermalink ?? "", this.permalink, index, pageUrl);
  }

  // Slot rendering ---------------------------------------------------------
  renderSlotImg(slot: HTMLElement, absPath: string, pageNum: number): void {
    const PH = window.PluginHost;
    slot.classList.remove("ds-slot-loading");
    slot.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = "ds-slot-page-badge";
    badge.textContent = `${pageNum} / ${this.pages.length}`;
    slot.appendChild(badge);

    const img = document.createElement("img");
    img.className = "ds-page-img";
    img.alt = `Page ${pageNum}`;
    img.addEventListener("error", () => {
      const idx = Number(slot.dataset.index);
      this.cachedMap.delete(idx);
      if (this.queue.isRetrying(idx)) return;
      this.queue.markRetrying(idx);
      this.renderSlotState(slot, "spinner", "Re-downloading…");
      this.queue.enqueue(idx, true);
    });
    img.src = PH.convertFileSrc(absPath);
    slot.appendChild(img);
  }

  renderSlotState(slot: HTMLElement, kind: "spinner" | "offline" | "error" | "idle", message: string): void {
    slot.innerHTML = "";
    const idx = Number(slot.dataset.index);
    const badge = document.createElement("div");
    badge.className = "ds-slot-page-badge";
    badge.textContent = `${idx + 1} / ${this.pages.length}`;
    slot.appendChild(badge);

    const state = document.createElement("div");
    state.className = `ds-slot-state${kind === "error" ? " ds-slot-error" : ""}`;
    if (kind === "spinner") {
      state.innerHTML =
        '<i class="bi bi-cloud-arrow-down" style="font-size:20px;color:var(--sys-primary,#0078d4);"></i>' +
        '<div class="ds-slot-pulse-wrap"><div class="ds-slot-pulse-bar"></div></div>';
    } else if (kind === "offline") {
      state.innerHTML = '<i class="bi bi-wifi-off" style="font-size:20px;"></i>';
    } else if (kind === "idle") {
      state.innerHTML = '<i class="bi bi-book" style="font-size:20px;color:var(--sys-text-muted,#888);"></i>';
    } else {
      state.innerHTML = '<i class="bi bi-exclamation-triangle" style="font-size:20px;"></i>';
    }
    const text = document.createElement("span");
    if (kind === "spinner") {
      const pct =
        this.pages.length > 0 ? Math.round((this.cachedCount / this.pages.length) * 100) : 0;
      text.textContent = `Downloading page ${idx + 1} of ${this.pages.length} (${this.cachedCount}/${this.pages.length} cached · ${pct}%)`;
    } else if (kind === "idle") {
      text.textContent = `Page ${idx + 1} of ${this.pages.length} · Waiting to read…`;
    } else {
      text.textContent = message;
    }
    state.appendChild(text);
    if (kind === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "win-button";
      retry.style.cssText = "font-size:10px;padding:1px 8px;";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        this.queue.clearFailed(idx);
        this.renderSlotState(slot, "spinner", "Downloading…");
        this.queue.enqueue(idx);
      });
      state.appendChild(retry);
    }
    slot.appendChild(state);
  }

  updateCacheCount(): void {
    this.cachedCount = this.cachedMap.size;
    this.updateProgressText();
    const pct =
      this.pages.length > 0 ? Math.round((this.cachedCount / this.pages.length) * 100) : 0;
    for (const slot of this.slots) {
      const idx = Number(slot.dataset.index);
      const absPath = this.cachedMap.get(idx);
      if (absPath) {
        // If cached but not yet rendered as an image, render it immediately
        if (!slot.querySelector("img.ds-page-img")) {
          this.renderSlotImg(slot, absPath, idx + 1);
        }
      } else {
        const spinner = slot.querySelector<HTMLElement>(".ds-slot-state:not(.ds-slot-error) span");
        if (spinner) {
          spinner.textContent = `Downloading page ${idx + 1} of ${this.pages.length} (${this.cachedCount}/${this.pages.length} cached · ${pct}%)`;
        }
      }
    }
  }

  // Queue access ------------------------------------------------------------
  enqueue(index: number, priority = false): void {
    if (index >= 0 && index < this.pages.length) {
      const slot = this.slots[index];
      if (slot && !this.cachedMap.has(index) && !this.isPageFailed(index)) {
        // If the slot is in idle state, transition it to the downloading spinner
        if (slot.querySelector(".bi-book")) {
          this.renderSlotState(slot, "spinner", "Downloading…");
        }
      }
    }
    this.queue.enqueue(index, priority);
  }

  isPageFailed(index: number): boolean {
    return this.queue.isFailed(index);
  }

  // Progress + persistence --------------------------------------------------
  updateProgressText(): void {
    const pct =
      this.pages.length > 0 ? Math.round(((this.currentIndex + 1) / this.pages.length) * 100) : 0;
    const cachedNote =
      this.cachedCount > 0 ? ` · ${this.cachedCount}/${this.pages.length} cached` : "";
    this.positionLabel.textContent = `Page ${this.currentIndex + 1} of ${this.pages.length} (${pct}%)${cachedNote}`;
    this.progressFill.style.width = `${pct}%`;
    this.prevPageBtn.disabled = this.currentIndex <= 0;
    this.nextPageBtn.disabled = this.currentIndex >= this.pages.length - 1;
  }

  schedulePersist(): void {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => void this.persistNow(), 400);
  }

  async persistNow(): Promise<void> {
    if (this.lastPersistedIndex === this.currentIndex && !this.atEnd) return;
    this.lastPersistedIndex = this.currentIndex;
    try {
      await setReadingProgress({
        chapterPermalink: this.permalink,
        seriesPermalink: this.seriesPermalink ?? "",
        seriesName: this.seriesName ?? "",
        chapterTitle: this.chapterTitle,
        pageIndex: this.currentIndex,
        pageTotal: this.pages.length,
        completed: this.atEnd,
      });
    } catch (err) {
      console.error("dynasty-scans: failed to persist reading progress:", err);
    }
  }

  setPage(index: number, instant = false, scrollToBottom = false): void {
    if (index < 0 || index >= this.pages.length) return;
    this.currentIndex = index;
    this.atEnd = this.currentIndex >= this.pages.length - 1;
    this.updateProgressText();
    this.schedulePersist();
    if (this.atEnd) void this.persistNow();

    this.enqueue(this.currentIndex);
    if (isAutoCacheChapterEnabled()) {
      this.enqueue(this.currentIndex + 1);
      this.enqueue(this.currentIndex + 2);
    } else {
      const prefetchCount = getPrefetchBuffer();
      for (let offset = 1; offset <= prefetchCount; offset++) {
        const nextIdx = this.currentIndex + offset;
        if (nextIdx < this.pages.length && !this.cachedMap.has(nextIdx)) {
          this.enqueue(nextIdx);
        }
      }
    }

    this.viewportImpl.slideTo(index, instant, scrollToBottom);
  }

  /**
   * Reveals the strip once the resume restore has landed. In paged mode the
   * transform is already exact, so the strip is revealed immediately. In scroll
   * mode slot heights are image-driven; if the images near the resume page are
   * still decoding, wait (bounded by a deadline) and re-align the scroll so the
   * restore lands at the correct offset before revealing.
   */
  private revealAfterRestore(): void {
    if (this.isHorizontal) {
      this.readerContainer.classList.remove("ds-restoring");
      return;
    }
    const deadline = window.performance.now() + 1000;
    const poll = (): void => {
      if (this.disposed) return;
      let ready = true;
      const start = Math.max(0, this.currentIndex - 1);
      const end = Math.min(this.pages.length - 1, this.currentIndex + 1);
      for (let i = start; i <= end; i++) {
        const img = this.slots[i]?.querySelector<HTMLImageElement>("img.ds-page-img");
        if (img && !img.complete) {
          ready = false;
          break;
        }
      }
      if (!ready && window.performance.now() < deadline) {
        window.setTimeout(poll, 30);
        return;
      }
      this.viewportImpl.slideTo(this.currentIndex, true);
      this.readerContainer.classList.remove("ds-restoring");
    };
    window.setTimeout(poll, 0);
  }

  // Chapter navigation ------------------------------------------------------
  gotoChapter(c: ChapterRef): void {
    this.navigate({
      view: "reader",
      seriesPermalink: this.seriesPermalink ?? undefined,
      seriesName: this.seriesName,
      chapterPermalink: c.permalink,
      chapterTitle: c.title,
      chapterList: this.chapterList,
    });
  }

  updateChapterNav(): void {
    const curIdx = this.chapterList.findIndex((c) => c.permalink === this.permalink);
    this.prevChapterBtn.disabled = curIdx <= 0;
    this.nextChapterBtn.disabled = curIdx < 0 || curIdx >= this.chapterList.length - 1;
  }

  /** Background legacy-filename standardization. Zero network traffic. */
  standardizeCachePaths(): void {
    window.setTimeout(async () => {
      if (this.disposed) return;
      const cleanSeries = (this.seriesPermalink || "_singles").replace(/[^a-zA-Z0-9_-]/g, "_");
      const cleanChapter = this.permalink.replace(/[^a-zA-Z0-9_-]/g, "_");

      for (let i = 0; i < this.pages.length; i++) {
        if (this.disposed) return;
        const page = this.pages[i];
        if (!page) continue;
        const targetPath = this.pageOutputPath(i, page.url);

        // Skip if already at canonical path. `cachedMap` holds absolute paths,
        // so compare against the resolved absolute form (not the relative
        // `targetPath`) — otherwise every cached page gets re-rendered here and
        // the visible image flashes.
        const alreadyThere = await this.fileResolve(targetPath);
        if (alreadyThere) {
          if (this.cachedMap.get(i) !== alreadyThere) {
            await this.setCachedPage(i, alreadyThere, 0);
            this.cachedMap.set(i, alreadyThere);
            if (!this.disposed && this.slots[i]) {
              this.renderSlotImg(this.slots[i], alreadyThere, i + 1);
            }
            this.updateCacheCount();
          }
          continue;
        }

        // Build candidate legacy paths from the original URL filename
        const origName = page.url.split("/").pop() || "";
        const ext = origName.split(".").pop()?.split("?")[0] || "webp";
        const pad3 = String(i + 1).padStart(3, "0");
        const pad4 = String(i + 1).padStart(4, "0");
        const candidates = [
          `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/${pad3}_${origName}`,
          `${PAGES_PREFIX}/${cleanChapter}/${origName}`,
          `${PAGES_PREFIX}/_singles/${cleanChapter}/${origName}`,
          `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/${origName}`,
          `${PAGES_PREFIX}/${cleanChapter}/page_${pad4}.${ext}`,
        ];

        let found: string | null = null;
        for (const candidate of candidates) {
          found = await this.fileResolve(candidate);
          if (found) break;
        }

        if (found) {
          try {
            const newAbsPath = await fileMove(found, targetPath);
            await this.setCachedPage(i, newAbsPath, 0);
            this.cachedMap.set(i, newAbsPath);
            if (!this.disposed && this.slots[i]) {
              this.renderSlotImg(this.slots[i], newAbsPath, i + 1);
            }
            this.updateCacheCount();
          } catch (e) {
            console.warn(`dynasty-scans: could not move page ${i + 1} to canonical path:`, e);
          }
        }
        // If nothing found: downloadPage already handles this via the queue
      }
    }, 2500);
  }

  // Main bootstrap -----------------------------------------------------------
  async init(): Promise<void> {
    const route = this.route;
    const container = this.container;
    this.permalink = route.chapterPermalink ?? "";

    let chapter: Chapter;
    try {
      chapter = await fetchChapter(this.permalink);
    } catch (err) {
      if (this.disposed) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.setBanner(`Failed to load chapter: ${msg}`);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "win-button";
      retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
      retry.addEventListener("click", () => this.retry());
      container.appendChild(retry);
      return;
    }

    if (this.disposed) return;

    const seriesTag = (chapter.tags ?? []).find((t) => t.type === "Series");
    this.seriesPermalink = seriesTag?.permalink ?? route.seriesPermalink ?? null;
    this.seriesName = seriesTag?.name ?? route.seriesName ?? chapter.title;
    this.chapterTitle = chapter.title || route.chapterTitle || "Chapter";
    this.chapterList = route.chapterList ?? [];
    this.pages = chapter.pages ?? [];
    // Resolve the starting page: an explicit route `startPage` wins; otherwise
    // fall back to saved reading progress so resuming works from every entry
    // point (History, session tab, browse, search, series).
    let startPage = route.startPage ?? 0;
    if (startPage <= 0) {
      try {
        const prog = await getReadingProgress(this.permalink);
        if (prog && prog.completed !== 1 && prog.page_index > 0) {
          startPage = prog.page_index;
        }
      } catch (err) {
        console.error("dynasty-scans: failed to load reading progress:", err);
      }
    }
    this.currentIndex = Math.min(startPage, Math.max(0, this.pages.length - 1));

    container.innerHTML = "";
    if (this.pages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ds-muted";
      empty.textContent = "This chapter has no pages.";
      container.appendChild(empty);
      return;
    }

    // If chapterList wasn't provided, lazily fetch the series to populate prev/next
    if (this.chapterList.length === 0 && this.seriesPermalink) {
      void fetchSeries(this.seriesPermalink).then((s) => {
        if (this.disposed) return;
        const cl: ChapterRef[] = [];
        for (const t of s.taggings ?? []) {
          if (t.title && t.permalink) {
            cl.push({ title: t.title, permalink: t.permalink, released_on: t.released_on });
          }
        }
        if (cl.length > 0) {
          this.chapterList = cl;
          this.updateChapterNav();
        }
      });
    }

    // Display-mode preferences
    this.isHorizontal = localStorage.getItem("ds-reader-mode") === "paged";
    this.fitMode = (localStorage.getItem("ds-reader-fit") as FitMode) || "width";
    this.scrollLock = localStorage.getItem("ds-reader-scroll-lock") === "1";
    this.readerTheme = (localStorage.getItem("ds-reader-theme") as ReaderTheme) || "light";

    this.readerContainer = document.createElement("div");
    this.readerContainer.id = "ds-reader-container";
    this.readerContainer.className = `fit-${this.fitMode}`;
    container.appendChild(this.readerContainer);

    // Build sub-modules (each constructs its own DOM into this.readerContainer)
    this.toolbarImpl = new ReaderToolbar(this);
    this.viewportImpl = new ReaderViewport(this);
    this.queue = new ReaderQueue(this);
    this.shortcutsImpl = new ReaderShortcuts(this);

    // Restore cached page paths from SQLite
    let cachedRows: Awaited<ReturnType<typeof getCachedPages>> = [];
    try {
      cachedRows = await getCachedPages(this.permalink);
    } catch (err) {
      cachedRows = [];
      this.setBanner(
        `Page cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const row of cachedRows) {
      if (row.page_index >= 0 && row.page_index < this.pages.length && row.file_path) {
        this.cachedMap.set(row.page_index, row.file_path);
      }
    }
    this.cachedCount = this.cachedMap.size;

    // Build slots
    const autoCacheAll = isAutoCacheChapterEnabled();
    for (let i = 0; i < this.pages.length; i++) {
      const slot = document.createElement("div");
      slot.className = "ds-slot";
      slot.dataset.index = String(i);
      const absPath = this.cachedMap.get(i);
      if (absPath) {
        this.renderSlotImg(slot, absPath, i + 1);
      } else if (!isOnline()) {
        this.renderSlotState(slot, "offline", "Offline — not downloaded");
      } else if (autoCacheAll) {
        this.renderSlotState(slot, "spinner", "Queued for download…");
        this.enqueue(i);
      } else {
        this.renderSlotState(slot, "idle", "Waiting to read…");
      }
      this.strip.appendChild(slot);
      this.slots.push(slot);
    }

    // Trigger priority download for uncached start/nearby pages
    if (!this.cachedMap.has(this.currentIndex)) this.enqueue(this.currentIndex, true);
    if (autoCacheAll) {
      if (!this.cachedMap.has(this.currentIndex + 1)) this.enqueue(this.currentIndex + 1, true);
      if (!this.cachedMap.has(this.currentIndex + 2)) this.enqueue(this.currentIndex + 2, true);
    } else {
      const prefetchCount = getPrefetchBuffer();
      for (let offset = 1; offset <= prefetchCount; offset++) {
        const nextIdx = this.currentIndex + offset;
        if (nextIdx < this.pages.length && !this.cachedMap.has(nextIdx)) {
          this.enqueue(nextIdx, true);
        }
      }
    }

    // Hide the strip from the first paint: when resuming, the first page image
    // would otherwise flash before the restore jump below lands.
    if (startPage > 0) {
      this.readerContainer.classList.add("ds-restoring");
    }

    this.toolbarImpl.wireAfterSlots();
    this.viewportImpl.wireAfterSlots();
    this.updateProgressText();
    this.standardizeCachePaths();

    // History + top-bar actions
    try {
      await addHistory({
        chapterPermalink: this.permalink,
        seriesPermalink: this.seriesPermalink ?? "",
        seriesName: this.seriesName ?? "",
        chapterTitle: this.chapterTitle,
      });
    } catch (err) {
      console.error("dynasty-scans: failed to record history:", err);
    }

    let bookmarked = false;
    try {
      const bm = await getBookmark(this.permalink);
      bookmarked = bm !== null;
    } catch {
      bookmarked = false;
    }

    this.setActions((host) => {
      if (this.seriesPermalink) {
        const seriesBtn = document.createElement("button");
        seriesBtn.type = "button";
        seriesBtn.className = "win-button";
        seriesBtn.title = "Open the containing series";
        seriesBtn.innerHTML = '<i class="bi bi-collection"></i> Series';
        seriesBtn.addEventListener("click", () => {
          this.navigate({
            view: "series",
            seriesPermalink: this.seriesPermalink ?? undefined,
            seriesName: this.seriesName ?? this.chapterTitle,
          });
        });
        host.appendChild(seriesBtn);
      }

      const bmBtn = document.createElement("button");
      bmBtn.type = "button";
      bmBtn.className = "win-button";
      bmBtn.title = bookmarked ? "Remove bookmark" : "Bookmark this chapter";
      bmBtn.innerHTML = bookmarked
        ? '<i class="bi bi-bookmark-fill"></i>'
        : '<i class="bi bi-bookmark"></i>';
      bmBtn.addEventListener("click", async () => {
        bmBtn.disabled = true;
        try {
          if (bookmarked) {
            await removeBookmark(this.permalink);
            bookmarked = false;
          } else {
            await addBookmark({
              chapterPermalink: this.permalink,
              seriesPermalink: this.seriesPermalink ?? "",
              seriesName: this.seriesName ?? "",
              chapterTitle: this.chapterTitle,
              pageIndex: this.currentIndex,
            });
            bookmarked = true;
          }
          bmBtn.innerHTML = bookmarked
            ? '<i class="bi bi-bookmark-fill"></i>'
            : '<i class="bi bi-bookmark"></i>';
          bmBtn.title = bookmarked ? "Remove bookmark" : "Bookmark this chapter";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.setBanner(`Bookmark failed: ${msg}`);
        }
        bmBtn.disabled = false;
      });
      host.appendChild(bmBtn);

      const cacheBtn = document.createElement("button");
      cacheBtn.type = "button";
      cacheBtn.className = "win-button";
      cacheBtn.title = "Download every uncached page of this chapter";
      cacheBtn.innerHTML = '<i class="bi bi-download"></i> Cache Chapter';
      cacheBtn.addEventListener("click", () => {
        for (let i = 0; i < this.pages.length; i++) {
          if (!this.cachedMap.has(i) && !this.isPageFailed(i)) this.enqueue(i);
        }
        this.setBanner("Caching chapter…");
      });
      host.appendChild(cacheBtn);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "win-button";
      copyBtn.title = "Copy chapter link to clipboard";
      copyBtn.innerHTML = '<i class="bi bi-link-45deg"></i>';
      copyBtn.addEventListener("click", async () => {
        try {
          const url = `https://dynasty-scans.com/chapters/${this.permalink}`;
          await navigator.clipboard.writeText(url);
          copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
          this.setBanner("Copied chapter link to clipboard");
          window.setTimeout(() => {
            if (!copyBtn.isConnected) return;
            copyBtn.innerHTML = '<i class="bi bi-link-45deg"></i>';
          }, 2000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.setBanner(`Copy failed: ${msg}`);
        }
      });
      host.appendChild(copyBtn);

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "win-button";
      openBtn.title = "Open this chapter in your browser";
      openBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
      openBtn.addEventListener("click", () => {
        void openExternal(`https://dynasty-scans.com/chapters/${this.permalink}`);
      });
      host.appendChild(openBtn);
    });

    // Restore the resume page. The awaited history/bookmark calls above gave
    // nearby images time to decode, so the instant scroll lands at the correct
    // offset; the strip stays hidden until it has landed and been revealed.
    if (startPage > 0) {
      this.setPage(startPage, true);
      this.revealAfterRestore();
    }
  }

  retry(): void {
    // Re-render from scratch (used by the load-failure retry button).
    // Mirrors renderReader's bootstrap; the router keeps the original dispose.
    this.dispose();
    this.container.innerHTML = "";
    this.container.appendChild(renderLoading());
    const fresh = new ReaderController(this.route, this.container);
    void fresh.init();
  }

  dispose(): void {
    this.disposed = true;
    for (const fn of this.cleanup) fn();
  }
}

export function renderReader(container: HTMLElement, route: Route): (() => void) | void {
  container.innerHTML = "";
  const permalink = route.chapterPermalink;
  if (!permalink) {
    setBanner("Missing chapter permalink.");
    return;
  }

  container.appendChild(renderLoading());

  const ctrl = new ReaderController(route, container);
  void ctrl.init();

  return () => ctrl.dispose();
}
