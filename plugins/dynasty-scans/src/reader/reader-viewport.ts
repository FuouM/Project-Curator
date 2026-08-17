import type { ReaderController } from "./reader-controller";

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

  /** Called once slots exist. Attaches scroll tracking, preloading, and wheel. */
  wireAfterSlots(): void {
    const c = this.c;
    this.attachScrollTracking();
    this.attachPreloader();
    this.attachWheel();
  }

  /** Jumps to a page: paged mode slides the strip; scroll mode scrolls into view. */
  slideTo(index: number): void {
    const c = this.c;
    if (c.isHorizontal) {
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
        target.scrollIntoView({ behavior: "smooth", block: "start" });
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
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.index);
            c.enqueue(idx);
            c.enqueue(idx + 1);
            c.enqueue(idx + 2);
          }
        }
      },
      { root: c.viewport, rootMargin: "400px 0px", threshold: 0 },
    );
    c.slots.forEach((s) => observer.observe(s));
    c.onDispose(() => observer.disconnect());
  }

  private attachWheel(): void {
    const c = this.c;
    const onWheel = (ev: WheelEvent): void => {
      // In Paged mode (isHorizontal), wheel scrolling always turns pages (natural page flipping)
      // In Continuous Scroll mode, wheel scrolling turns pages when Scroll Lock is active
      if (!c.scrollLock && !c.isHorizontal) return;
      ev.preventDefault();
      const now = Date.now();
      if (now - this.wheelDebounce < 180) return; // debounce quick multi-notches
      if (Math.abs(ev.deltaY) < 10 && Math.abs(ev.deltaX) < 10) return;

      this.wheelDebounce = now;
      const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;

      if (!c.isHorizontal) {
        // Vertical Scroll mode with Scroll Lock:
        // Position-aware directional page flipping so it always advances in the scrolling direction
        const vpRect = c.viewport.getBoundingClientRect();
        if (delta > 0) {
          // Scrolling down: advance to the next slot below the current top of the viewport
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
          // Scrolling up: retreat to the slot above the current top of the viewport
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
      } else {
        // Paged mode (Horizontal)
        if (delta > 0) {
          c.setPage(c.currentIndex + 1);
        } else {
          c.setPage(c.currentIndex - 1);
        }
      }
    };
    c.viewport.addEventListener("wheel", onWheel, { passive: false });
    c.onDispose(() => c.viewport.removeEventListener("wheel", onWheel));
  }
}
