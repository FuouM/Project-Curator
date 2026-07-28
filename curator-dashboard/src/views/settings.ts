import { callService } from "../ipc";
import { setStatusMessage } from "../utils";
import { getImageClickAction, setImageClickAction } from "../state";
import { applySettingsToUI, refreshTaggerStatus } from "./dashboard";
import { updateBenchmarkModelHeader } from "./benchmark";

export function setupSettings() {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const saveBtn = document.getElementById("save-settings-btn");
  const reindexBtn = document.getElementById("reindex-vectors-btn");
  const statusMsg = document.getElementById("settings-status-msg");

  let reindexPollInterval: number | null = null;

  function updateReindexProgress(
    _image_count: number,
    vector_count: number,
    pending_jobs: number,
    preprocessing_jobs: number
  ) {
    const container = document.getElementById("reindex-progress-container");
    const preBar = document.getElementById("reindex-preprocess-bar");
    const preText = document.getElementById("reindex-preprocess-text");
    const idxBar = document.getElementById("reindex-index-bar");
    const idxText = document.getElementById("reindex-index-text");
    const status = document.getElementById("reindex-progress-status");

    if (!container || !preBar || !preText || !idxBar || !idxText || !status) return;

    const total = vector_count + pending_jobs + preprocessing_jobs;

    if (total > 0 && (pending_jobs > 0 || preprocessing_jobs > 0)) {
      container.style.display = "block";

      const preprocessed = vector_count + preprocessing_jobs;
      const prePercent = Math.round((preprocessed / total) * 100);
      preBar.style.width = prePercent + "%";
      preText.textContent = `Preprocessing progress: ${preprocessed}/${total} (${prePercent}%)`;

      const idxPercent = Math.round((vector_count / total) * 100);
      idxBar.style.width = idxPercent + "%";
      idxText.textContent = `Indexing progress: ${vector_count}/${total} (${idxPercent}%)`;

      status.textContent = "Processing...";
      status.style.color = "#fbbf24";
    } else {
      if (container.style.display === "block" && status.textContent === "Processing...") {
        preBar.style.width = "100%";
        preText.textContent = `Preprocessing progress: ${total}/${total} (100%)`;
        idxBar.style.width = "100%";
        idxText.textContent = `Indexing progress: ${total}/${total} (100%)`;
        status.textContent = "Completed";
        status.style.color = "#10b981";
        setTimeout(() => {
          if (status.textContent === "Completed") {
            container.style.display = "none";
          }
        }, 5000);
      } else {
        container.style.display = "none";
      }
    }
  }

  function startReindexPolling() {
    if (reindexPollInterval) return;
    const check = async () => {
      try {
        const resp = await callService({ GetStatus: null });
        if ("StatusResult" in resp) {
          const { image_count, vector_count, pending_jobs, preprocessing_jobs } = resp.StatusResult;
          updateReindexProgress(image_count, vector_count, pending_jobs, preprocessing_jobs);
          if (pending_jobs === 0 && preprocessing_jobs === 0) {
            if (reindexPollInterval) {
              clearInterval(reindexPollInterval);
              reindexPollInterval = null;
            }
          }
        }
      } catch (e) {
        console.error("Error polling reindex status:", e);
      }
    };
    check();
    reindexPollInterval = setInterval(check, 1000) as unknown as number;
  }

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
        updateReindexProgress(0, vector_count, pending_jobs, preprocessing_jobs);
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

  // Purge missing thumbnails
  const purgeBtn = document.getElementById("purge-missing-thumbs-btn");
  const purgeStatus = document.getElementById("purge-status-msg");
  purgeBtn?.addEventListener("click", async () => {
    if (!purgeStatus) return;
    if (!confirm("Remove cached thumbnails for images that no longer exist on disk?")) return;
    setStatusMessage(purgeStatus, "Purging...", "loading");
    purgeBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ PurgeMissingThumbnails: null });
      if ("PurgeResult" in resp) {
        setStatusMessage(purgeStatus, `Done! ${resp.PurgeResult.deleted_count} thumbnail(s) removed.`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(purgeStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(purgeStatus, "Error: " + (e.message || e), "error");
    }
    purgeBtn.removeAttribute("disabled");
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

  // Backfill folders button
  const backfillBtn = document.getElementById("backfill-folders-btn");
  const backfillStatus = document.getElementById("backfill-status-msg");
  backfillBtn?.addEventListener("click", async () => {
    if (!backfillStatus) return;
    setStatusMessage(backfillStatus, "Backfilling folder assignments...", "loading");
    backfillBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ BackfillImageFolders: null });
      if ("BackfillResult" in resp) {
        const count = resp.BackfillResult.images_backfilled;
        setStatusMessage(backfillStatus, `Done! ${count} image(s) assigned to folders.`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(backfillStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(backfillStatus, "Error: " + (e.message || e), "error");
    }
    backfillBtn.removeAttribute("disabled");
  });
}
