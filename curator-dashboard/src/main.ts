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
import { renderImages } from "./cards";

function init() {
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


  // Phase 1: Fast data (status + tagger + settings)
  callService({ GetDashboardInit: null }).then((resp) => {
    if ("DashboardInitResult" in resp) {
      const d = resp.DashboardInitResult;

      updateStatusIndicators({ image_count: d.image_count, vector_count: d.vector_count, pending_jobs: d.pending_jobs, preprocessing_jobs: d.preprocessing_jobs });
      updateTaggerIndicators({ loaded: d.tagger_loaded, model_path: d.tagger_model_path, total_tags: d.tagger_total_tags });

      applySettingsToUI({ SettingsResult: { clip_device: d.clip_device, tagger_device: d.tagger_device, idle_timeout_secs: d.idle_timeout_secs, embedding_model: d.embedding_model } });

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
