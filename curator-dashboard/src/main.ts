import "bootstrap-icons/font/bootstrap-icons.css";
import { setupImageViewer, openImageViewer } from "./image-viewer";
import { setupLogTabs } from "./views/logs";
import { setupBenchmark } from "./views/benchmark";
import { setupSettings } from "./views/settings";
import { setupImport } from "./views/import";
import { setupSearch, renderSearchHtml } from "./views/search";
import { setupTags } from "./views/tags";
import { setupConcepts } from "./views/concepts";
import { setupFilenameParserView } from "./views/filename-parser";
import { setupNavigation, navigateToView } from "./views/navigation";
import { setupToolbox, renderToolboxHtml } from "./views/toolbox";
import { callService } from "./ipc";
import { updateStatusIndicators, updateTaggerIndicators, applySettingsToUI, startStatusPolling, renderFeaturedDay, renderDashboardHtml } from "./views/dashboard";
import { renderGalleryHtml, renderFavoritesHtml } from "./views/gallery";
import { renderTagstatsHtml } from "./views/tagstats";
import { renderFoldersHtml } from "./views/folders";
import { renderImportHtml } from "./views/import";
import { renderConceptsHtml } from "./views/concepts";
import { renderCharactersHtml } from "./views/characters";
import { renderFilenameParserHtml } from "./views/filename-parser";
import { renderLogsHtml } from "./views/logs";
import { renderBenchmarkHtml } from "./views/benchmark";
import { renderSettingsHtml } from "./views/settings";
import { renderComponentsHtml } from "./views/components-view";
import { renderModelsHtml, setupModelsView } from "./views/models";
import { renderImages, setupGridDelegation } from "./cards";
import { setGalleryPage, getImagesPerPage, setLuckyHighlightId } from "./state";
import { refreshGallery } from "./views/gallery";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";

async function restoreWindowState() {
  try {
    const appWindow = getCurrentWindow();
    const savedState = localStorage.getItem("curator-window-state");
    if (savedState) {
      const { x, y, width, height, maximized } = JSON.parse(savedState);
      if (maximized) {
        await appWindow.maximize();
      } else {
        if (width && height) {
          await appWindow.setSize(new PhysicalSize(width, height));
        }
        if (x !== undefined && y !== undefined) {
          await appWindow.setPosition(new PhysicalPosition(x, y));
        }
      }
    }
  } catch (err) {
    console.error("Window state restore error:", err);
  }

  setupWindowStateListener();
}

function setupWindowStateListener() {
  try {
    const appWindow = getCurrentWindow();
    let saveTimeout: any = null;
    const saveState = async () => {
      try {
        const isMaximized = await appWindow.isMaximized();
        if (isMaximized) {
          const savedState = localStorage.getItem("curator-window-state");
          let prevState = { x: 100, y: 100, width: 800, height: 600 };
          if (savedState) {
            try {
              const parsed = JSON.parse(savedState);
              if (parsed.width) prevState = parsed;
            } catch (_) {}
          }
          localStorage.setItem("curator-window-state", JSON.stringify({
            ...prevState,
            maximized: true
          }));
        } else {
          const outerSize = await appWindow.outerSize();
          const outerPosition = await appWindow.outerPosition();
          localStorage.setItem("curator-window-state", JSON.stringify({
            width: outerSize.width,
            height: outerSize.height,
            x: outerPosition.x,
            y: outerPosition.y,
            maximized: false
          }));
        }
      } catch (err) {
        console.error("Window state save error:", err);
      }
    };

    appWindow.onResized(() => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveState, 300);
    });
    appWindow.onMoved(() => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveState, 300);
    });
  } catch (_) {}
}

function init() {
  // Global image fallback delegation
  document.addEventListener("error", (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.action === "img-fallback" && target.tagName === "IMG") {
      (target as HTMLImageElement).style.display = "none";
      const fallback = target.nextElementSibling as HTMLElement | null;
      if (fallback) fallback.style.display = "block";
    }
  }, true);

  restoreWindowState();

  // Render all view templates dynamically into their shell elements
  const viewDashboard = document.getElementById("view-dashboard");
  if (viewDashboard) viewDashboard.innerHTML = renderDashboardHtml();
  const viewGallery = document.getElementById("view-gallery");
  if (viewGallery) viewGallery.innerHTML = renderGalleryHtml();
  const viewFavorites = document.getElementById("view-favorites");
  if (viewFavorites) viewFavorites.innerHTML = renderFavoritesHtml();
  const viewTagstats = document.getElementById("view-tagstats");
  if (viewTagstats) viewTagstats.innerHTML = renderTagstatsHtml();
  const viewFolders = document.getElementById("view-folders");
  if (viewFolders) viewFolders.innerHTML = renderFoldersHtml();
  const viewImport = document.getElementById("view-import");
  if (viewImport) viewImport.innerHTML = renderImportHtml();
  const viewConcepts = document.getElementById("view-concepts");
  if (viewConcepts) viewConcepts.innerHTML = renderConceptsHtml();
  const viewCharacters = document.getElementById("view-characters");
  if (viewCharacters) viewCharacters.innerHTML = renderCharactersHtml();
  const viewFilenameParser = document.getElementById("view-filename-parser");
  if (viewFilenameParser) viewFilenameParser.innerHTML = renderFilenameParserHtml();
  const viewToolbox = document.getElementById("view-toolbox");
  if (viewToolbox) viewToolbox.innerHTML = renderToolboxHtml();
  const viewSearch = document.getElementById("view-search");
  if (viewSearch) viewSearch.innerHTML = renderSearchHtml();
  const viewLogs = document.getElementById("view-logs");
  if (viewLogs) viewLogs.innerHTML = renderLogsHtml();
  const viewBenchmark = document.getElementById("view-benchmark");
  if (viewBenchmark) viewBenchmark.innerHTML = renderBenchmarkHtml();
  const viewSettings = document.getElementById("view-settings");
  if (viewSettings) viewSettings.innerHTML = renderSettingsHtml();
  const viewModels = document.getElementById("view-models");
  if (viewModels) viewModels.innerHTML = renderModelsHtml();
  const viewComponents = document.getElementById("view-components");
  if (viewComponents) viewComponents.innerHTML = renderComponentsHtml();

  setupNavigation();
  setupImport();
  setupSearch();
  setupTags();
  setupImageViewer();
  setupLogTabs();
  setupConcepts();
  setupFilenameParserView();
  setupToolbox();
  setupBenchmark();
  setupSettings();
  setupModelsView();

  // Setup event delegation on grids
  const galleryGrid = document.getElementById("gallery-grid");
  if (galleryGrid) setupGridDelegation(galleryGrid);
  const favoritesGrid = document.getElementById("favorites-grid");
  if (favoritesGrid) setupGridDelegation(favoritesGrid);
  const searchGrid = document.getElementById("search-results-grid");
  if (searchGrid) setupGridDelegation(searchGrid);
  const dashboardGrid = document.getElementById("latest-imports-grid");
  if (dashboardGrid) setupGridDelegation(dashboardGrid);


  // Phase 1: Fast data (status + tagger + settings)
  callService({ GetDashboardInit: null }).then((resp) => {
    if ("DashboardInitResult" in resp) {
      const d = resp.DashboardInitResult;

      updateStatusIndicators({ image_count: d.image_count, vector_count: d.vector_count, pending_jobs: d.pending_jobs, preprocessing_jobs: d.preprocessing_jobs });
      updateTaggerIndicators({ loaded: d.tagger_loaded, model_path: d.tagger_model_path, total_tags: d.tagger_total_tags });

      applySettingsToUI({ SettingsResult: { clip_device: d.clip_device, tagger_device: d.tagger_device, idle_timeout_secs: d.idle_timeout_secs, embedding_model: d.embedding_model, detection_device: d.detection_device, detection_metrics_device: d.detection_metrics_device } });

      if (d.featured_images.length > 0) renderFeaturedDay(d.featured_images[0]);
      renderImages(d.latest_images, "latest-imports-grid");
    }
  }).catch(() => {});

  startStatusPolling();

  document.getElementById("dashboard-lucky-btn")?.addEventListener("click", handleFeelingLucky);
  document.getElementById("gallery-lucky-btn")?.addEventListener("click", handleFeelingLucky);
}

async function handleFeelingLucky() {
  try {
    const resp = await callService({ GetRandomImage: null });
    if (!("RandomImageResult" in resp)) return;

    const { image, index } = resp.RandomImageResult;
    const perPage = getImagesPerPage();
    const page = Math.floor(index / perPage);

    setLuckyHighlightId(image.id);
    setGalleryPage(page);
    navigateToView("gallery");

    // Wait for gallery to render, then open viewer and clear highlight
    setTimeout(() => {
      refreshGallery().then(() => {
        const card = document.querySelector(`#gallery-grid [data-image-id="${image.id}"]`) as HTMLElement | null;
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
        openImageViewer(image.current_filepath, image.id);
        setTimeout(() => setLuckyHighlightId(null), 3000);
      });
    }, 50);
  } catch (e: any) {
    console.error("I'm Feeling Lucky failed:", e);
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
