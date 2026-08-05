import { galleryPage, favoritesPage, setGalleryPage, setFavoritesPage, getImagesPerPage, setImagesPerPage } from "../state";
import { refreshGallery, refreshFavorites, setupPaginationButtons, setupPageJump } from "./gallery";
import { refreshBenchmarkMaxImages } from "./benchmark";
import { refreshDashboard } from "./dashboard";
import { refreshLogs, clearLogsData, clearLogsFrontendDom } from "./logs";
import { refreshTagStats } from "./tagstats";
import { refreshFolders } from "./folders";
import { refreshComponentStylesheet } from "./components-view";
import { refreshBatchPreview } from "./filename-parser";
import { refreshCharacters, setupCharactersView } from "./characters";
import { refreshModelStatus } from "./models";

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
  const navItem = document.createElement("li");
  navItem.className = "nav-item";
  navItem.setAttribute("data-view", viewKey);
  navItem.innerHTML = `<span><i class="${iconClass}"></i></span> ${label}`;
  navList?.appendChild(navItem);

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

export function setupNavigation() {
  setupCharactersView();

  const sidebar = document.querySelector(".sidebar");
  const viewTitle = document.getElementById("view-title");
  const viewSubtitle = document.getElementById("view-subtitle");

  const activateView = (item: HTMLElement) => {
    document.querySelectorAll(".nav-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");

    const view = item.getAttribute("data-view") || "dashboard";

    // Re-query sections every click so dynamically-mounted plugin sections
    // (created after setupNavigation) are included.
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.remove("active");
      if (sec.id === `view-${view}`) {
        sec.classList.add("active");
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

    if (view === "dashboard") {
      refreshDashboard();
    } else if (view === "gallery") {
      refreshGallery();
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
  setupPaginationButtons("gallery-prev-btn", "gallery-next-btn", { get value() { return galleryPage; }, set value(v) { setGalleryPage(v); } }, refreshGallery);
  setupPaginationButtons("favorites-prev-btn", "favorites-next-btn", { get value() { return favoritesPage; }, set value(v) { setFavoritesPage(v); } }, refreshFavorites);

  // Gallery & Favorites Page Jump
  setupPageJump("gallery-jump-btn", "gallery-page-jump", { get value() { return galleryPage; }, set value(v) { setGalleryPage(v); } }, refreshGallery);
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
}

export function navigateToView(view: string) {
  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`) as HTMLElement | null;
  if (navItem) navItem.click();
}
