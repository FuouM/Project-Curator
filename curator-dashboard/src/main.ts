import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles.css";
import { setupImageViewer, openImageViewer } from "./image-viewer";
import { setupLogTabs } from "./views/logs";
import { setupBenchmark } from "./views/benchmark";
import { setupSettings } from "./views/settings";
import { setupImport } from "./views/import";
import { setupSearch, renderSearchHtml } from "./views/search";
import { setupTagEditorModal } from "./components/tag-editor-modal";
import { setupFilenameParserView } from "./views/filename-parser";
import { setupNavigation, navigateToView } from "./views/navigation";
import { setupToolbox, renderToolboxHtml } from "./views/toolbox";
import { typedCall } from "./ipc";
import { imageDetailsFromProto } from "./proto-adapters";
import { DashboardInitResultSchema, RandomImageResultSchema } from "./gen/system_pb";
import { updateStatusIndicators, updateTaggerIndicators, applySettingsToUI, startStatusPolling, renderFeaturedDay, renderDashboardHtml } from "./views/dashboard";
import { renderGalleryHtml, renderFavoritesHtml } from "./views/gallery";
import { renderTagstatsHtml } from "./views/tagstats";
import { renderFoldersHtml } from "./views/folders";
import { renderImportHtml } from "./views/import";
import { renderCharactersHtml } from "./views/characters";

import { renderFilenameParserHtml } from "./views/filename-parser";
import { renderLogsHtml } from "./views/logs";
import { renderBenchmarkHtml } from "./views/benchmark";
import { renderSettingsHtml } from "./views/settings";
import { renderComponentsHtml } from "./views/components-view";
import { renderModelsHtml, setupModelsView } from "./views/models";
import { renderImages, setupGridDelegation, setupGlobalContextMenu, setThumbLoadPaused, resumeThumbLoading } from "./cards";
import { setGalleryPage, getImagesPerPage, setLuckyHighlightId } from "./state";
import { refreshGallery } from "./views/gallery";
import { initPlugins } from "./plugin-host";

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
          const guardedWidth = Math.max(width, 800);
          const guardedHeight = Math.max(height, 600);
          await appWindow.setSize(new PhysicalSize(guardedWidth, guardedHeight));
        }
        if (x !== undefined && y !== undefined && x > -10000 && y > -10000) {
          await appWindow.setPosition(new PhysicalPosition(x, y));
        } else {
          await appWindow.center();
        }
      }
    } else {
      await appWindow.center();
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
          if (outerSize.width > 200 && outerSize.height > 150 && outerPosition.x > -10000 && outerPosition.y > -10000) {
            localStorage.setItem("curator-window-state", JSON.stringify({
              width: outerSize.width,
              height: outerSize.height,
              x: outerPosition.x,
              y: outerPosition.y,
              maximized: false
            }));
          }
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
  initPlugins().catch((e) => console.error("initPlugins failed:", e));
  setupGlobalContextMenu();
  setupImport();
  setupSearch();
  setupTagEditorModal();
  setupImageViewer();
  setupLogTabs();
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
  typedCall("SystemService.GetDashboardInit", null, null, DashboardInitResultSchema).then((d) => {
    updateStatusIndicators({ image_count: Number(d.imageCount), vector_count: Number(d.vectorCount), pending_jobs: Number(d.pendingJobs), preprocessing_jobs: Number(d.preprocessingJobs), ram_usage_bytes: 0 });
    updateTaggerIndicators({ loaded: d.taggerLoaded, model_path: d.taggerModelPath, total_tags: d.taggerTotalTags });

    applySettingsToUI({
      clipDevice: d.clipDevice,
      taggerDevice: d.taggerDevice,
      taggerWdDevice: d.taggerWdDevice,
      idleTimeoutSecs: d.idleTimeoutSecs,
      embeddingModel: d.embeddingModel,
      detectionDevice: d.detectionDevice,
      detectionMetricsDevice: d.detectionMetricsDevice,
      ocrDevice: d.ocrDevice,
      preferredTagger: d.preferredTagger,
    });

    if (d.featuredImages.length > 0) renderFeaturedDay(imageDetailsFromProto(d.featuredImages[0]));
    renderImages(d.latestImages.map(imageDetailsFromProto), "latest-imports-grid", false, true);
  }).catch(() => {});

  startStatusPolling();
  initFPSCounter();

  document.getElementById("dashboard-lucky-btn")?.addEventListener("click", handleFeelingLucky);
  document.getElementById("gallery-lucky-btn")?.addEventListener("click", handleFeelingLucky);
}

function initFPSCounter() {
  const fpsEl = document.getElementById("status-fps-text");
  if (!fpsEl) return;

  const targetEl = fpsEl;
  let lastTime = performance.now();
  let frameCount = 0;

  function loop(now: number) {
    frameCount++;
    const delta = now - lastTime;
    if (delta >= 1000) {
      const fps = Math.round((frameCount * 1000) / delta);
      targetEl.textContent = `${fps} FPS`;
      frameCount = 0;
      lastTime = now;
    }
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

async function waitForGalleryCard(imageId: number, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const card = document.querySelector(`#gallery-grid [data-image-id="${imageId}"]`) as HTMLElement | null;
    if (card) return card;
    await new Promise((r) => setTimeout(r, 100));
  }
  return document.querySelector(`#gallery-grid [data-image-id="${imageId}"]`) as HTMLElement | null;
}

async function handleFeelingLucky() {
  try {
    const resp = await typedCall("SystemService.GetRandomImage", null, null, RandomImageResultSchema);
    if (!resp.image) return;

    const image = imageDetailsFromProto(resp.image);
    const perPage = getImagesPerPage();
    const page = Math.floor(Number(resp.index) / perPage);

    setLuckyHighlightId(image.id);
    setGalleryPage(page);
    navigateToView("gallery");

    // Navigating into the gallery triggers its own load (which holds
    // isGalleryLoading), so refreshGallery() here may early-return while that
    // rebuild is still in flight. Wait for the target card to actually appear in
    // the DOM, then teleport straight to it (no smooth scroll through
    // intermediate pages), and open the viewer. Thumbnail enqueuing is paused
    // during the wait so neither the intermediate pages nor the old viewport
    // position load their thumbnails; only the target page's thumbnails load
    // once loading resumes.
    setTimeout(async () => {
      setThumbLoadPaused(true);
      try {
        await refreshGallery();
        const card = await waitForGalleryCard(image.id, 8000);
        if (card) card.scrollIntoView({ behavior: "auto", block: "center" });
      } finally {
        setThumbLoadPaused(false);
        resumeThumbLoading();
      }
      openImageViewer(image.current_filepath, image.id);
      setTimeout(() => setLuckyHighlightId(null), 3000);
    }, 50);
  } catch (e: any) {
    console.error("I'm Feeling Lucky failed:", e);
    setThumbLoadPaused(false);
    resumeThumbLoading();
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
