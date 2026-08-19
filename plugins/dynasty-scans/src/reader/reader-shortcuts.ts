import type { ReaderController } from "./reader-controller";

/**
 * Reader keyboard bindings. Deferred because navigation keys must be ignored
 * while the user is typing in an input/select.
 */
export class ReaderShortcuts {
  constructor(c: ReaderController) {
    const onKeyDown = (ev: KeyboardEvent): void => {
      // Ignore if user is typing in an input or textarea
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        c.setPage(c.currentIndex - 1);
      } else if (ev.key === "ArrowRight" || ev.key === " ") {
        ev.preventDefault();
        c.setPage(c.currentIndex + 1);
      } else if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        c.toolbarImpl.setFullscreen(!c.isFullscreen);
      } else if (ev.key === "t" || ev.key === "T") {
        ev.preventDefault();
        c.toolbarImpl.toggleTheme();
      } else if (ev.key === "Escape" && c.isFullscreen) {
        ev.preventDefault();
        c.toolbarImpl.setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    c.onDispose(() => window.removeEventListener("keydown", onKeyDown));
  }
}
