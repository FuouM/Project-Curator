import type { ReaderController } from "./reader-controller";
import { isAutoCacheChapterEnabled, getPrefetchBuffer } from "./settings";

/**
 * Owns the reader's strip/paged layout engines: viewport + strip DOM, dynamic
 * height measurement, mode-switch transitions, scroll-position tracking, the
 * IntersectionObserver preloader, and the wheel page-flip gesture.
 */
export class ReaderViewport {
  private wheelDebounce = 0;

  constructor(private readonly c: ReaderController) {
    this.build();
  }

  private build(): void {
    const c = this.c;

    const viewport = document.createElement("div");
    viewport.id = "ds-reader-viewport";
    c.readerContainer.appendChild(viewport);
    c.viewport = viewport;

    const strip = document.createElement("div");
    strip.id = "ds-reader-strip";
    viewport.appendChild(strip);
    c.strip = strip;

    // Compute exact available viewport height dynamically
    const updateViewportHeight = (): void => {
      const h = viewport.clientHeight;
      if (h > 50) {
        c.readerContainer.style.setProperty("--ds-viewport-full", `${h}px`);
        c.readerContainer.style.setProperty("--ds-viewport-height", `${h - 20}px`);
      }
    };
    const ro = new ResizeObserver(updateViewportHeight);
    ro.observe(viewport);
    c.onDispose(() => ro.disconnect());
    window.setTimeout(updateViewportHeight, 0);
  }

  /** Jumps to a page: paged mode slides the strip; scroll mode scrolls into view.
   *  `instant` disables the smooth animation (used for the initial resume restore
   *  so the first page never flashes while scrolling from the top). */
  slideTo(index: number, instant = false, scrollToBottom = false): void {
    const c = this.c;
    if (c.isHorizontal) {
      const targetSlot = c.slots[index];
      if (targetSlot) {
        if (scrollToBottom) {
          // Jump to bottom of previous page so upward scrolling continues seamlessly
          targetSlot.scrollTop = Math.max(0, targetSlot.scrollHeight - targetSlot.clientHeight);
        } else {
          targetSlot.scrollTop = 0;
        }
        targetSlot.scrollLeft = 0;
      }
      if (!c.scrollLock) {
        // Force layout commit so transition:none takes effect before transform
        c.strip.style.transition = "none";
        void c.strip.offsetWidth; // trigger reflow
        c.strip.style.transform = `translateX(${-index * 100}%)`;
      } else {
        // Ensure transition is active then slide
        c.strip.style.transition = "";
        c.strip.style.transform = `translateX(${-index * 100}%)`;
      }
    } else {
      c.isProgrammaticScroll = true;
      if (c.programmaticScrollTimer !== null) clearTimeout(c.programmaticScrollTimer);
      c.programmaticScrollTimer = window.setTimeout(() => {
        c.isProgrammaticScroll = false;
      }, 350);

      const target = c.slots[index];
      if (target) {
        target.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
      }
    }
  }

  /** Restores the reader to the current page (used on resize / mode / fullscreen changes). */
  resetToCurrentPage(smooth = false): void {
    const c = this.c;
    const updateViewportHeight = (): void => {
      const h = c.viewport.clientHeight;
      if (h > 50) {
        c.readerContainer.style.setProperty("--ds-viewport-full", `${h}px`);
        c.readerContainer.style.setProperty("--ds-viewport-height", `${h - 20}px`);
      }
    };
    updateViewportHeight();
    if (c.isHorizontal) {
      if (!smooth) {
        c.strip.style.transition = "none";
        void c.strip.offsetWidth;
        c.strip.style.transform = `translateX(${-c.currentIndex * 100}%)`;
        requestAnimationFrame(() => {
          c.strip.style.transition = "";
        });
      } else {
        c.strip.style.transform = `translateX(${-c.currentIndex * 100}%)`;
      }
    } else {
      c.isProgrammaticScroll = true;
      if (c.programmaticScrollTimer !== null) clearTimeout(c.programmaticScrollTimer);
      c.programmaticScrollTimer = window.setTimeout(() => {
        c.isProgrammaticScroll = false;
      }, 350);

      const target = c.slots[c.currentIndex];
      if (target) {
        target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      }
    }
    c.updateProgressText();
  }

  /** Applies the current mode to the viewport/strip and updates the mode button icon. */
  applyLayoutMode(): void {
    const c = this.c;
    if (c.isHorizontal) {
      c.modeBtn.innerHTML = '<i class="bi bi-distribute-vertical"></i> Scroll';
      c.viewport.classList.add("horizontal");
      // Jump to current page instantly (no animation on mode switch)
      c.strip.style.transition = "none";
      c.strip.style.transform = `translateX(${-c.currentIndex * 100}%)`;
      // Re-enable transition after the paint
      requestAnimationFrame(() => {
        c.strip.style.transition = "";
      });
    } else {
      c.modeBtn.innerHTML = '<i class="bi bi-arrow-left-right"></i> Paged';
      c.viewport.classList.remove("horizontal");
      c.strip.style.transform = "";
      c.strip.style.transition = "";
      const target = c.slots[c.currentIndex];
      if (target) target.scrollIntoView({ block: "start" });
    }
  }

  private attachScrollTracking(): void {
    const c = this.c;

    const computeCurrentPageFromScroll = (): void => {
      if (c.isHorizontal || c.isProgrammaticScroll) return;
      const vpRect = c.viewport.getBoundingClientRect();
      const focalY = vpRect.top + vpRect.height * 0.35;

      let bestIdx = c.currentIndex;
      for (let i = 0; i < c.slots.length; i++) {
        const r = c.slots[i].getBoundingClientRect();
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

      if (bestIdx !== c.currentIndex) {
        c.currentIndex = bestIdx;
        c.atEnd = c.currentIndex >= c.pages.length - 1;
        c.updateProgressText();
        c.schedulePersist();
        if (c.atEnd) void c.persistNow();
      }
    };

    const onViewportScroll = (): void => {
      if (c.isHorizontal || c.isProgrammaticScroll) return;
      if (c.scrollRaf !== null) cancelAnimationFrame(c.scrollRaf);
      c.scrollRaf = requestAnimationFrame(() => {
        computeCurrentPageFromScroll();
        c.scrollRaf = null;
      });
    };
    c.viewport.addEventListener("scroll", onViewportScroll, { passive: true });
    c.onDispose(() => {
      c.viewport.removeEventListener("scroll", onViewportScroll);
      if (c.scrollRaf !== null) cancelAnimationFrame(c.scrollRaf);
    });
  }

  private attachPreloader(): void {
    const c = this.c;
    const observer = new IntersectionObserver(
      (entries) => {
        // In horizontal (paged) mode, slot loading is driven explicitly by setPage()
        if (c.isHorizontal) return;

        const autoCache = isAutoCacheChapterEnabled();
        const prefetchCount = getPrefetchBuffer();

        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.index);
            c.enqueue(idx);
            if (autoCache) {
              c.enqueue(idx + 1);
              c.enqueue(idx + 2);
            } else {
              for (let offset = 1; offset <= prefetchCount; offset++) {
                if (idx + offset < c.pages.length) {
                  c.enqueue(idx + offset);
                }
              }
            }
          }
        }
      },
      { root: c.viewport, rootMargin: "0px 0px", threshold: 0.05 },
    );
    c.slots.forEach((s) => observer.observe(s));
    c.onDispose(() => observer.disconnect());
  }

  /** Called once slots exist. Attaches scroll tracking, preloading, wheel, and drag panning. */
  wireAfterSlots(): void {
    this.attachScrollTracking();
    this.attachPreloader();
    this.attachWheel();
    this.attachDragPanning();
  }

  private attachDragPanning(): void {
    const c = this.c;
    let isDown = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;
    let activeSlot: HTMLElement | null = null;
    let isViewportPan = false;

    const onMouseDown = (ev: MouseEvent): void => {
      // Primary mouse button only
      if (ev.button !== 0) return;
      
      // Do not initiate drag pan if clicking buttons, links, or inputs
      if ((ev.target as HTMLElement)?.closest("button, a, input, select, textarea")) return;

      if (c.isHorizontal) {
        const target = (ev.target as HTMLElement)?.closest<HTMLElement>(".ds-slot");
        if (!target) return;
        if (target.scrollWidth <= target.clientWidth && target.scrollHeight <= target.clientHeight) {
          return;
        }

        isDown = true;
        isViewportPan = false;
        activeSlot = target;
        activeSlot.classList.add("ds-dragging");
        startX = ev.pageX;
        startY = ev.pageY;
        scrollLeft = activeSlot.scrollLeft;
        scrollTop = activeSlot.scrollTop;
        ev.preventDefault();
      } else {
        // Vertical scroll mode
        const vp = c.viewport;
        if (!vp) return;
        if (vp.scrollWidth <= vp.clientWidth && vp.scrollHeight <= vp.clientHeight) {
          return;
        }

        isDown = true;
        isViewportPan = true;
        c.viewport.classList.add("ds-dragging");
        startX = ev.pageX;
        startY = ev.pageY;
        scrollLeft = vp.scrollLeft;
        scrollTop = vp.scrollTop;
        ev.preventDefault();
      }
    };

    const onMouseMove = (ev: MouseEvent): void => {
      if (!isDown) return;
      ev.preventDefault();
      const dx = ev.pageX - startX;
      const dy = ev.pageY - startY;

      if (isViewportPan && c.viewport) {
        c.viewport.scrollLeft = scrollLeft - dx;
        c.viewport.scrollTop = scrollTop - dy;
      } else if (activeSlot) {
        activeSlot.scrollLeft = scrollLeft - dx;
        activeSlot.scrollTop = scrollTop - dy;
      }
    };

    const onMouseUp = (): void => {
      if (!isDown) return;
      isDown = false;
      if (activeSlot) {
        activeSlot.classList.remove("ds-dragging");
        activeSlot = null;
      }
      if (isViewportPan && c.viewport) {
        c.viewport.classList.remove("ds-dragging");
        isViewportPan = false;
      }
    };

    c.viewport.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    c.onDispose(() => {
      c.viewport.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  }

  private attachWheel(): void {
    const c = this.c;
    let momentumDir: "next" | "prev" | null = null;
    let momentumTimer: number | null = null;
    let indicator: HTMLElement | null = null;

    const showIndicator = (type: "next" | "prev"): void => {
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "ds-snap-indicator";
        c.viewport.appendChild(indicator);
      }
      indicator.className = `ds-snap-indicator ${type === "next" ? "bottom" : "top"} visible`;
      indicator.innerHTML =
        type === "next"
          ? '<i class="bi bi-chevron-double-down"></i> Scroll again for Next Page'
          : '<i class="bi bi-chevron-double-up"></i> Scroll again for Prev Page';
    };

    const hideIndicator = (): void => {
      if (indicator) {
        indicator.classList.remove("visible");
      }
      momentumDir = null;
    };

    const onWheel = (ev: WheelEvent): void => {
      // Ignore if event target is an input / textarea / select
      const targetTag = (ev.target as HTMLElement)?.tagName;
      if (targetTag === "INPUT" || targetTag === "TEXTAREA" || targetTag === "SELECT") return;

      if (c.isHorizontal) {
        const slot = c.slots[c.currentIndex];
        const hasScroll = slot && slot.scrollHeight > slot.clientHeight + 4;

        if (hasScroll) {
          const maxScrollTop = slot.scrollHeight - slot.clientHeight;
          const atTop = slot.scrollTop <= 2 && ev.deltaY < 0;
          const atBottom = slot.scrollTop >= maxScrollTop - 2 && ev.deltaY > 0;

          if (!atTop && !atBottom) {
            // Scroll inside slot programmatically so browser never blocks wheel stream
            ev.preventDefault();
            slot.scrollTop = Math.max(0, Math.min(maxScrollTop, slot.scrollTop + ev.deltaY));
            hideIndicator();
            return;
          }

          ev.preventDefault();
          const targetDir: "next" | "prev" = atBottom ? "next" : "prev";

          // If at the first page (no previous) or last page (no next), do not show indicator
          if (
            (targetDir === "prev" && c.currentIndex <= 0) ||
            (targetDir === "next" && c.currentIndex >= c.pages.length - 1)
          ) {
            hideIndicator();
            return;
          }

          // If at the boundary and not primed in this direction yet
          if (momentumDir !== targetDir) {
            momentumDir = targetDir;
            showIndicator(targetDir);
            if (momentumTimer !== null) clearTimeout(momentumTimer);
            momentumTimer = window.setTimeout(hideIndicator, 1200);
            return;
          }

          // Second deliberate scroll in the same direction: flip page
          hideIndicator();
          if (momentumTimer !== null) clearTimeout(momentumTimer);
          if (targetDir === "next") {
            c.setPage(c.currentIndex + 1, false, false);
          } else {
            c.setPage(c.currentIndex - 1, false, true);
          }
          return;
        }

        // Standard paged mode without vertical overflow: flip page directly
        hideIndicator();
        ev.preventDefault();
        const now = Date.now();
        if (now - this.wheelDebounce < 180) return;
        if (Math.abs(ev.deltaY) < 10 && Math.abs(ev.deltaX) < 10) return;
        this.wheelDebounce = now;
        const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
        if (delta > 0) {
          c.setPage(c.currentIndex + 1);
        } else {
          c.setPage(c.currentIndex - 1);
        }
        return;
      }

      hideIndicator();

      // In Continuous Scroll mode, wheel scrolling turns pages when Scroll Lock is active
      if (!c.scrollLock) return;
      ev.preventDefault();
      const now = Date.now();
      if (now - this.wheelDebounce < 180) return;
      if (Math.abs(ev.deltaY) < 10 && Math.abs(ev.deltaX) < 10) return;
      this.wheelDebounce = now;
      const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;

      const vpRect = c.viewport.getBoundingClientRect();
      if (delta > 0) {
        let targetIdx = c.currentIndex + 1;
        for (let i = 0; i < c.slots.length; i++) {
          const r = c.slots[i].getBoundingClientRect();
          if (r.top > vpRect.top + 20) {
            targetIdx = i;
            break;
          }
        }
        c.setPage(Math.min(c.pages.length - 1, targetIdx));
      } else {
        let targetIdx = c.currentIndex - 1;
        for (let i = c.slots.length - 1; i >= 0; i--) {
          const r = c.slots[i].getBoundingClientRect();
          if (r.top < vpRect.top - 20) {
            targetIdx = i;
            break;
          }
        }
        c.setPage(Math.max(0, targetIdx));
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    c.onDispose(() => window.removeEventListener("wheel", onWheel));
  }
}
