/**
 * Chapter reader: vertical strip rendered from the on-disk page cache.
 *
 * Every page is fetched exactly once via `HttpDownload` (written to
 * `.curator/plugin_data/dynasty-scans/pages/` and indexed in `cached_pages`),
 * then rendered from disk through `convertFileSrc`. Unfetched pages show a
 * spinner (online) or an "Offline — not downloaded" placeholder (offline).
 * A small concurrency cap keeps the request rate polite.
 */

import {
  Route,
  ChapterRef,
  PAGES_PREFIX,
  absUrl,
  isOnline,
  navigate,
  setActions,
  setBanner,
} from "./state";
import {
  Chapter,
  fetchChapter,
  fetchSeries,
  fileExists,
  fileMove,
  fileResolve,
  httpDownload,
  httpDownloadFull,
  openExternal,
  pageOutputPath,
} from "./api";
import {
  addBookmark,
  addHistory,
  getBookmark,
  getCachedPages,
  removeBookmark,
  setCachedPage,
  setReadingProgress,
} from "./db";

const PH = window.PluginHost;
const MAX_CONCURRENT = 2;

export function renderReader(container: HTMLElement, route: Route): (() => void) | void {
  container.innerHTML = "";
  const permalink = route.chapterPermalink;
  if (!permalink) {
    setBanner("Missing chapter permalink.");
    return;
  }

  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading chapter…";
  container.appendChild(loading);

  let disposed = false;
  const cleanup: (() => void)[] = [];
  const onDispose = (fn: () => void): void => {
    cleanup.push(fn);
  };

  void (async () => {
    let chapter: Chapter;
    try {
      chapter = await fetchChapter(permalink);
    } catch (err) {
      if (disposed) return;
      container.innerHTML = "";
      const msg = err instanceof Error ? err.message : String(err);
      setBanner(`Failed to load chapter: ${msg}`);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "win-button";
      retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
      retry.addEventListener("click", () => renderReader(container, route));
      container.appendChild(retry);
      return;
    }

    if (disposed) return;

    const seriesTag = (chapter.tags ?? []).find((t) => t.type === "Series");
    const seriesPermalink = route.seriesPermalink ?? seriesTag?.permalink;
    const seriesName = route.seriesName ?? seriesTag?.name ?? chapter.title;
    const chapterTitle = route.chapterTitle ?? chapter.title;
    let chapterList = route.chapterList ?? [];
    const pages = chapter.pages ?? [];

    container.innerHTML = "";
    if (pages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ds-muted";
      empty.textContent = "This chapter has no pages.";
      container.appendChild(empty);
      return;
    }

    // If chapterList wasn't provided (e.g. opened directly from feed or bookmark),
    // lazily fetch the series in the background to populate prev/next chapter list!
    if (chapterList.length === 0 && seriesPermalink) {
      void fetchSeries(seriesPermalink).then((s) => {
        if (disposed) return;
        const cl: ChapterRef[] = [];
        for (const t of s.taggings ?? []) {
          if (t.title && t.permalink) {
            cl.push({ title: t.title, permalink: t.permalink, released_on: t.released_on });
          }
        }
        if (cl.length > 0) {
          chapterList = cl;
          updateChapterNav();
        }
      });
    }

    // ── Reader display mode state from localStorage ────────────────────────
    let isHorizontal = localStorage.getItem("ds-reader-mode") === "paged";
    let fitMode = (localStorage.getItem("ds-reader-fit") as "width" | "height" | "original") || "width";
    let scrollLock = localStorage.getItem("ds-reader-scroll-lock") === "1";
    let currentIndex = Math.min(route.startPage ?? 0, pages.length - 1);

    const readerContainer = document.createElement("div");
    readerContainer.id = "ds-reader-container";
    readerContainer.className = `fit-${fitMode}`;
    container.appendChild(readerContainer);

    // ── Reader navigation bar (sticky) ─────────────────────────────────────
    const nav = document.createElement("div");
    nav.className = "ds-reader-nav";

    const prevChapterBtn = document.createElement("button");
    prevChapterBtn.type = "button";
    prevChapterBtn.className = "win-button";
    prevChapterBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    prevChapterBtn.title = "Previous Chapter";
    prevChapterBtn.innerHTML = '<i class="bi bi-chevron-double-left"></i> Ch';

    const nextChapterBtn = document.createElement("button");
    nextChapterBtn.type = "button";
    nextChapterBtn.className = "win-button";
    nextChapterBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    nextChapterBtn.title = "Next Chapter";
    nextChapterBtn.innerHTML = 'Ch <i class="bi bi-chevron-double-right"></i>';

    const prevPageBtn = document.createElement("button");
    prevPageBtn.type = "button";
    prevPageBtn.className = "win-button";
    prevPageBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    prevPageBtn.title = "Previous Page (Left Arrow)";
    prevPageBtn.innerHTML = '<i class="bi bi-chevron-left"></i>';

    const nextPageBtn = document.createElement("button");
    nextPageBtn.type = "button";
    nextPageBtn.className = "win-button";
    nextPageBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    nextPageBtn.title = "Next Page (Right Arrow / Space)";
    nextPageBtn.innerHTML = '<i class="bi bi-chevron-right"></i>';

    const progressWrap = document.createElement("div");
    progressWrap.className = "ds-reader-progress-wrap";

    const progressPill = document.createElement("div");
    progressPill.className = "ds-reader-progress-pill";

    const positionLabel = document.createElement("span");
    positionLabel.className = "ds-reader-progress-label";
    progressPill.appendChild(positionLabel);
    progressWrap.appendChild(progressPill);

    const progressTrack = document.createElement("div");
    progressTrack.className = "ds-reader-progress-track";

    const progressFill = document.createElement("div");
    progressFill.className = "ds-reader-progress-fill";
    progressTrack.appendChild(progressFill);
    progressWrap.appendChild(progressTrack);

    // Scroll Lock toggle button (Wheel advances discrete page instead of free scroll)
    const scrollLockBtn = document.createElement("button");
    scrollLockBtn.type = "button";
    scrollLockBtn.className = `win-button${scrollLock ? " primary" : ""}`;
    scrollLockBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    scrollLockBtn.title = "Scroll Lock: mouse wheel flips exactly one page at a time";
    scrollLockBtn.innerHTML = scrollLock
      ? '<i class="bi bi-lock-fill"></i> Scroll Lock'
      : '<i class="bi bi-unlock"></i> Scroll Lock';

    // Layout mode toggle (Vertical Scroll vs Single Page Paged)
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "win-button";
    modeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    modeBtn.title = "Toggle Horizontal / Vertical reading mode";
    modeBtn.innerHTML = isHorizontal
      ? '<i class="bi bi-distribute-vertical"></i> Scroll'
      : '<i class="bi bi-arrow-left-right"></i> Paged';

    // Fit mode selector
    const fitSelect = document.createElement("select");
    fitSelect.className = "win-input";
    fitSelect.style.cssText = "font-size:11px;padding:2px 4px;";
    fitSelect.innerHTML =
      '<option value="width">Fit Width</option>' +
      '<option value="height">Fit Height</option>' +
      '<option value="original">Original Size</option>';
    fitSelect.value = fitMode;

    // Fullscreen toggle button (mimics app's image viewer)
    let isFullscreen = false;
    let resetToCurrentPage: (smooth?: boolean) => void = () => {};

    const fullscreenBtn = document.createElement("button");
    fullscreenBtn.type = "button";
    fullscreenBtn.className = "win-button";
    fullscreenBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    fullscreenBtn.title = "Toggle Fullscreen (F)";
    fullscreenBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fullscreen';

    const setFullscreen = (active: boolean): void => {
      isFullscreen = active;
      if (isFullscreen) {
        readerContainer.classList.add("ds-fullscreen");
        fullscreenBtn.className = "win-button primary";
        fullscreenBtn.innerHTML = '<i class="bi bi-fullscreen-exit"></i> Exit';
        fullscreenBtn.title = "Exit Fullscreen (Esc / F)";
        try {
          if (!document.fullscreenElement && document.fullscreenEnabled) {
            void readerContainer.requestFullscreen().catch(() => {});
          }
        } catch {}
      } else {
        readerContainer.classList.remove("ds-fullscreen");
        fullscreenBtn.className = "win-button";
        fullscreenBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fullscreen';
        fullscreenBtn.title = "Toggle Fullscreen (F)";
        try {
          if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        } catch {}
      }

      resetToCurrentPage(false);
      setTimeout(() => resetToCurrentPage(false), 60);
      setTimeout(() => resetToCurrentPage(false), 180);
    };

    fullscreenBtn.addEventListener("click", () => {
      setFullscreen(!isFullscreen);
    });

    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement && isFullscreen) {
        setFullscreen(false);
      } else {
        resetToCurrentPage(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    onDispose(() => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    });

    // Reader theme mode (Light default vs Dark)
    let readerTheme: "light" | "dark" = (localStorage.getItem("ds-reader-theme") as "light" | "dark") || "light";
    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "win-button";
    themeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    themeBtn.title = "Toggle Light / Dark Theme (T)";

    const applyTheme = (): void => {
      if (readerTheme === "dark") {
        readerContainer.classList.add("ds-dark");
        themeBtn.innerHTML = '<i class="bi bi-moon-fill"></i> Dark';
      } else {
        readerContainer.classList.remove("ds-dark");
        themeBtn.innerHTML = '<i class="bi bi-sun"></i> Light';
      }
    };

    themeBtn.addEventListener("click", () => {
      readerTheme = readerTheme === "light" ? "dark" : "light";
      localStorage.setItem("ds-reader-theme", readerTheme);
      applyTheme();
    });

    applyTheme();

    const updateChapterNav = (): void => {
      const curIdx = chapterList.findIndex((c) => c.permalink === permalink);
      prevChapterBtn.disabled = curIdx <= 0;
      nextChapterBtn.disabled = curIdx < 0 || curIdx >= chapterList.length - 1;
    };
    updateChapterNav();

    const gotoChapter = (c: ChapterRef): void => {
      navigate({
        view: "reader",
        seriesPermalink,
        seriesName,
        chapterPermalink: c.permalink,
        chapterTitle: c.title,
        chapterList,
      });
    };

    prevChapterBtn.addEventListener("click", () => {
      const curIdx = chapterList.findIndex((c) => c.permalink === permalink);
      if (curIdx > 0) gotoChapter(chapterList[curIdx - 1]);
    });
    nextChapterBtn.addEventListener("click", () => {
      const curIdx = chapterList.findIndex((c) => c.permalink === permalink);
      if (curIdx >= 0 && curIdx < chapterList.length - 1) gotoChapter(chapterList[curIdx + 1]);
    });

    nav.appendChild(prevChapterBtn);
    nav.appendChild(prevPageBtn);
    nav.appendChild(progressWrap);
    nav.appendChild(nextPageBtn);
    nav.appendChild(nextChapterBtn);
    nav.appendChild(scrollLockBtn);
    nav.appendChild(modeBtn);
    nav.appendChild(fitSelect);
    nav.appendChild(themeBtn);
    nav.appendChild(fullscreenBtn);
    readerContainer.appendChild(nav);

    // ── Viewport & Slots ───────────────────────────────────────────────────
    const viewport = document.createElement("div");
    viewport.id = "ds-reader-viewport";
    readerContainer.appendChild(viewport);

    // Compute exact available viewport height dynamically
    const updateViewportHeight = (): void => {
      const h = viewport.clientHeight;
      if (h > 50) {
        readerContainer.style.setProperty("--ds-viewport-full", `${h}px`);
        readerContainer.style.setProperty("--ds-viewport-height", `${h - 20}px`);
      }
    };
    const ro = new ResizeObserver(updateViewportHeight);
    ro.observe(viewport);
    onDispose(() => ro.disconnect());
    window.setTimeout(updateViewportHeight, 0);

    const strip = document.createElement("div");
    strip.id = "ds-reader-strip";
    viewport.appendChild(strip);

    const slots: HTMLElement[] = [];
    const cachedMap = new Map<number, string>();
    const queue: number[] = [];
    const inFlight = new Set<number>();
    const retrying = new Set<number>();
    const failed = new Set<number>();

    let cachedRows;
    try {
      cachedRows = await getCachedPages(permalink);
    } catch (err) {
      cachedRows = [];
      setBanner(`Page cache lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const row of cachedRows) {
      if (row.page_index >= 0 && row.page_index < pages.length && row.file_path) {
        cachedMap.set(row.page_index, row.file_path);
      }
    }
    let cachedCount = cachedMap.size;

    const renderSlotImg = (slot: HTMLElement, absPath: string, pageNum: number): void => {
      slot.classList.remove("ds-slot-loading");
      slot.innerHTML = "";
      const badge = document.createElement("div");
      badge.className = "ds-slot-page-badge";
      badge.textContent = `${pageNum} / ${pages.length}`;
      slot.appendChild(badge);

      const img = document.createElement("img");
      img.className = "ds-page-img";
      img.alt = `Page ${pageNum}`;
      img.addEventListener("error", () => {
        const idx = Number(slot.dataset.index);
        cachedMap.delete(idx);
        if (retrying.has(idx)) return;
        retrying.add(idx);
        renderSlotState(slot, "spinner", "Re-downloading…");
        enqueue(idx, true);
      });
      img.src = PH.convertFileSrc(absPath);
      slot.appendChild(img);
    };

    const renderSlotState = (
      slot: HTMLElement,
      kind: "spinner" | "offline" | "error",
      message: string
    ): void => {
      slot.innerHTML = "";
      const idx = Number(slot.dataset.index);
      const badge = document.createElement("div");
      badge.className = "ds-slot-page-badge";
      badge.textContent = `${idx + 1} / ${pages.length}`;
      slot.appendChild(badge);

      const state = document.createElement("div");
      state.className = `ds-slot-state${kind === "error" ? " ds-slot-error" : ""}`;
      if (kind === "spinner") {
        state.innerHTML =
          '<i class="bi bi-cloud-arrow-down" style="font-size:20px;color:var(--sys-primary,#0078d4);"></i>' +
          '<div class="ds-slot-pulse-wrap"><div class="ds-slot-pulse-bar"></div></div>';
      } else if (kind === "offline") {
        state.innerHTML = '<i class="bi bi-wifi-off" style="font-size:20px;"></i>';
      } else {
        state.innerHTML = '<i class="bi bi-exclamation-triangle" style="font-size:20px;"></i>';
      }
      const text = document.createElement("span");
      if (kind === "spinner") {
        const pct = pages.length > 0 ? Math.round((cachedCount / pages.length) * 100) : 0;
        text.textContent = `Downloading page ${idx + 1} of ${pages.length} (${cachedCount}/${pages.length} cached · ${pct}%)`;
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
          failed.delete(idx);
          renderSlotState(slot, "spinner", "Downloading…");
          enqueue(idx);
        });
        state.appendChild(retry);
      }
      slot.appendChild(state);
    };

    let firstErrorShown = false;

    const updateCacheCount = (): void => {
      cachedCount = cachedMap.size;
      updateProgressText();
      const pct = pages.length > 0 ? Math.round((cachedCount / pages.length) * 100) : 0;
      for (const slot of slots) {
        const idx = Number(slot.dataset.index);
        const absPath = cachedMap.get(idx);
        if (absPath) {
          // If cached but not yet rendered as an image, render it immediately
          if (!slot.querySelector("img.ds-page-img")) {
            renderSlotImg(slot, absPath, idx + 1);
          }
        } else {
          const spinner = slot.querySelector<HTMLElement>(".ds-slot-state:not(.ds-slot-error) span");
          if (spinner) {
            spinner.textContent = `Downloading page ${idx + 1} of ${pages.length} (${cachedCount}/${pages.length} cached · ${pct}%)`;
          }
        }
      }
    };

    const downloadPage = async (index: number): Promise<void> => {
      const page = pages[index];
      if (!page) return;
      const slot = slots[index] || strip.querySelector<HTMLElement>(`.ds-slot[data-index="${index}"]`);
      const outPath = pageOutputPath(seriesPermalink ?? "", permalink, index, page.url);
      try {
        // If the file already exists at the canonical path, skip the network entirely
        const existing = await fileResolve(outPath);
        let absPath: string;
        let sizeBytes = 0;
        if (existing) {
          absPath = existing;
        } else {
          const res = await httpDownloadFull(absUrl(page.url), outPath);
          absPath = res.absolutePath;
          sizeBytes = res.sizeBytes;
        }
        await setCachedPage(permalink, index, absPath, sizeBytes);
        cachedMap.set(index, absPath);
        if (!disposed && slot) {
          renderSlotImg(slot, absPath, index + 1);
        }
        updateCacheCount();
      } catch (err) {
        if (disposed) return;
        failed.add(index);
        const msg = err instanceof Error ? err.message : String(err);
        if (slot) renderSlotState(slot, "error", `Download failed: ${msg}`);
        if (!firstErrorShown) {
          firstErrorShown = true;
          setBanner(`Page download failed (page ${index + 1} of ${pages.length}). Use the slot's Retry.`);
        }
      }
    };

    const enqueue = (index: number, priority = false): void => {
      if (index < 0 || index >= pages.length) return;
      if (
        inFlight.has(index) ||
        failed.has(index)
      ) {
        return;
      }
      if (!queue.includes(index)) {
        if (priority) {
          queue.unshift(index);
        } else {
          queue.push(index);
        }
      }
      // Keep queue sorted by proximity to user's reading position: currentIndex, currentIndex+1, currentIndex+2...
      queue.sort((a, b) => {
        const distA = Math.abs(a - currentIndex) + (a < currentIndex ? 1000 : 0);
        const distB = Math.abs(b - currentIndex) + (b < currentIndex ? 1000 : 0);
        return distA - distB;
      });
      pump();
    };

    const pump = (): void => {
      while (inFlight.size < 1 && queue.length > 0) {
        const idx = queue.shift() as number;
        if (inFlight.has(idx)) continue;
        inFlight.add(idx);
        void downloadPage(idx).finally(() => {
          inFlight.delete(idx);
          pump();
        });
      }
    };

    for (let i = 0; i < pages.length; i++) {
      const slot = document.createElement("div");
      slot.className = "ds-slot";
      slot.dataset.index = String(i);
      const absPath = cachedMap.get(i);
      if (absPath) {
        renderSlotImg(slot, absPath, i + 1);
      } else if (!isOnline()) {
        renderSlotState(slot, "offline", "Offline — not downloaded");
      } else {
        renderSlotState(slot, "spinner", "Queued for download…");
        enqueue(i);
      }
      strip.appendChild(slot);
      slots.push(slot);
    }

    // Trigger priority download only for uncached start/nearby pages
    if (!cachedMap.has(currentIndex)) enqueue(currentIndex, true);
    if (!cachedMap.has(currentIndex + 1)) enqueue(currentIndex + 1, true);
    if (!cachedMap.has(currentIndex + 2)) enqueue(currentIndex + 2, true);

    // ── Background Cache Standardization ──────────────────────────────────
    // For pages not yet at the canonical path, probe all known legacy filename
    // patterns derived from the original URL and move the file on disk.
    // Zero network requests — purely local file operations.
    window.setTimeout(async () => {
      if (disposed) return;
      const cleanSeries = (seriesPermalink || "_singles").replace(/[^a-zA-Z0-9_-]/g, "_");
      const cleanChapter = permalink.replace(/[^a-zA-Z0-9_-]/g, "_");

      for (let i = 0; i < pages.length; i++) {
        if (disposed) return;
        const page = pages[i];
        if (!page) continue;
        const targetPath = pageOutputPath(seriesPermalink ?? "", permalink, i, page.url);

        // Skip if already at canonical path
        const alreadyThere = await fileResolve(targetPath);
        if (alreadyThere) {
          if (cachedMap.get(i) !== targetPath) {
            await setCachedPage(permalink, i, alreadyThere);
            cachedMap.set(i, alreadyThere);
            if (!disposed && slots[i]) {
              renderSlotImg(slots[i], alreadyThere, i + 1);
            }
            updateCacheCount();
          }
          continue;
        }

        // Build candidate legacy paths from the original URL filename
        const origName = page.url.split("/").pop() || "";
        const ext = origName.split(".").pop()?.split("?")[0] || "webp";
        const pad3 = String(i + 1).padStart(3, "0");
        const pad4 = String(i + 1).padStart(4, "0");
        const candidates = [
          // Series/chapter nesting with old 3-digit pad + original name
          `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/${pad3}_${origName}`,
          // Flat chapter-only folder with original name
          `${PAGES_PREFIX}/${cleanChapter}/${origName}`,
          // Singles folder
          `${PAGES_PREFIX}/_singles/${cleanChapter}/${origName}`,
          // Series folder with original name (no pad)
          `${PAGES_PREFIX}/${cleanSeries}/${cleanChapter}/${origName}`,
          // Old flat page_NNNN inside chapter-only folder
          `${PAGES_PREFIX}/${cleanChapter}/page_${pad4}.${ext}`,
        ];

        let found: string | null = null;
        for (const candidate of candidates) {
          found = await fileResolve(candidate);
          if (found) break;
        }

        if (found) {
          try {
            const newAbsPath = await fileMove(found, targetPath);
            await setCachedPage(permalink, i, newAbsPath);
            cachedMap.set(i, newAbsPath);
            if (!disposed && slots[i]) {
              renderSlotImg(slots[i], newAbsPath, i + 1);
            }
            updateCacheCount();
          } catch (e) {
            console.warn(`dynasty-scans: could not move page ${i + 1} to canonical path:`, e);
          }
        }
        // If nothing found: downloadPage already handles this via the queue
      }
    }, 2500);

    // ── Mode Switch & Navigation Logic ─────────────────────────────────────
    const updateProgressText = (): void => {
      const pct = pages.length > 0 ? Math.round(((currentIndex + 1) / pages.length) * 100) : 0;
      const cachedNote = cachedCount > 0 ? ` · ${cachedCount}/${pages.length} cached` : "";
      positionLabel.textContent = `Page ${currentIndex + 1} of ${pages.length} (${pct}%)${cachedNote}`;
      progressFill.style.width = `${pct}%`;
      prevPageBtn.disabled = currentIndex <= 0;
      nextPageBtn.disabled = currentIndex >= pages.length - 1;
    };

    let lastPersistedIndex = -1;
    let atEnd = false;
    let persistTimer: number | undefined;

    const persistNow = async (): Promise<void> => {
      if (lastPersistedIndex === currentIndex && !atEnd) return;
      lastPersistedIndex = currentIndex;
      try {
        await setReadingProgress({
          chapterPermalink: permalink,
          seriesPermalink: seriesPermalink ?? "",
          seriesName: seriesName ?? "",
          chapterTitle,
          pageIndex: currentIndex,
          pageTotal: pages.length,
          completed: atEnd,
        });
      } catch (err) {
        console.error("dynasty-scans: failed to persist reading progress:", err);
      }
    };

    const schedulePersist = (): void => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => void persistNow(), 400);
    };

    let isProgrammaticScroll = false;
    let programmaticScrollTimer: number | null = null;
    let scrollRaf: number | null = null;

    const setPage = (index: number): void => {
      if (index < 0 || index >= pages.length) return;
      currentIndex = index;
      atEnd = currentIndex >= pages.length - 1;
      updateProgressText();
      schedulePersist();
      if (atEnd) void persistNow();

      enqueue(currentIndex);
      enqueue(currentIndex + 1);
      enqueue(currentIndex + 2);

      if (isHorizontal) {
        if (!scrollLock) {
          // Force layout commit so transition:none takes effect before transform
          strip.style.transition = "none";
          void strip.offsetWidth; // trigger reflow
          strip.style.transform = `translateX(${-currentIndex * 100}%)`;
        } else {
          // Ensure transition is active then slide
          strip.style.transition = "";
          strip.style.transform = `translateX(${-currentIndex * 100}%)`;
        }
      } else {
        isProgrammaticScroll = true;
        if (programmaticScrollTimer !== null) clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = window.setTimeout(() => {
          isProgrammaticScroll = false;
        }, 350);

        const target = slots[currentIndex];
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    };

    resetToCurrentPage = (smooth = false): void => {
      updateViewportHeight();
      if (isHorizontal) {
        if (!smooth) {
          strip.style.transition = "none";
          void strip.offsetWidth;
          strip.style.transform = `translateX(${-currentIndex * 100}%)`;
          requestAnimationFrame(() => {
            strip.style.transition = "";
          });
        } else {
          strip.style.transform = `translateX(${-currentIndex * 100}%)`;
        }
      } else {
        isProgrammaticScroll = true;
        if (programmaticScrollTimer !== null) clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = window.setTimeout(() => {
          isProgrammaticScroll = false;
        }, 350);

        const target = slots[currentIndex];
        if (target) {
          target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
        }
      }
      updateProgressText();
    };

    prevPageBtn.addEventListener("click", () => setPage(currentIndex - 1));
    nextPageBtn.addEventListener("click", () => setPage(currentIndex + 1));

    const applyLayoutMode = (): void => {
      if (isHorizontal) {
        modeBtn.innerHTML = '<i class="bi bi-distribute-vertical"></i> Scroll';
        viewport.classList.add("horizontal");
        // Jump to current page instantly (no animation on mode switch)
        strip.style.transition = "none";
        strip.style.transform = `translateX(${-currentIndex * 100}%)`;
        // Re-enable transition after the paint
        requestAnimationFrame(() => {
          strip.style.transition = "";
        });
      } else {
        modeBtn.innerHTML = '<i class="bi bi-arrow-left-right"></i> Paged';
        viewport.classList.remove("horizontal");
        strip.style.transform = "";
        strip.style.transition = "";
        const target = slots[currentIndex];
        if (target) target.scrollIntoView({ block: "start" });
      }
    };

    if (isHorizontal) {
      applyLayoutMode();
    }

    const updateScrollLockBtn = (): void => {
      if (isHorizontal) {
        scrollLockBtn.className = `win-button${scrollLock ? " primary" : ""}`;
        scrollLockBtn.innerHTML = '<i class="bi bi-arrow-left-right"></i> Scroll Smooth';
      } else {
        scrollLockBtn.className = `win-button${scrollLock ? " primary" : ""}`;
        scrollLockBtn.innerHTML = scrollLock
          ? '<i class="bi bi-lock-fill"></i> Scroll Lock'
          : '<i class="bi bi-unlock"></i> Scroll Lock';
      }
    };

    scrollLockBtn.addEventListener("click", () => {
      scrollLock = !scrollLock;
      localStorage.setItem("ds-reader-scroll-lock", scrollLock ? "1" : "0");
      updateScrollLockBtn();
    });

    updateScrollLockBtn();

    // Wheel event handler for Scroll Lock and Paged mode
    let wheelDebounce = 0;
    const onWheel = (ev: WheelEvent): void => {
      // In Paged mode (isHorizontal), wheel scrolling always turns pages (natural page flipping)
      // In Continuous Scroll mode, wheel scrolling turns pages when Scroll Lock is active
      if (!scrollLock && !isHorizontal) return;
      ev.preventDefault();
      const now = Date.now();
      if (now - wheelDebounce < 180) return; // debounce quick multi-notches
      if (Math.abs(ev.deltaY) < 10 && Math.abs(ev.deltaX) < 10) return;

      wheelDebounce = now;
      const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;

      if (!isHorizontal) {
        // Vertical Scroll mode with Scroll Lock:
        // Position-aware directional page flipping so it always advances in the scrolling direction
        const vpRect = viewport.getBoundingClientRect();
        if (delta > 0) {
          // Scrolling down: advance to the next slot below the current top of the viewport
          let targetIdx = currentIndex + 1;
          for (let i = 0; i < slots.length; i++) {
            const r = slots[i].getBoundingClientRect();
            if (r.top > vpRect.top + 20) {
              targetIdx = i;
              break;
            }
          }
          setPage(Math.min(pages.length - 1, targetIdx));
        } else {
          // Scrolling up: retreat to the slot above the current top of the viewport
          let targetIdx = currentIndex - 1;
          for (let i = slots.length - 1; i >= 0; i--) {
            const r = slots[i].getBoundingClientRect();
            if (r.top < vpRect.top - 20) {
              targetIdx = i;
              break;
            }
          }
          setPage(Math.max(0, targetIdx));
        }
      } else {
        // Paged mode (Horizontal)
        if (delta > 0) {
          setPage(currentIndex + 1);
        } else {
          setPage(currentIndex - 1);
        }
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    onDispose(() => viewport.removeEventListener("wheel", onWheel));

    modeBtn.addEventListener("click", () => {
      isHorizontal = !isHorizontal;
      localStorage.setItem("ds-reader-mode", isHorizontal ? "paged" : "scroll");
      applyLayoutMode();
      updateScrollLockBtn();
    });

    fitSelect.addEventListener("change", () => {
      fitMode = fitSelect.value as "width" | "height" | "original";
      localStorage.setItem("ds-reader-fit", fitMode);
      readerContainer.className = `fit-${fitMode}`;
    });

    // Vertical scroll tracking via focal line position with requestAnimationFrame
    const computeCurrentPageFromScroll = (): void => {
      if (isHorizontal || isProgrammaticScroll) return;
      const vpRect = viewport.getBoundingClientRect();
      const focalY = vpRect.top + vpRect.height * 0.35;

      let bestIdx = currentIndex;
      for (let i = 0; i < slots.length; i++) {
        const r = slots[i].getBoundingClientRect();
        if (r.top <= focalY && r.bottom > focalY) {
          bestIdx = i;
          break;
        }
        if (r.top > focalY) {
          bestIdx = i > 0 ? i - 1 : 0;
          break;
        }
        bestIdx = i;
      }

      if (bestIdx !== currentIndex) {
        currentIndex = bestIdx;
        atEnd = currentIndex >= pages.length - 1;
        updateProgressText();
        schedulePersist();
        if (atEnd) void persistNow();
      }
    };

    const onViewportScroll = (): void => {
      if (isHorizontal || isProgrammaticScroll) return;
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        computeCurrentPageFromScroll();
        scrollRaf = null;
      });
    };
    viewport.addEventListener("scroll", onViewportScroll, { passive: true });
    onDispose(() => {
      viewport.removeEventListener("scroll", onViewportScroll);
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
    });

    // Preloading upcoming pages in scroll mode via IntersectionObserver
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.index);
            enqueue(idx);
            enqueue(idx + 1);
            enqueue(idx + 2);
          }
        }
      },
      { root: viewport, rootMargin: "400px 0px", threshold: 0 }
    );
    slots.forEach((s) => observer.observe(s));
    onDispose(() => observer.disconnect());

    const onKeyDown = (ev: KeyboardEvent): void => {
      // Ignore if user is typing in an input or textarea
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        setPage(currentIndex - 1);
      } else if (ev.key === "ArrowRight" || ev.key === " ") {
        ev.preventDefault();
        setPage(currentIndex + 1);
      } else if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        setFullscreen(!isFullscreen);
      } else if (ev.key === "t" || ev.key === "T") {
        ev.preventDefault();
        readerTheme = readerTheme === "light" ? "dark" : "light";
        localStorage.setItem("ds-reader-theme", readerTheme);
        applyTheme();
      } else if (ev.key === "Escape" && isFullscreen) {
        ev.preventDefault();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onDispose(() => window.removeEventListener("keydown", onKeyDown));

    updateProgressText();

    // ── History + top-bar actions ──────────────────────────────────────────
    try {
      await addHistory({
        chapterPermalink: permalink,
        seriesPermalink: seriesPermalink ?? "",
        seriesName: seriesName ?? "",
        chapterTitle,
      });
    } catch (err) {
      console.error("dynasty-scans: failed to record history:", err);
    }

    let bookmarked = false;
    try {
      const bm = await getBookmark(permalink);
      bookmarked = bm !== null;
    } catch {
      bookmarked = false;
    }

    setActions((host) => {
      if (seriesPermalink) {
        const seriesBtn = document.createElement("button");
        seriesBtn.type = "button";
        seriesBtn.className = "win-button";
        seriesBtn.title = "Open the containing series";
        seriesBtn.innerHTML = '<i class="bi bi-collection"></i> Series';
        seriesBtn.addEventListener("click", () => {
          navigate({
            view: "series",
            seriesPermalink,
            seriesName: seriesName ?? chapterTitle,
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
            await removeBookmark(permalink);
            bookmarked = false;
          } else {
            await addBookmark({
              chapterPermalink: permalink,
              seriesPermalink: seriesPermalink ?? "",
              seriesName: seriesName ?? "",
              chapterTitle,
              pageIndex: currentIndex,
            });
            bookmarked = true;
          }
          bmBtn.innerHTML = bookmarked
            ? '<i class="bi bi-bookmark-fill"></i>'
            : '<i class="bi bi-bookmark"></i>';
          bmBtn.title = bookmarked ? "Remove bookmark" : "Bookmark this chapter";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setBanner(`Bookmark failed: ${msg}`);
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
        for (let i = 0; i < pages.length; i++) {
          if (!cachedMap.has(i) && !failed.has(i)) enqueue(i);
        }
        setBanner("Caching chapter…");
      });
      host.appendChild(cacheBtn);

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "win-button";
      openBtn.title = "Open this chapter in your browser";
      openBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
      openBtn.addEventListener("click", () => {
        void openExternal(`https://dynasty-scans.com/chapters/${permalink}`);
      });
      host.appendChild(openBtn);
    });

    // ── Jump to initial resume page ────────────────────────────────────────
    const startPage = route.startPage ?? 0;
    if (startPage > 0) {
      setPage(startPage);
    }
  })();

  return () => {
    disposed = true;
    for (const fn of cleanup) fn();
  };
}