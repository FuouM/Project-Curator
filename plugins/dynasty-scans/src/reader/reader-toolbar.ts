import type { ReaderController } from "./reader-controller";
import type { FitMode } from "../types/reader";
import type { ChapterRef } from "../types/routes";

/**
 * Builds the reader's sticky top navigation bar: chapter/page navigation
 * buttons, the progress track, and the mode/fit/theme/fullscreen/scroll-lock
 * toggles. Reads controller-owned state; writes back on user interaction.
 */
export class ReaderToolbar {
  constructor(private readonly c: ReaderController) {
    this.build();
  }

  /** Finishes wiring after the slot strip exists (applies saved mode + labels). */
  wireAfterSlots(): void {
    const c = this.c;
    c.updateChapterNav();
    if (c.isHorizontal) {
      c.viewportImpl.applyLayoutMode();
    }
    this.updateScrollLockBtn();
    this.applyTheme();
  }

  private build(): void {
    const c = this.c;
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
    scrollLockBtn.className = `win-button${c.scrollLock ? " primary" : ""}`;
    scrollLockBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    scrollLockBtn.title = "Scroll Lock: mouse wheel flips exactly one page at a time";
    scrollLockBtn.innerHTML = c.scrollLock
      ? '<i class="bi bi-lock-fill"></i> Scroll Lock'
      : '<i class="bi bi-unlock"></i> Scroll Lock';

    // Layout mode toggle (Vertical Scroll vs Single Page Paged)
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "win-button";
    modeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    modeBtn.title = "Toggle Horizontal / Vertical reading mode";
    modeBtn.innerHTML = c.isHorizontal
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
    fitSelect.value = c.fitMode;

    // Fullscreen toggle button (mimics app's image viewer)
    const fullscreenBtn = document.createElement("button");
    fullscreenBtn.type = "button";
    fullscreenBtn.className = "win-button";
    fullscreenBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    fullscreenBtn.title = "Toggle Fullscreen (F)";
    fullscreenBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fullscreen';

    // Reader theme mode (Light default vs Dark)
    const themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "win-button";
    themeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    themeBtn.title = "Toggle Light / Dark Theme (T)";

    // Zoom In / Out buttons (rightmost)
    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.type = "button";
    zoomOutBtn.className = "win-button";
    zoomOutBtn.style.cssText = "font-size:11px;padding:2px 7px;";
    zoomOutBtn.title = "Zoom Out (Ctrl - / -)";
    zoomOutBtn.innerHTML = '<i class="bi bi-dash-lg"></i>';

    const zoomResetBtn = document.createElement("button");
    zoomResetBtn.type = "button";
    zoomResetBtn.className = "win-button";
    zoomResetBtn.style.cssText = "font-size:11px;padding:2px 6px;min-width:44px;";
    zoomResetBtn.title = "Reset Zoom (Ctrl 0)";
    zoomResetBtn.textContent = "100%";

    const zoomInBtn = document.createElement("button");
    zoomInBtn.type = "button";
    zoomInBtn.className = "win-button";
    zoomInBtn.style.cssText = "font-size:11px;padding:2px 7px;";
    zoomInBtn.title = "Zoom In (Ctrl + / +)";
    zoomInBtn.innerHTML = '<i class="bi bi-plus-lg"></i>';

    const updateZoomUI = (): void => {
      const isFitActive = c.fitMode !== "original";
      zoomResetBtn.textContent = `${Math.round(c.zoomScale * 100)}%`;
      c.readerContainer.style.setProperty("--ds-zoom-scale", String(c.zoomScale));
      zoomOutBtn.disabled = isFitActive || c.zoomScale <= 0.25;
      zoomResetBtn.disabled = isFitActive;
      zoomInBtn.disabled = isFitActive || c.zoomScale >= 3.0;

      if (isFitActive) {
        zoomOutBtn.title = "Zoom disabled when Fit mode is active (set to Original Size to zoom)";
        zoomResetBtn.title = "Zoom disabled when Fit mode is active";
        zoomInBtn.title = "Zoom disabled when Fit mode is active (set to Original Size to zoom)";
      } else {
        zoomOutBtn.title = "Zoom Out (Ctrl - / -)";
        zoomResetBtn.title = "Reset Zoom (Ctrl 0)";
        zoomInBtn.title = "Zoom In (Ctrl + / +)";
      }
    };

    zoomOutBtn.addEventListener("click", () => {
      if (c.fitMode !== "original") return;
      c.zoomScale = Math.max(0.25, Math.round((c.zoomScale - 0.1) * 10) / 10);
      updateZoomUI();
    });
    zoomResetBtn.addEventListener("click", () => {
      if (c.fitMode !== "original") return;
      c.zoomScale = 1.0;
      updateZoomUI();
    });
    zoomInBtn.addEventListener("click", () => {
      if (c.fitMode !== "original") return;
      c.zoomScale = Math.min(3.0, Math.round((c.zoomScale + 0.1) * 10) / 10);
      updateZoomUI();
    });

    // Store DOM refs on the controller so progress/shortcut code can reach them
    c.prevChapterBtn = prevChapterBtn;
    c.nextChapterBtn = nextChapterBtn;
    c.prevPageBtn = prevPageBtn;
    c.nextPageBtn = nextPageBtn;
    c.positionLabel = positionLabel;
    c.progressFill = progressFill;
    c.scrollLockBtn = scrollLockBtn;
    c.modeBtn = modeBtn;
    c.fitSelect = fitSelect;
    c.fullscreenBtn = fullscreenBtn;
    c.themeBtn = themeBtn;

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
    nav.appendChild(zoomOutBtn);
    nav.appendChild(zoomResetBtn);
    nav.appendChild(zoomInBtn);
    c.readerContainer.appendChild(nav);

    updateZoomUI();

    const gotoChapter = (ch: ChapterRef): void => c.gotoChapter(ch);

    prevChapterBtn.addEventListener("click", () => {
      const curIdx = c.chapterList.findIndex((x) => x.permalink === c.permalink);
      if (curIdx > 0) gotoChapter(c.chapterList[curIdx - 1]);
    });
    nextChapterBtn.addEventListener("click", () => {
      const curIdx = c.chapterList.findIndex((x) => x.permalink === c.permalink);
      if (curIdx >= 0 && curIdx < c.chapterList.length - 1) gotoChapter(c.chapterList[curIdx + 1]);
    });

    prevPageBtn.addEventListener("click", () => c.setPage(c.currentIndex - 1));
    nextPageBtn.addEventListener("click", () => c.setPage(c.currentIndex + 1));

    scrollLockBtn.addEventListener("click", () => {
      c.scrollLock = !c.scrollLock;
      localStorage.setItem("ds-reader-scroll-lock", c.scrollLock ? "1" : "0");
      this.updateScrollLockBtn();
    });

    modeBtn.addEventListener("click", () => {
      c.isHorizontal = !c.isHorizontal;
      localStorage.setItem("ds-reader-mode", c.isHorizontal ? "paged" : "scroll");
      c.viewportImpl.applyLayoutMode();
      this.updateScrollLockBtn();
    });

    fitSelect.addEventListener("change", () => {
      c.readerContainer.classList.remove("fit-width", "fit-height", "fit-original");
      c.fitMode = fitSelect.value as FitMode;
      localStorage.setItem("ds-reader-fit", c.fitMode);
      c.readerContainer.classList.add(`fit-${c.fitMode}`);
      if (c.fitMode !== "original") {
        c.zoomScale = 1.0;
      }
      updateZoomUI();
    });

    themeBtn.addEventListener("click", () => this.toggleTheme());
    fullscreenBtn.addEventListener("click", () => this.setFullscreen(!c.isFullscreen));

    this.applyTheme();

    // Fullscreenchange synchronization (Esc exits fullscreen natively)
    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement && c.isFullscreen) {
        this.setFullscreen(false);
      } else {
        c.viewportImpl.resetToCurrentPage(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    c.onDispose(() => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    });
  }

  setFullscreen(active: boolean): void {
    const c = this.c;
    c.isFullscreen = active;
    if (c.isFullscreen) {
      c.readerContainer.classList.add("ds-fullscreen");
      c.fullscreenBtn.className = "win-button primary";
      c.fullscreenBtn.innerHTML = '<i class="bi bi-fullscreen-exit"></i> Exit';
      c.fullscreenBtn.title = "Exit Fullscreen (Esc / F)";
      try {
        if (!document.fullscreenElement && document.fullscreenEnabled) {
          void c.readerContainer.requestFullscreen().catch(() => {});
        }
      } catch {}
    } else {
      c.readerContainer.classList.remove("ds-fullscreen");
      c.fullscreenBtn.className = "win-button";
      c.fullscreenBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fullscreen';
      c.fullscreenBtn.title = "Toggle Fullscreen (F)";
      try {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
      } catch {}
    }

    c.viewportImpl.resetToCurrentPage(false);
    setTimeout(() => c.viewportImpl.resetToCurrentPage(false), 60);
    setTimeout(() => c.viewportImpl.resetToCurrentPage(false), 180);
  }

  toggleTheme(): void {
    const c = this.c;
    c.readerTheme = c.readerTheme === "light" ? "dark" : "light";
    localStorage.setItem("ds-reader-theme", c.readerTheme);
    this.applyTheme();
  }

  applyTheme(): void {
    const c = this.c;
    if (c.readerTheme === "dark") {
      c.readerContainer.classList.add("ds-dark");
      c.themeBtn.innerHTML = '<i class="bi bi-moon-fill"></i> Dark';
    } else {
      c.readerContainer.classList.remove("ds-dark");
      c.themeBtn.innerHTML = '<i class="bi bi-sun"></i> Light';
    }
  }

  updateScrollLockBtn(): void {
    const c = this.c;
    if (c.isHorizontal) {
      c.scrollLockBtn.className = `win-button${c.scrollLock ? " primary" : ""}`;
      c.scrollLockBtn.innerHTML = '<i class="bi bi-arrow-left-right"></i> Scroll Smooth';
    } else {
      c.scrollLockBtn.className = `win-button${c.scrollLock ? " primary" : ""}`;
      c.scrollLockBtn.innerHTML = c.scrollLock
        ? '<i class="bi bi-lock-fill"></i> Scroll Lock'
        : '<i class="bi bi-unlock"></i> Scroll Lock';
    }
  }
}
