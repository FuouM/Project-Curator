import { galleryPage, favoritesPage, setGalleryPage, setFavoritesPage, getImagesPerPage, setImagesPerPage } from "../state";
import { refreshGallery, refreshFavorites, setupPaginationButtons, setupPageJump } from "./gallery";
import { refreshBenchmarkMaxImages } from "./benchmark";
import { refreshDashboard } from "./dashboard";
import { refreshLogs, clearLogsData } from "./logs";
import { refreshTagStats } from "./tagstats";
import { refreshFolders } from "./folders";
import { refreshComponentStylesheet } from "./components-view";
import { refreshBatchPreview } from "./filename-parser";
import { refreshCharacters, setupCharactersView } from "./characters";

const subtitles: Record<string, { title: string; sub: string }> = {
  dashboard: { title: "Dashboard", sub: "Overview of your local vector store and image library." },
  gallery: { title: "Gallery", sub: "Browse all your imported digital images." },
  favorites: { title: "Favorites", sub: "Browse your favorited images." },
  import: { title: "Import Images", sub: "Register and index new images locally." },
  search: { title: "General Search", sub: "Perform neural, tag-based, and filename-parsed image retrieval." },
  plugins: { title: "Plugins", sub: "Verify and manage sandboxed plugin modules." },
  logs: { title: "System Diagnostic Logs", sub: "View active traces and stderr/stdout logs from the local engine." },
  benchmark: { title: "Hardware Performance Benchmark", sub: "Run latency and throughput comparisons on CPU vs GPU." },
  settings: { title: "Settings", sub: "Configure model device preferences (GPU / CPU)." },
  tagstats: { title: "Tag Statistics", sub: "View tag distribution and filter images by tag." },
  folders: { title: "Imported Folders", sub: "Browse folders and view import statistics." },
  components: { title: "Component Stylesheet", sub: "A showcase and reference of the application's UI components and styles." },
  concepts: { title: "Custom Concepts", sub: "Teach Curator new characters, copyrights, or series from sample images without model retraining." },
  characters: { title: "Character Identities", sub: "Manage auto-discovered character identities from YOLO + CCIP detection." },
  "filename-parser": { title: "Filename Parser & Tagger", sub: "Extract structured tags, timestamps, artist names, and artwork IDs directly from image filenames." }
};

export function setupNavigation() {
  setupCharactersView();
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".view-section");
  const viewTitle = document.getElementById("view-title");
  const viewSubtitle = document.getElementById("view-subtitle");

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      navItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");

      const view = item.getAttribute("data-view") || "dashboard";

      sections.forEach((sec) => {
        sec.classList.remove("active");
        if (sec.id === `view-${view}`) {
          sec.classList.add("active");
        }
      });

      const mainPanel = document.querySelector(".main-panel") as HTMLElement;
      if (mainPanel) {
        mainPanel.style.overflowY = (view === "logs") ? "hidden" : "auto";
      }

      if (viewTitle && viewSubtitle && subtitles[view]) {
        viewTitle.textContent = subtitles[view].title;
        viewSubtitle.textContent = subtitles[view].sub;
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
      }
    });
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
