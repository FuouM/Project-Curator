import { callService } from "../ipc";
import { setStatusMessage } from "../utils";
import { getImageClickAction, setImageClickAction } from "../state";
import { applySettingsToUI, refreshTaggerStatus } from "./dashboard";
import { updateBenchmarkModelHeader } from "./benchmark";
import { updateReindexProgress, startReindexPolling } from "./settings-reindex";
import { setupMaintenanceButtons } from "./settings-maintenance";

export function setupSettings() {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById("settings-detection-metrics-device") as HTMLSelectElement;
  const ocrDeviceSelect = document.getElementById("settings-ocr-device") as HTMLSelectElement;
  const saveBtn = document.getElementById("save-settings-btn");
  const reindexBtn = document.getElementById("reindex-vectors-btn");
  const statusMsg = document.getElementById("settings-status-msg");

  setupMaintenanceButtons();

  // Image click action setting (localStorage)
  const imageClickSelect = document.getElementById("settings-image-click-action") as HTMLSelectElement;
  if (imageClickSelect) {
    imageClickSelect.value = getImageClickAction();
    imageClickSelect.addEventListener("change", () => {
      setImageClickAction(imageClickSelect.value);
    });
  }

  // Path visibility setting (localStorage)
  const pathVisRadios = document.querySelectorAll('input[name="path-vis"]') as NodeListOf<HTMLInputElement>;
  const pathFoldersInput = document.getElementById("settings-path-folders") as HTMLInputElement;
  const savedMode = localStorage.getItem("curator-path-vis-mode") || "filename";
  const savedFolders = parseInt(localStorage.getItem("curator-path-vis-folders") || "1", 10);
  pathVisRadios.forEach(r => { r.checked = r.value === savedMode; });
  if (pathFoldersInput) pathFoldersInput.value = savedFolders.toString();
  pathVisRadios.forEach(r => {
    r.addEventListener("change", () => {
      localStorage.setItem("curator-path-vis-mode", r.value);
    });
  });
  if (pathFoldersInput) {
    pathFoldersInput.addEventListener("change", () => {
      localStorage.setItem("curator-path-vis-folders", pathFoldersInput.value);
    });
  }

  // Favorite button visibility setting (localStorage)
  const favAlwaysShowCheckbox = document.getElementById("settings-favorite-always-show") as HTMLInputElement;
  if (favAlwaysShowCheckbox) {
    const savedFavShow = localStorage.getItem("curator-fav-always-show") !== "false";
    favAlwaysShowCheckbox.checked = savedFavShow;
    if (!savedFavShow) {
      document.body.classList.add("hide-favorite-btn");
    } else {
      document.body.classList.remove("hide-favorite-btn");
    }
    favAlwaysShowCheckbox.addEventListener("change", () => {
      localStorage.setItem("curator-fav-always-show", favAlwaysShowCheckbox.checked.toString());
      if (!favAlwaysShowCheckbox.checked) {
        document.body.classList.add("hide-favorite-btn");
      } else {
        document.body.classList.remove("hide-favorite-btn");
      }
    });
  }

  // Check reindex status on load
  (async () => {
    try {
      const statusResp = await callService({ GetStatus: null });
      if ("StatusResult" in statusResp) {
        const { vector_count, pending_jobs, preprocessing_jobs } = statusResp.StatusResult;
        updateReindexProgress(vector_count, pending_jobs, preprocessing_jobs);
        if (pending_jobs > 0 || preprocessing_jobs > 0) {
          startReindexPolling();
        }
      }
    } catch (e) {}
  })();

  // Save settings
  saveBtn?.addEventListener("click", async () => {
    if (!clipSelect || !taggerSelect || !idleSelect || !statusMsg) return;

    setStatusMessage(statusMsg, "Saving...", "loading");

    try {
      const resp = await callService({
        UpdateSettings: {
          clip_device: clipSelect.value,
          tagger_device: taggerSelect.value,
          idle_timeout_secs: parseInt(idleSelect.value, 10),
          embedding_model: embeddingSelect ? embeddingSelect.value : null,
          detection_device: detDeviceSelect ? detDeviceSelect.value : null,
          detection_metrics_device: detMetricsSelect ? detMetricsSelect.value : null,
          ocr_device: ocrDeviceSelect ? ocrDeviceSelect.value : null,
        }
      });

      if ("SettingsResult" in resp) {
        setStatusMessage(statusMsg, "Settings saved and applied successfully. If model was changed, reindexing has started.", "success");
        if (embeddingSelect) {
          updateBenchmarkModelHeader(embeddingSelect.value);
        }
        startReindexPolling();
        refreshTaggerStatus();
      } else if ("Error" in resp) {
        setStatusMessage(statusMsg, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(statusMsg, "Error: " + (e.message || e), "error");
    }
  });

  // Reindex vectors
  reindexBtn?.addEventListener("click", async () => {
    if (!statusMsg) return;
    if (!confirm("Are you sure you want to reindex all vectors? This will rebuild the vector search index from scratch.")) {
      return;
    }
    setStatusMessage(statusMsg, "Reindexing all images...", "loading");
    try {
      const resp = await callService({ ReindexVectors: null });
      if ("Success" in resp) {
        setStatusMessage(statusMsg, "Reindexing triggered successfully. The background worker is rebuilding the index.", "success");
        startReindexPolling();
      } else if ("Error" in resp) {
        setStatusMessage(statusMsg, "Reindex failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(statusMsg, "Error: " + (e.message || e), "error");
    }
  });

  // Reindex failed vectors
  const reindexFailedBtn = document.getElementById("reindex-failed-btn");
  reindexFailedBtn?.addEventListener("click", async () => {
    if (!statusMsg) return;
    setStatusMessage(statusMsg, "Retrying failed vectors...", "loading");
    reindexFailedBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ ReindexFailedVectors: null });
      if ("ReindexFailedResult" in resp) {
        const count = resp.ReindexFailedResult.requeued;
        setStatusMessage(statusMsg, `Done! ${count} image(s) queued for re-vectorization.`, "success");
        if (count > 0) startReindexPolling();
      } else if ("Error" in resp) {
        setStatusMessage(statusMsg, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(statusMsg, "Error: " + (e.message || e), "error");
    }
    reindexFailedBtn.removeAttribute("disabled");
  });

  // Refresh settings when the settings view becomes visible
  const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
  settingsNav?.addEventListener("click", async () => {
    try {
      const resp = await callService({ GetSettings: null });
      applySettingsToUI(resp);
    } catch (e) {}
    refreshTaggerStatus();
  });
}
