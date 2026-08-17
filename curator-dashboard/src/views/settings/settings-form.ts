import { typedCall } from "../../ipc";
import { maskPath } from "../../components";
import {
  SettingsResultSchema,
  UpdateSettingsRequestSchema,
  ReindexVectorsResultSchema,
  ReindexFailedVectorsResultSchema,
  StatusResultSchema,
} from "../../gen/system_pb";
import { DevicePreference, EmbeddingModel, TaggerModel } from "../../gen/common_pb";
import { setStatusMessage } from "../../utils";
import {
  getImageClickAction,
  setImageClickAction,
  getTagCopyReplaceUnderscores,
  setTagCopyReplaceUnderscores,
  getZenModeFullImages,
  setZenModeFullImages,
} from "../../state";
import { applySettingsToUI, refreshTaggerStatus } from "../dashboard";
import { updateBenchmarkModelHeader } from "../benchmark";
import { updateReindexProgress, startReindexPolling } from "../settings-reindex";
import { setupMaintenanceButtons } from "../settings-maintenance";
import { refreshFfmpegStatus } from "./ffmpeg-status";

function deviceToEnum(v: string): DevicePreference {
  return v === "cpu"
    ? DevicePreference.CPU
    : v === "gpu"
      ? DevicePreference.GPU
      : DevicePreference.AUTO;
}

function embeddingToEnum(v: string): EmbeddingModel {
  return v === "mobileclip-s2" ? EmbeddingModel.MOBILECLIP_S2 : EmbeddingModel.CLIP_VIT_B_32;
}

function taggerToEnum(v: string): TaggerModel {
  return v === "wd-eva02" ? TaggerModel.WD_EVA02 : TaggerModel.CAMIE;
}

export function bindSettingsForm() {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const taggerWdSelect = document.getElementById("settings-tagger-wd-device") as HTMLSelectElement;
  const preferredTaggerSelect = document.getElementById(
    "settings-preferred-tagger",
  ) as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById(
    "settings-detection-metrics-device",
  ) as HTMLSelectElement;
  const ocrDeviceSelect = document.getElementById("settings-ocr-device") as HTMLSelectElement;
  const saveBtn = document.getElementById("save-settings-btn");
  const reindexBtn = document.getElementById("reindex-vectors-btn");
  const statusMsg = document.getElementById("settings-status-msg");

  setupMaintenanceButtons();

  // Save settings inline buttons
  const savePreferredBtn = document.getElementById("save-preferred-tagger-btn");
  const saveCamieDevBtn = document.getElementById("save-tagger-device-btn");
  const saveWdDevBtn = document.getElementById("save-tagger-wd-device-btn");
  const triggerSave = () => {
    saveBtn?.click();
  };
  savePreferredBtn?.addEventListener("click", triggerSave);
  saveCamieDevBtn?.addEventListener("click", triggerSave);
  saveWdDevBtn?.addEventListener("click", triggerSave);

  // Image click action setting (localStorage)
  const imageClickSelect = document.getElementById(
    "settings-image-click-action",
  ) as HTMLSelectElement;
  if (imageClickSelect) {
    imageClickSelect.value = getImageClickAction();
    imageClickSelect.addEventListener("change", () => {
      setImageClickAction(imageClickSelect.value);
    });
  }

  // Path visibility setting (localStorage)
  const pathVisRadios = document.querySelectorAll(
    'input[name="path-vis"]',
  ) as NodeListOf<HTMLInputElement>;
  const pathFoldersInput = document.getElementById("settings-path-folders") as HTMLInputElement;
  const pathPreviewEl = document.getElementById("settings-path-preview");
  const savedMode = localStorage.getItem("curator-path-vis-mode") || "filename";
  const savedFolders = parseInt(localStorage.getItem("curator-path-vis-folders") || "1", 10);
  pathVisRadios.forEach((r) => {
    r.checked = r.value === savedMode;
  });
  if (pathFoldersInput) pathFoldersInput.value = savedFolders.toString();
  const SAMPLE_PATH = "C:\\Users\\demo\\Pictures\\Anime\\Series\\Scene 01\\sample_image.png";
  const renderPathPreview = () => {
    if (pathPreviewEl) pathPreviewEl.textContent = maskPath(SAMPLE_PATH);
  };
  pathVisRadios.forEach((r) => {
    r.addEventListener("change", () => {
      localStorage.setItem("curator-path-vis-mode", r.value);
      renderPathPreview();
    });
  });
  if (pathFoldersInput) {
    pathFoldersInput.addEventListener("change", () => {
      localStorage.setItem("curator-path-vis-folders", pathFoldersInput.value);
      renderPathPreview();
    });
  }
  renderPathPreview();

  // Tag copy formatting setting (localStorage)
  const tagCopyReplaceUnderscoresCheckbox = document.getElementById(
    "settings-tag-copy-replace-underscores",
  ) as HTMLInputElement;
  if (tagCopyReplaceUnderscoresCheckbox) {
    tagCopyReplaceUnderscoresCheckbox.checked = getTagCopyReplaceUnderscores();
    tagCopyReplaceUnderscoresCheckbox.addEventListener("change", () => {
      setTagCopyReplaceUnderscores(tagCopyReplaceUnderscoresCheckbox.checked);
    });
  }

  // Zen Mode Full Images setting (localStorage)
  const zenModeFullImagesCheckbox = document.getElementById(
    "settings-zen-mode-full-images",
  ) as HTMLInputElement;
  if (zenModeFullImagesCheckbox) {
    zenModeFullImagesCheckbox.checked = getZenModeFullImages();
    zenModeFullImagesCheckbox.addEventListener("change", () => {
      const active = zenModeFullImagesCheckbox.checked;
      setZenModeFullImages(active);
      const toolbarBtn = document.getElementById("gallery-toggle-full-images-btn");
      if (toolbarBtn) toolbarBtn.classList.toggle("primary", active);
    });
  }

  // Favorite button visibility setting (localStorage)
  const favAlwaysShowCheckbox = document.getElementById(
    "settings-favorite-always-show",
  ) as HTMLInputElement;
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
      const statusResp = await typedCall("SystemService.GetStatus", null, null, StatusResultSchema);
      const vectorCount = Number(statusResp.vectorCount);
      const pendingJobs = Number(statusResp.pendingJobs);
      const preprocessingJobs = Number(statusResp.preprocessingJobs);
      updateReindexProgress(vectorCount, pendingJobs, preprocessingJobs);
      if (pendingJobs > 0 || preprocessingJobs > 0) {
        startReindexPolling();
      }
    } catch (e) {}
  })();

  // Save settings
  saveBtn?.addEventListener("click", async () => {
    if (!clipSelect || !taggerSelect || !idleSelect || !statusMsg) return;

    setStatusMessage(statusMsg, "Saving...", "loading");

    try {
      const updateReq = {
        clipDevice: clipSelect ? deviceToEnum(clipSelect.value) : undefined,
        taggerDevice: taggerSelect ? deviceToEnum(taggerSelect.value) : undefined,
        taggerWdDevice: taggerWdSelect ? deviceToEnum(taggerWdSelect.value) : undefined,
        idleTimeoutSecs: idleSelect ? BigInt(parseInt(idleSelect.value, 10)) : undefined,
        embeddingModel: embeddingSelect ? embeddingToEnum(embeddingSelect.value) : undefined,
        detectionDevice: detDeviceSelect ? deviceToEnum(detDeviceSelect.value) : undefined,
        detectionMetricsDevice: detMetricsSelect ? deviceToEnum(detMetricsSelect.value) : undefined,
        ocrDevice: ocrDeviceSelect ? deviceToEnum(ocrDeviceSelect.value) : undefined,
        preferredTagger: preferredTaggerSelect
          ? taggerToEnum(preferredTaggerSelect.value)
          : undefined,
      };

      await typedCall(
        "SystemService.UpdateSettings",
        UpdateSettingsRequestSchema,
        updateReq,
        SettingsResultSchema,
      );

      setStatusMessage(
        statusMsg,
        "Settings saved and applied successfully. If model was changed, reindexing has started.",
        "success",
      );
      if (embeddingSelect) {
        updateBenchmarkModelHeader(embeddingSelect.value);
      }
      startReindexPolling();
      refreshTaggerStatus();
    } catch (e: any) {
      setStatusMessage(statusMsg, "Error: " + (e.message || e), "error");
    }
  });

  // Reindex vectors
  reindexBtn?.addEventListener("click", async () => {
    if (!statusMsg) return;
    if (
      !confirm(
        "Are you sure you want to reindex all vectors? This will rebuild the vector search index from scratch.",
      )
    ) {
      return;
    }
    setStatusMessage(statusMsg, "Reindexing all images...", "loading");
    try {
      await typedCall("SystemService.ReindexVectors", null, null, ReindexVectorsResultSchema);
      setStatusMessage(
        statusMsg,
        "Reindexing triggered successfully. The background worker is rebuilding the index.",
        "success",
      );
      startReindexPolling();
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
      const resp = await typedCall(
        "SystemService.ReindexFailedVectors",
        null,
        null,
        ReindexFailedVectorsResultSchema,
      );
      const count = Number(resp.requeued);
      setStatusMessage(
        statusMsg,
        `Done! ${count} image(s) queued for re-vectorization.`,
        "success",
      );
      if (count > 0) startReindexPolling();
    } catch (e: any) {
      setStatusMessage(statusMsg, "Error: " + (e.message || e), "error");
    }
    reindexFailedBtn.removeAttribute("disabled");
  });

  // Refresh settings when the settings view becomes visible
  const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
  settingsNav?.addEventListener("click", async () => {
    try {
      const resp = await typedCall("SystemService.GetSettings", null, null, SettingsResultSchema);
      applySettingsToUI(resp);
    } catch (e) {}
    refreshTaggerStatus();
    refreshFfmpegStatus();
  });
}
