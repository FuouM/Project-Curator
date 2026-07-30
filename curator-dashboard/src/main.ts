import "bootstrap-icons/font/bootstrap-icons.css";
import { setupImageViewer } from "./image-viewer";
import { setupLogTabs } from "./views/logs";
import { setupBenchmark } from "./views/benchmark";
import { setupSettings } from "./views/settings";
import { setupImport } from "./views/import";
import { setupSearch } from "./views/search";
import { setupTags } from "./views/tags";
import { setupConcepts } from "./views/concepts";
import { setupFilenameParserView } from "./views/filename-parser";
import { setupNavigation } from "./views/navigation";
import { callService } from "./ipc";
import { updateStatusIndicators, updateTaggerIndicators, applySettingsToUI, startStatusPolling, renderFeaturedDay } from "./views/dashboard";
import { renderImages, setupGridDelegation } from "./cards";

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
  restoreWindowState();
  setupNavigation();
  setupImport();
  setupSearch();
  setupTags();
  setupImageViewer();
  setupLogTabs();
  setupConcepts();
  setupFilenameParserView();
  setupBenchmark();
  setupSettings();

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
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
