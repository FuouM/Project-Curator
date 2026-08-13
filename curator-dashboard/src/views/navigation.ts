import { renderPluginNavItemHtml } from "../components/navigation-sidebar";
import { favoritesPage, setGalleryPage, setFavoritesPage, getImagesPerPage, setImagesPerPage, setGalleryInfiniteScroll, setGalleryZenMode, getGalleryInfiniteScroll, getGalleryZenMode, getGalleryPage, getGalleryTotalCount, getGalleryFullImages, setGalleryFullImages } from "../state";
import { refreshGallery, refreshFavorites, setupPaginationButtons, setupPageJump, loadMoreGallery, isGalleryLoading, refreshGalleryPreserving } from "./gallery";
import { refreshBenchmarkMaxImages } from "./benchmark";
import { refreshDashboard } from "./dashboard";
import { refreshLogs, clearLogsData, clearLogsFrontendDom } from "./logs";
import { refreshTagStats } from "./tagstats";
import { refreshFolders } from "./folders";
import { refreshComponentStylesheet } from "./components-view";
import { refreshBatchPreview } from "./filename-parser";
import { refreshCharacters, setupCharactersView } from "./characters";
import { refreshModelStatus, clearCompletedModelsConsoleLogs } from "./models";
import { reobserveUnloadedThumbnails, processVisibleFullImages, setThumbLoadPaused, resumeThumbLoading } from "../cards";

const subtitles: Record<string, { title: string; sub: string }> = {
  dashboard: { title: "Dashboard", sub: "Overview of your local vector store and image library." },
  gallery: { title: "Gallery", sub: "Browse all your imported digital images." },
  favorites: { title: "Favorites", sub: "Browse your favorited images." },
  import: { title: "Import Images", sub: "Register and index new images locally." },
  search: { title: "General Search", sub: "Perform neural, tag-based, and filename-parsed image retrieval." },
  plugins: { title: "Plugins", sub: "Discover, validate, and manage sandboxed plugin modules." },
  logs: { title: "System Diagnostic Logs", sub: "View active traces and stderr/stdout logs from the local engine." },
  benchmark: { title: "Hardware Performance Benchmark", sub: "Run latency and throughput comparisons on CPU vs GPU." },
  settings: { title: "Settings", sub: "Configure model device preferences (GPU / CPU)." },
  models: { title: "Model Management", sub: "Download and manage local AI model weights on disk." },
  tagstats: { title: "Tag Statistics", sub: "View tag distribution and filter images by tag." },
  folders: { title: "Imported Folders", sub: "Browse folders and view import statistics." },
  components: { title: "Component Stylesheet", sub: "A showcase and reference of the application's UI components and styles." },
  concepts: { title: "Custom Concepts", sub: "Teach Curator new characters, copyrights, or series from sample images without model retraining." },
  characters: { title: "Character Identities", sub: "Manage auto-discovered character identities from YOLO + CCIP detection." },
  toolbox: { title: "Image Toolbox", sub: "Run reverse search, auto-tagging, OCR, and character detection on any image without touching your library." },
  "filename-parser": { title: "Filename Parser & Tagger", sub: "Extract structured tags, timestamps, artist names, and artwork IDs directly from image filenames." }
};

// --- Plugin View Registry (dynamic tabs registered by plugin-host) ---
interface PluginViewEntry {
  title: string;
  sub: string;
  refresh: () => void;
}
const pluginViews = new Map<string, PluginViewEntry>();

export function registerPluginView(
  id: string,
  label: string,
  iconClass: string,
  sub: string,
  refresh: () => void
) {
  const viewKey = `extensions-${id}`;
  if (pluginViews.has(viewKey)) return;

  const navList = document.getElementById("extensions-nav-list");
  navList?.insertAdjacentHTML("beforeend", renderPluginNavItemHtml(id, label, iconClass));

  const section = document.createElement("section");
  section.className = "view-section";
  section.id = `view-${viewKey}`;
  document.querySelector(".main-panel")?.appendChild(section);

  pluginViews.set(viewKey, { title: label, sub, refresh });
}

export function getPluginViewSubtitle(view: string): PluginViewEntry | undefined {
  return pluginViews.get(view);
}

export function getPluginViewKeys(): string[] {
  return Array.from(pluginViews.keys());
}

/** Remove a dynamic plugin view (nav item + section + registry entry). */
export function removePluginView(viewKey: string) {
  pluginViews.delete(viewKey);
  document.querySelector(`.nav-item[data-view="${viewKey}"]`)?.remove();
  document.getElementById(`view-${viewKey}`)?.remove();
}

// --- Infinite scroll IntersectionObserver sentinel ---
let galleryInfiniteObserver: IntersectionObserver | null = null;
let gallerySentinel: HTMLElement | null = null;
let galleryScrollTop = 0;
let scrollTopPauseActive = false;
let scrollTopResumeTimer: number | null = null;

function buildGalleryInfiniteObserver() {
  galleryInfiniteObserver?.disconnect();
  galleryInfiniteObserver = null;

  const mainPanel = document.querySelector(".main-panel") as HTMLElement | null;
  gallerySentinel = document.getElementById("gallery-sentinel") as HTMLElement | null;
  if (!mainPanel || !gallerySentinel) return;

  const margin = getGalleryZenMode() ? "800px 0px" : "160px 0px";
  galleryInfiniteObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!getGalleryInfiniteScroll()) continue;
      if (isGalleryLoading) continue;

      const perPage = getImagesPerPage();
      const totalPages = Math.ceil(getGalleryTotalCount() / perPage);
      const nextPage = getGalleryPage() + 1;
      if (nextPage >= totalPages) continue;

      setGalleryPage(nextPage);
      loadMoreGallery(nextPage).then(() => {
        // Re-observe: appended content may leave the sentinel still intersecting
        // (viewport not yet full). IO does not re-fire on unchanged state; force it.
        reobserveGallerySentinel();
      });
    }
  }, { root: mainPanel, rootMargin: margin, threshold: 0 });

  galleryInfiniteObserver.observe(gallerySentinel);
}

function reobserveGallerySentinel() {
  if (galleryInfiniteObserver && gallerySentinel) {
    galleryInfiniteObserver.unobserve(gallerySentinel);
    galleryInfiniteObserver.observe(gallerySentinel);
  }
}

export function setupNavigation() {
  setupCharactersView();

  const sidebar = document.querySelector(".sidebar");
  const viewTitle = document.getElementById("view-title");
  const viewSubtitle = document.getElementById("view-subtitle");

  const activateView = (item: HTMLElement) => {
    // Capture the gallery scroll position before leaving so it can be restored
    // when returning (the gallery DOM is kept mounted, only display toggles).
    const prevNavItem = document.querySelector(".nav-item.active");
    const prevView = prevNavItem?.getAttribute("data-view");
    const scrollHost = document.querySelector(".main-panel") as HTMLElement | null;
    if (prevView === "gallery" && scrollHost) {
      galleryScrollTop = scrollHost.scrollTop;
    }

    document.querySelectorAll(".nav-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");

    const view = item.getAttribute("data-view") || "dashboard";

    // Re-query sections every click so dynamically-mounted plugin sections
    // (created after setupNavigation) are included.
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.remove("active");
      if (sec.id === `view-${view}`) {
        sec.classList.add("active");
        reobserveUnloadedThumbnails(sec as HTMLElement);
      }
    });

    const mainPanel = document.querySelector(".main-panel") as HTMLElement;
    if (mainPanel) {
      mainPanel.style.overflowY = (view === "logs") ? "hidden" : "auto";
    }

    if (viewTitle && viewSubtitle) {
      const staticMeta = subtitles[view];
      const pluginMeta = pluginViews.get(view);
      const meta = staticMeta || pluginMeta;
      if (meta) {
        viewTitle.textContent = meta.title;
        viewSubtitle.textContent = meta.sub;
      }
    }

    if (view !== "logs") {
      clearLogsFrontendDom();
    }
    if (view !== "models") {
      clearCompletedModelsConsoleLogs();
    }

    if (view === "dashboard") {
      refreshDashboard();
    } else if (view === "gallery") {
      // Preserve the accumulated infinite-scroll list (and its scroll position)
      // when returning to the gallery. Only refresh the grid from scratch when
      // it is empty or pagination mode is active.
      const grid = document.getElementById("gallery-grid");
      const hasCards = grid ? grid.querySelector<HTMLElement>(".image-card") !== null : false;
      const preserve = getGalleryInfiniteScroll() && hasCards;
      const load = preserve ? refreshGalleryPreserving() : refreshGallery();
      load.then(() => {
        const panel = document.querySelector(".main-panel") as HTMLElement | null;
        if (panel) panel.scrollTop = galleryScrollTop;
        setTimeout(reobserveGallerySentinel, 300);
      });
    } else if (view === "favorites") {
      refreshFavorites();
    } else if (view === "logs") {
      refreshLogs();
    } else if (view === "tagstats") {
      refreshTagStats();
    } else if (view === "folders") {
      refreshFolders();
    } else if (view === "components") {
      refreshComponentStylesheet();
    } else if (view === "filename-parser") {
      refreshBatchPreview();
    } else if (view === "characters") {
      const container = document.getElementById("characters-list-container");
      if (!container || container.children.length === 0 || container.querySelector(".skeleton-loader")) {
        refreshCharacters();
      }
    } else if (view === "benchmark") {
      refreshBenchmarkMaxImages();
    } else if (view === "models") {
      refreshModelStatus();
    } else if (view === "plugins") {
      import("./plugins").then((m) => m.setupPluginsHub()).catch((e) => console.error("plugins hub:", e));
    } else {
      const pluginView = pluginViews.get(view);
      if (pluginView) pluginView.refresh();
    }
  };

  // Event delegation: covers both static nav items and dynamically-mounted
  // plugin tabs (which are appended after setupNavigation runs).
  sidebar?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (!item) return;
    activateView(item);
  });


  // Gallery & Favorites Pagination Setup
  setupPaginationButtons("gallery-prev-btn", "gallery-next-btn", { get value() { return getGalleryPage(); }, set value(v) { setGalleryPage(v); } }, refreshGallery);
  setupPaginationButtons("favorites-prev-btn", "favorites-next-btn", { get value() { return favoritesPage; }, set value(v) { setFavoritesPage(v); } }, refreshFavorites);

  // Gallery & Favorites Page Jump
  setupPageJump("gallery-jump-btn", "gallery-page-jump", { get value() { return getGalleryPage(); }, set value(v) { setGalleryPage(v); } }, refreshGallery);
  setupPageJump("favorites-jump-btn", "favorites-page-jump", { get value() { return favoritesPage; }, set value(v) { setFavoritesPage(v); } }, refreshFavorites);

  // Gallery per-page selector
  const perPageSelect = document.getElementById("gallery-per-page-select") as HTMLSelectElement;
  if (perPageSelect) {
    perPageSelect.value = getImagesPerPage().toString();
    perPageSelect.addEventListener("change", () => {
      setImagesPerPage(parseInt(perPageSelect.value, 10));
      setGalleryPage(0);
      refreshGallery();
    });
  }

  // Favorites per-page selector
  const favPerPageSelect = document.getElementById("favorites-per-page-select") as HTMLSelectElement;
  if (favPerPageSelect) {
    favPerPageSelect.value = getImagesPerPage().toString();
    favPerPageSelect.addEventListener("change", () => {
      setImagesPerPage(parseInt(favPerPageSelect.value, 10));
      setFavoritesPage(0);
      refreshFavorites();
    });
  }

  // Logs buttons setup
  document.getElementById("refresh-logs-btn")?.addEventListener("click", refreshLogs);
  document.getElementById("clear-logs-btn")?.addEventListener("click", clearLogsData);

  // Gallery Infinite Scroll setup
  const scrollToggleBtn = document.getElementById("gallery-toggle-infinite-scroll-btn");
  if (scrollToggleBtn) {
    scrollToggleBtn.addEventListener("click", () => {
      const active = !getGalleryInfiniteScroll();
      setGalleryInfiniteScroll(active);
      scrollToggleBtn.classList.toggle("primary", active);

      // If turning infinite scroll OFF, Zen Mode must also be turned OFF
      if (!active && getGalleryZenMode()) {
        setGalleryZenMode(false);
        const zenToggleBtn = document.getElementById("gallery-toggle-zen-mode-btn");
        if (zenToggleBtn) zenToggleBtn.classList.remove("primary");
        const grid = document.getElementById("gallery-grid");
        if (grid) grid.classList.remove("zen-mode-active");
      }

      // Update pagination controls visibility
      const controls = document.getElementById("gallery-pagination-controls");
      if (controls) {
        controls.style.display = active ? "none" : "flex";
      }

      // Reset to page 0 when toggled
      setGalleryPage(0);
      refreshGallery().then(() => {
        buildGalleryInfiniteObserver();
        setTimeout(reobserveGallerySentinel, 300);
      });
    });
  }

  // Gallery Zen Mode setup
  const zenToggleBtn = document.getElementById("gallery-toggle-zen-mode-btn");
  if (zenToggleBtn) {
    zenToggleBtn.addEventListener("click", () => {
      const active = !getGalleryZenMode();
      setGalleryZenMode(active);
      zenToggleBtn.classList.toggle("primary", active);

      // Toggle class on the grid
      const grid = document.getElementById("gallery-grid");
      if (grid) {
        grid.classList.toggle("zen-mode-active", active);
      }

      // If turning Zen Mode ON, Infinite Scroll must also be turned ON
      if (active && !getGalleryInfiniteScroll()) {
        setGalleryInfiniteScroll(true);
        const scrollToggleBtn = document.getElementById("gallery-toggle-infinite-scroll-btn");
        if (scrollToggleBtn) scrollToggleBtn.classList.add("primary");

        // Update pagination controls visibility
        const controls = document.getElementById("gallery-pagination-controls");
        if (controls) {
          controls.style.display = "none";
        }
      }

      // Reset to page 0 and reload gallery to apply changes cleanly
      setGalleryPage(0);
      refreshGallery().then(() => {
        buildGalleryInfiniteObserver();
        setTimeout(reobserveGallerySentinel, 300);
      });
    });
  }

  // Gallery Full Images toggle setup
  const fullImagesToggleBtn = document.getElementById("gallery-toggle-full-images-btn");
  if (fullImagesToggleBtn) {
    fullImagesToggleBtn.addEventListener("click", () => {
      const active = !getGalleryFullImages();
      setGalleryFullImages(active);
      fullImagesToggleBtn.classList.toggle("primary", active);

      const settingsCheckbox = document.getElementById("settings-zen-mode-full-images") as HTMLInputElement | null;
      if (settingsCheckbox) settingsCheckbox.checked = active;

      if (active) {
        processVisibleFullImages();
      } else {
        // Revert all currently displayed cards back to fast WebP thumbnails
        const imgs = document.querySelectorAll<HTMLImageElement>(".image-grid img[data-thumb-id]");
        imgs.forEach((img) => {
          img.dataset.fullLoaded = "0";
          img.dataset.fullLoading = "0";
          const imageId = parseInt(img.dataset.thumbId || "0", 10);
          const cachedUrl = (window as any).thumbCache?.get(imageId);
          if (cachedUrl) {
            img.src = cachedUrl;
          }
        });
        refreshGallery();
      }
    });
  }

  // Scroll-to-top button: shows when the gallery is scrolled down, hides on
  // any other view or when back at the top.
  const mainPanelHost = document.querySelector(".main-panel") as HTMLElement | null;
  if (mainPanelHost) {
    mainPanelHost.addEventListener("scroll", () => {
      const btn = document.getElementById("gallery-scroll-top-btn");
      if (!btn) return;
      const activeView = document.querySelector(".nav-item.active")?.getAttribute("data-view");
      if (activeView !== "gallery") {
        btn.style.display = "none";
        return;
      }
      btn.style.display = mainPanelHost.scrollTop > 400 ? "flex" : "none";
    });
  }
  document.getElementById("gallery-scroll-top-btn")?.addEventListener("click", () => {
    const panel = document.querySelector(".main-panel") as HTMLElement | null;
    if (!panel || panel.scrollTop <= 0) return;
    // Suppress intermediate thumbnail loading while flying back to the top;
    // resume once the smooth scroll reaches the top (with a safety timeout).
    if (scrollTopPauseActive) return;
    scrollTopPauseActive = true;
    setThumbLoadPaused(true);
    panel.scrollTo({ top: 0, behavior: "smooth" });

    const done = () => {
      scrollTopPauseActive = false;
      panel.removeEventListener("scroll", onScroll);
      if (scrollTopResumeTimer) {
        clearTimeout(scrollTopResumeTimer);
        scrollTopResumeTimer = null;
      }
      resumeThumbLoading();
    };
    const onScroll = () => {
      if (panel.scrollTop <= 0) done();
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    scrollTopResumeTimer = window.setTimeout(done, 3000);
  });

  // Infinite scroll is driven by an IntersectionObserver watching the
  // #gallery-sentinel element (mounted in renderGalleryHtml). The observer is
  // rebuilt here (rootMargin differs by Zen Mode, and rootMargin is read-only).
  buildGalleryInfiniteObserver();

  // Initial fill check on startup in case it's restored to infinite scroll
  setTimeout(reobserveGallerySentinel, 500);
}

export function navigateToView(view: string) {
  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`) as HTMLElement | null;
  if (navItem) navItem.click();
}
