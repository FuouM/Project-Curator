import { typedCall } from "../ipc";
import { invoke } from "@tauri-apps/api/core";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { SafeHtml, html, maskPath } from "../components";
import { SettingsResultSchema, UpdateSettingsRequestSchema, ReindexVectorsResultSchema, ReindexFailedVectorsResultSchema, StatusResultSchema } from "../gen/system_pb";
import { DevicePreference, EmbeddingModel, TaggerModel } from "../gen/common_pb";
import { FFmpegStatusResultSchema, SetFFmpegPathRequestSchema, DownloadProgressResultSchema, DownloadStatusUpdateSchema } from "../gen/models_pb";
import { StorageStatsResultSchema } from "../gen/folders_pb";
import { setStatusMessage } from "../utils";
import { getImageClickAction, setImageClickAction, getTagCopyReplaceUnderscores, setTagCopyReplaceUnderscores } from "../state";
import { applySettingsToUI, refreshTaggerStatus } from "./dashboard";
import { updateBenchmarkModelHeader } from "./benchmark";
import { updateReindexProgress, startReindexPolling } from "./settings-reindex";
import { setupMaintenanceButtons } from "./settings-maintenance";
import { buildOcrLabelSvg, getOcrTextSettings } from "../ocr-text";

function deviceToEnum(v: string): DevicePreference {
  return v === "cpu" ? DevicePreference.CPU : v === "gpu" ? DevicePreference.GPU : DevicePreference.AUTO;
}

function embeddingToEnum(v: string): EmbeddingModel {
  return v === "mobileclip-s2" ? EmbeddingModel.MOBILECLIP_S2 : EmbeddingModel.CLIP_VIT_B_32;
}

function taggerToEnum(v: string): TaggerModel {
  return v === "wd-eva02" ? TaggerModel.WD_EVA02 : TaggerModel.CAMIE;
}

export function setupSettings() {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const taggerWdSelect = document.getElementById("settings-tagger-wd-device") as HTMLSelectElement;
  const preferredTaggerSelect = document.getElementById("settings-preferred-tagger") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById("settings-detection-metrics-device") as HTMLSelectElement;
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
  const pathPreviewEl = document.getElementById("settings-path-preview");
  const savedMode = localStorage.getItem("curator-path-vis-mode") || "filename";
  const savedFolders = parseInt(localStorage.getItem("curator-path-vis-folders") || "1", 10);
  pathVisRadios.forEach(r => { r.checked = r.value === savedMode; });
  if (pathFoldersInput) pathFoldersInput.value = savedFolders.toString();
  const SAMPLE_PATH = "C:\\Users\\demo\\Pictures\\Anime\\Series\\Scene 01\\sample_image.png";
  const renderPathPreview = () => {
    if (pathPreviewEl) pathPreviewEl.textContent = maskPath(SAMPLE_PATH);
  };
  pathVisRadios.forEach(r => {
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
  const tagCopyReplaceUnderscoresCheckbox = document.getElementById("settings-tag-copy-replace-underscores") as HTMLInputElement;
  if (tagCopyReplaceUnderscoresCheckbox) {
    tagCopyReplaceUnderscoresCheckbox.checked = getTagCopyReplaceUnderscores();
    tagCopyReplaceUnderscoresCheckbox.addEventListener("change", () => {
      setTagCopyReplaceUnderscores(tagCopyReplaceUnderscoresCheckbox.checked);
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

  // OCR text rendering settings (localStorage) with live preview
  const ocrFontSizeSelect = document.getElementById("settings-ocr-font-size") as HTMLSelectElement;
  const ocrStrokeWidthSelect = document.getElementById("settings-ocr-stroke-width") as HTMLSelectElement;
  const ocrFontFamilySelect = document.getElementById("settings-ocr-font-family") as HTMLSelectElement;
  const ocrFitInBoxCheckbox = document.getElementById("settings-ocr-fit-in-box") as HTMLInputElement;
  const ocrVerticalTextCheckbox = document.getElementById("settings-ocr-vertical-text") as HTMLInputElement;
  const { fontSize, strokeWidth, fontFamily, fitInBox, verticalText } = getOcrTextSettings();
  if (ocrFontSizeSelect) ocrFontSizeSelect.value = fontSize.toString();
  if (ocrStrokeWidthSelect) ocrStrokeWidthSelect.value = strokeWidth.toString();
  if (ocrFontFamilySelect) {
    ocrFontFamilySelect.value = fontFamily;
    if (!ocrFontFamilySelect.value) ocrFontFamilySelect.value = "Segoe UI";
  }
  if (ocrFitInBoxCheckbox) ocrFitInBoxCheckbox.checked = fitInBox;
  if (ocrVerticalTextCheckbox) ocrVerticalTextCheckbox.checked = verticalText;

  const OCR_PREVIEW_BOXES = [
    { pts: [[30, 30], [190, 30], [190, 70], [30, 70]], text: "Lorem ipsum dolor", color: "#3498db", fill: "rgba(52, 152, 219, 0.15)" },
    { pts: [[100, 50], [300, 50], [300, 90], [100, 90]], text: "overlapping labels", color: "#9b59b6", fill: "rgba(155, 89, 182, 0.15)" },
    { pts: [[40, 110], [260, 110], [260, 155], [40, 155]], text: "pushed below", color: "#3498db", fill: "rgba(52, 152, 219, 0.15)" },
    { pts: [[410, 20], [450, 20], [450, 180], [410, 180]], text: "縦書き", color: "#9b59b6", fill: "rgba(155, 89, 182, 0.15)" },
  ];

  const preview = document.getElementById("settings-ocr-preview");

  function renderOcrPreview() {
    if (!preview) return;
    preview.innerHTML = buildOcrLabelSvg(OCR_PREVIEW_BOXES, 500, 200);
  }
  renderOcrPreview();

  // Mouse drag-to-move and drag-to-resize handlers using event delegation
  let isDragging = false;
  let activeIndex = -1;
  let activeAction: 'move' | 'resize' | null = null;
  let startX = 0;
  let startY = 0;
  let startPts: number[][] = [];

  if (preview) {
    preview.addEventListener("mousedown", (e) => {
      const target = e.target as SVGElement;
      if (!target) return;

      const isRect = target.classList.contains("preview-box-rect");
      const isHandle = target.classList.contains("preview-box-handle");

      if (isRect || isHandle) {
        const indexAttr = target.getAttribute("data-index");
        if (indexAttr === null) return;

        e.preventDefault();
        isDragging = true;
        activeIndex = parseInt(indexAttr, 10);
        activeAction = isHandle ? 'resize' : 'move';
        startX = e.clientX;
        startY = e.clientY;
        startPts = OCR_PREVIEW_BOXES[activeIndex].pts.map(pt => [...pt]);
      }
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging || activeIndex === -1) return;

      const svgEl = preview.querySelector("svg");
      if (!svgEl) return;

      const rect = svgEl.getBoundingClientRect();
      const scaleX = 500 / rect.width;
      const scaleY = 200 / rect.height;

      const dx = (e.clientX - startX) * scaleX;
      const dy = (e.clientY - startY) * scaleY;

      const box = OCR_PREVIEW_BOXES[activeIndex];
      const minX = Math.min(...startPts.map(pt => pt[0]));
      const minY = Math.min(...startPts.map(pt => pt[1]));
      const maxX = Math.max(...startPts.map(pt => pt[0]));
      const maxY = Math.max(...startPts.map(pt => pt[1]));

      if (activeAction === 'move') {
        const w = maxX - minX;
        const h = maxY - minY;

        const newMinX = Math.max(0, Math.min(500 - w, minX + dx));
        const newMinY = Math.max(0, Math.min(200 - h, minY + dy));

        box.pts = [
          [newMinX, newMinY],
          [newMinX + w, newMinY],
          [newMinX + w, newMinY + h],
          [newMinX, newMinY + h]
        ];
      } else if (activeAction === 'resize') {
        const newMaxX = Math.max(minX + 20, Math.min(500, maxX + dx));
        const newMaxY = Math.max(minY + 20, Math.min(200, maxY + dy));

        box.pts = [
          [minX, minY],
          [newMaxX, minY],
          [newMaxX, newMaxY],
          [minX, newMaxY]
        ];
      }

      renderOcrPreview();
    });

    window.addEventListener("mouseup", () => {
      isDragging = false;
      activeIndex = -1;
      activeAction = null;
    });
  }

  if (ocrFontSizeSelect) {
    ocrFontSizeSelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-font-size", ocrFontSizeSelect.value);
      renderOcrPreview();
    });
  }
  if (ocrStrokeWidthSelect) {
    ocrStrokeWidthSelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-stroke-width", ocrStrokeWidthSelect.value);
      renderOcrPreview();
    });
  }
  if (ocrFontFamilySelect) {
    ocrFontFamilySelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-font-family", ocrFontFamilySelect.value);
      renderOcrPreview();
    });
  }
  if (ocrFitInBoxCheckbox) {
    ocrFitInBoxCheckbox.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-fit-in-box", ocrFitInBoxCheckbox.checked ? "1" : "0");
      renderOcrPreview();
    });
  }
  if (ocrVerticalTextCheckbox) {
    ocrVerticalTextCheckbox.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-vertical-text", ocrVerticalTextCheckbox.checked ? "1" : "0");
      renderOcrPreview();
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
        preferredTagger: preferredTaggerSelect ? taggerToEnum(preferredTaggerSelect.value) : undefined,
      };

      await typedCall("SystemService.UpdateSettings", UpdateSettingsRequestSchema, updateReq, SettingsResultSchema);

      setStatusMessage(statusMsg, "Settings saved and applied successfully. If model was changed, reindexing has started.", "success");
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
    if (!confirm("Are you sure you want to reindex all vectors? This will rebuild the vector search index from scratch.")) {
      return;
    }
    setStatusMessage(statusMsg, "Reindexing all images...", "loading");
    try {
      await typedCall("SystemService.ReindexVectors", null, null, ReindexVectorsResultSchema);
      setStatusMessage(statusMsg, "Reindexing triggered successfully. The background worker is rebuilding the index.", "success");
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
      const resp = await typedCall("SystemService.ReindexFailedVectors", null, null, ReindexFailedVectorsResultSchema);
      const count = Number(resp.requeued);
      setStatusMessage(statusMsg, `Done! ${count} image(s) queued for re-vectorization.`, "success");
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

  // ── FFmpeg ────────────────────────────────────────────────────────────────
  const ffmpegStatusRow = document.getElementById("ffmpeg-status-row");
  const ffmpegPathInput = document.getElementById("settings-ffmpeg-path") as HTMLInputElement | null;
  const ffmpegSaveStatus = document.getElementById("ffmpeg-save-status-msg");

  async function refreshFfmpegStatus() {
    if (!ffmpegStatusRow) return;
    try {
      const resp = await typedCall("ModelsService.GetFFmpegStatus", null, null, FFmpegStatusResultSchema);
      const r = resp;
      if (r.available) {
        ffmpegStatusRow.innerHTML =
          `<span style="color: #107c41;"><i class="bi bi-check-circle-fill"></i> Available</span>` +
          `<code style="font-size: 10px; word-break: break-all;">${r.resolvedPath ?? ""}</code>` +
          (r.version ? `<span style="color: #666;">${r.version}</span>` : "");
      } else {
        ffmpegStatusRow.innerHTML =
          `<span style="color: #a4262c;"><i class="bi bi-exclamation-circle-fill"></i> Not found</span>` +
          `<span style="color: #666;">Video import/transcoding requires FFmpeg. Place <code>ffmpeg.exe</code> in the data <code>bin</code> folder or set a path below.</span>`;
      }
      if (ffmpegPathInput) {
        ffmpegPathInput.value = r.resolvedPath ?? "";
      }

      // Show "Use portable build" button if a portable exists but isn't the active path
      const existingPortableBtn = document.getElementById("use-portable-ffmpeg-btn");
      if (existingPortableBtn) existingPortableBtn.remove();

      const portablePath: string | null = r.portablePath ?? null;
      const isAlreadyUsingPortable = r.resolvedPath && portablePath &&
        r.resolvedPath.toLowerCase() === portablePath.toLowerCase();

      if (portablePath && !isAlreadyUsingPortable) {
        const portableRow = document.createElement("div");
        portableRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;";
        portableRow.innerHTML =
          `<span style="font-size:11px;color:#107c41;"><i class="bi bi-box-seam"></i> Portable build available</span>` +
          `<code style="font-size:10px;word-break:break-all;">${portablePath}</code>` +
          `<button class="win-button primary" id="use-portable-ffmpeg-btn"><i class="bi bi-arrow-left-right"></i> Switch to portable</button>`;
        ffmpegStatusRow.appendChild(portableRow);

        document.getElementById("use-portable-ffmpeg-btn")?.addEventListener("click", async () => {
          if (!ffmpegSaveStatus) return;
          setStatusMessage(ffmpegSaveStatus, "Switching to portable build...", "loading");
          try {
            await typedCall("ModelsService.SetFFmpegPath", SetFFmpegPathRequestSchema, { path: portablePath }, EmptySchema);
            setStatusMessage(ffmpegSaveStatus, "Switched to portable build.", "success");
            await refreshFfmpegStatus();
          } catch (e: any) {
            setStatusMessage(ffmpegSaveStatus, "Error: " + (e.message || e), "error");
          }
        });
      }
    } catch (e) {}
  }

  document.getElementById("browse-ffmpeg-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected && ffmpegPathInput) {
        ffmpegPathInput.value = selected;
      }
    } catch (e) {
      console.error("FFmpeg browse error:", e);
    }
  });

  document.getElementById("save-ffmpeg-path-btn")?.addEventListener("click", async () => {
    if (!ffmpegSaveStatus) return;
    const value = ffmpegPathInput ? ffmpegPathInput.value.trim() : "";
    setStatusMessage(ffmpegSaveStatus, "Saving...", "loading");
    try {
      await typedCall("ModelsService.SetFFmpegPath", SetFFmpegPathRequestSchema, { path: value || undefined }, EmptySchema);
      setStatusMessage(ffmpegSaveStatus, "FFmpeg path saved.", "success");
      await refreshFfmpegStatus();
    } catch (e: any) {
      setStatusMessage(ffmpegSaveStatus, "Error: " + (e.message || e), "error");
    }
  });

  // ── FFmpeg one-click download (reuses the model-download progress map) ───
  const ffmpegDlBtn = document.getElementById("download-ffmpeg-btn");  const ffmpegDlStatus = document.getElementById("ffmpeg-dl-status-msg");
  const ffmpegDlBar = document.getElementById("ffmpeg-dl-progress");
  const ffmpegDlFill = document.getElementById("ffmpeg-dl-progress-fill");
  let ffmpegDlTimer: number | null = null;

  document.getElementById("ffmpeg-release-link")?.addEventListener("click", () => {
    window.open("https://www.gyan.dev/ffmpeg/builds/", "_blank", "noopener");
  });

  function ffmpegDlStopPolling() {
    if (ffmpegDlTimer !== null) {
      window.clearInterval(ffmpegDlTimer);
      ffmpegDlTimer = null;
    }
  }

  function ffmpegDlStartPolling() {
    ffmpegDlStopPolling();
    ffmpegDlTimer = window.setInterval(async () => {
      try {
        const resp = await typedCall("ModelsService.GetDownloadProgress", null, null, DownloadProgressResultSchema);
        const dl = resp.downloads.find(d => d.modelId === "ffmpeg-portable");
        if (!dl) return;
        const bytesTotal = Number(dl.bytesTotal);
        const bytesDownloaded = Number(dl.bytesDownloaded);
        const pct = bytesTotal > 0
          ? Math.round((bytesDownloaded / bytesTotal) * 100)
          : 0;
        if (ffmpegDlBar) ffmpegDlBar.style.display = "";
        if (dl.status === "extracting") {
          if (ffmpegDlFill) ffmpegDlFill.style.width = "100%";
          if (ffmpegDlStatus) setStatusMessage(ffmpegDlStatus, "Extracting... please wait", "loading");
        } else {
          if (ffmpegDlFill) ffmpegDlFill.style.width = pct + "%";
          if (ffmpegDlStatus) {
            setStatusMessage(ffmpegDlStatus, `Downloading... ${pct}% (${bytesDownloaded} / ${bytesTotal} bytes)`, "loading");
          }
        }
        if (dl.status === "completed") {
          ffmpegDlStopPolling();
          if (ffmpegDlBar) ffmpegDlBar.style.display = "none";
          setStatusMessage(ffmpegDlStatus!, "FFmpeg downloaded and verified.", "success");
          if (ffmpegDlBtn) ffmpegDlBtn.removeAttribute("disabled");
          await refreshFfmpegStatus();
        } else if (dl.status === "failed" || dl.status === "cancelled") {
          ffmpegDlStopPolling();
          if (ffmpegDlBar) ffmpegDlBar.style.display = "none";
          setStatusMessage(ffmpegDlStatus!, dl.error || `FFmpeg download ${dl.status}.`, "error");
          if (ffmpegDlBtn) ffmpegDlBtn.removeAttribute("disabled");
        }
      } catch (e) {
        // transient poll errors are ignored; next tick retries
      }
    }, 500);
  }

  ffmpegDlBtn?.addEventListener("click", async () => {
    if (!ffmpegDlStatus) return;
    setStatusMessage(ffmpegDlStatus, "Starting download...", "loading");
    ffmpegDlBtn.setAttribute("disabled", "true");
    try {
      const resp = await typedCall("ModelsService.DownloadFFmpeg", null, null, DownloadStatusUpdateSchema);
      const prog = resp.progress;
      if (prog && prog.status === "downloading" && !resp.complete) {
        setStatusMessage(ffmpegDlStatus, "Download started.", "loading");
        ffmpegDlStartPolling();
      } else {
        const message = prog?.error || `FFmpeg download did not start.`;
        const already = message.includes("already");
        setStatusMessage(ffmpegDlStatus, message, already ? "success" : "error");
        ffmpegDlBtn.removeAttribute("disabled");
        if (!already) await refreshFfmpegStatus();
      }
    } catch (e: any) {
      setStatusMessage(ffmpegDlStatus, "Error: " + (e.message || e), "error");
      ffmpegDlBtn.removeAttribute("disabled");
    }
  });

  refreshFfmpegStatus();
  initStorageStats();
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderSettingsHtml(): SafeHtml {
  return html`
    <!-- Display settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Display</div>
      <p style="font-size: 11px; color: #333333;">Configure dashboard display preferences.</p>
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px;">
        <label style="font-weight: 600; min-width: 120px;">Path Visibility:</label>
        <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
            <input type="radio" name="path-vis" value="full"> Full path
          </label>
          <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
            <input type="radio" name="path-vis" value="filename" checked> Only filename
          </label>
          <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
            <input type="radio" name="path-vis" value="drive-filename"> Drive + filename
          </label>
          <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
            <input type="radio" name="path-vis" value="drive-folders"> Drive +
            <input type="number" id="settings-path-folders" class="input-field" min="0" max="10" value="1" style="width: 48px; padding: 2px 4px; font-size: 12px;"> folder(s) + filename
          </label>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 3px;">
        <i class="bi bi-file-earmark-image" style="color: var(--sys-border-focus); font-size: 13px;"></i>
        <span id="settings-path-preview" style="font-size: 12px; font-family: 'Consolas', 'Courier New', monospace; color: #333333; user-select: text;"></span>
      </div>
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;">
        <label style="font-weight: 600; min-width: 120px;">Favorites Button Visibility:</label>
        <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
          <input type="checkbox" id="settings-favorite-always-show" checked> Always show star on favorited images
        </label>
      </div>
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;">
        <label style="font-weight: 600; min-width: 120px;">Copied Tags:</label>
        <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
          <input type="checkbox" id="settings-tag-copy-replace-underscores"> Replace underscores with spaces in copied tags
        </label>
      </div>
    </div>

    <!-- Image Viewer settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Image Viewer</div>
      <p style="font-size: 11px; color: #333333;">Configure how images open in the viewer and how OCR result text labels are drawn on detection boxes.</p>
      <div class="form-group">
        <label style="font-weight: 600; min-width: 120px;">Click Action:</label>
        <select class="input-field" id="settings-image-click-action" style="width: 220px;">
          <option value="in-app">Open in App (Image Viewer)</option>
          <option value="external">Open with Default Application</option>
        </select>
      </div>
      <div style="border: 1px solid var(--sys-border-dark); border-radius: 3px; background-color: var(--sys-window-bg); padding: 10px 12px; display: flex; flex-direction: column; gap: 10px;">
        <label style="font-weight: 600; display: flex; align-items: center; gap: 6px; color: #333333;"><i class="bi bi-fonts" style="color: var(--sys-border-focus);"></i> OCR Text Rendering</label>
        <div class="ocr-render-grid">
          <div style="display: flex; flex-direction: column; gap: 10px; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Font:</label>
              <select class="input-field" id="settings-ocr-font-family" style="flex: 1; min-width: 0;">
                <option value="Segoe UI">Segoe UI (Default)</option>
                <option value="Arial">Arial</option>
                <option value="Calibri">Calibri</option>
                <option value="Tahoma">Tahoma</option>
                <option value="Verdana">Verdana</option>
                <option value="Consolas">Consolas</option>
                <option value="Courier New">Courier New</option>
                <option value="Georgia">Georgia</option>
                <option value="Times New Roman">Times New Roman</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Font Size:</label>
              <select class="input-field" id="settings-ocr-font-size" style="flex: 1; min-width: 0;">
                <option value="10">Small (10px)</option>
                <option value="12" selected>Normal (12px)</option>
                <option value="14">Large (14px)</option>
                <option value="16">Extra Large (16px)</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Text Outline:</label>
              <select class="input-field" id="settings-ocr-stroke-width" style="flex: 1; min-width: 0;">
                <option value="0">None</option>
                <option value="2">Thin (2px)</option>
                <option value="3">Medium (3px)</option>
                <option value="5" selected>Thick (5px)</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Fit to Box:</label>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; flex: 1; min-width: 0;">
                <input type="checkbox" id="settings-ocr-fit-in-box">
                Fit text inside its detection box
              </label>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Vertical Text:</label>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; flex: 1; min-width: 0;">
                <input type="checkbox" id="settings-ocr-vertical-text">
                Stack text vertically in vertical boxes
              </label>
            </div>
          </div>
          <div style="min-width: 0;">
            <label style="font-weight: 600; display: block; margin-bottom: 4px;">Preview:</label>
            <div id="settings-ocr-preview" style="border: 1px solid #cccccc; border-radius: 4px; overflow: hidden; max-width: 600px; width: 100%;"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Model Device Settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="group-box-title">Model Device Settings</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 4px;">Choose whether each model runs on CPU or GPU, and how long to keep models in memory after last use.</p>

      <div class="device-grid">

        <!-- Embedding Model -->
        <div class="device-card span-full">
          <div class="device-card-title"><i class="bi bi-layers"></i> Active Embedding Model</div>
          <p class="device-card-desc">Select the model used for vector embeddings. Changing the model will automatically clear the current vector index and reindex all images in the database.</p>
          <div class="device-card-row">
            <label>Model:</label>
            <select class="input-field" id="settings-embedding-model" style="width: 220px;">
              <option value="clip-vit-b-32">CLIP ViT-B/32 (Standard)</option>
              <option value="mobileclip-s2">MobileCLIP-S2 (Fast + Accurate)</option>
            </select>
            <button class="win-button" id="reindex-vectors-btn" style="padding: 2px 8px; font-size: 11px;">
              <i class="bi bi-arrow-repeat"></i> Reindex Everything
            </button>
            <button class="win-button" id="reindex-failed-btn" style="padding: 2px 8px; font-size: 11px;">
              <i class="bi bi-arrow-repeat"></i> Retry Failed
            </button>
          </div>
          <!-- Reindexing Progress -->
          <div id="reindex-progress-container" style="display: none; margin-top: 4px; border-top: 1px solid #eee; padding-top: 10px;">
            <div style="margin-bottom: 8px;">
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;">
                <span id="reindex-preprocess-text">Preprocessing progress: 0/0 (0%)</span>
                <span style="font-weight: 600; color: #3b82f6;">CPU Preprocessing</span>
              </div>
              <div class="progress-bar">
                <div id="reindex-preprocess-bar" class="progress-fill" style="width: 0%;"></div>
              </div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;">
                <span id="reindex-index-text">Indexing progress: 0/0 (0%)</span>
                <span id="reindex-progress-status" style="font-weight: 600; color: #b78103;">Inference &amp; Indexing</span>
              </div>
              <div class="progress-bar">
                <div id="reindex-index-bar" class="progress-fill" style="width: 0%;"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- CLIP Device -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-search"></i> CLIP ViT-B/32</div>
          <p class="device-card-desc">Powers image embedding generation and text-to-image semantic search.</p>
          <div class="device-card-row">
            <label>Device:</label>
            <select class="input-field" id="settings-clip-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- Preferred Tagger -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-star"></i> Preferred Tagger</div>
          <p class="device-card-desc">Choose which auto-tagger model is active and displayed across the app.</p>
          <div class="device-card-row">
            <label>Tagger:</label>
            <select class="input-field" id="settings-preferred-tagger" style="width: 150px;">
              <option value="camie">Camie Tagger v2 (Default)</option>
              <option value="wd-eva02">WD EVA02 Tagger (Canary)</option>
            </select>
            <button class="win-button" id="save-preferred-tagger-btn" style="padding: 2px 8px; font-size: 11px;"><i class="bi bi-save"></i> Save</button>
          </div>
        </div>

        <!-- Tagger Device -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-tag-fill"></i> Camie Tagger Device</div>
          <p class="device-card-desc">Inference device preference for the Camie Tagger v2 model.</p>
          <div class="device-card-row">
            <label>Device:</label>
            <select class="input-field" id="settings-tagger-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
            <button class="win-button" id="save-tagger-device-btn" style="padding: 2px 8px; font-size: 11px;"><i class="bi bi-save"></i> Save</button>
          </div>
        </div>

        <!-- WD Tagger Device -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-tags"></i> WD EVA02 Tagger Device</div>
          <p class="device-card-desc">Inference device preference for the WD EVA02 Tagger model.</p>
          <div class="device-card-row">
            <label>Device:</label>
            <select class="input-field" id="settings-tagger-wd-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
            <button class="win-button" id="save-tagger-wd-device-btn" style="padding: 2px 8px; font-size: 11px;"><i class="bi bi-save"></i> Save</button>
          </div>
        </div>

        <!-- Detection Devices -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-bounding-box"></i> Character Detection</div>
          <p class="device-card-desc">YOLO detects character bounding boxes; CCIP extracts identity embeddings. The metrics model is tiny (16x768) and should stay on CPU.</p>
          <div class="device-card-row">
            <label>Feature extractors:</label>
            <select class="input-field" id="settings-detection-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
          <div class="device-card-row">
            <label>Metrics (similarity):</label>
            <select class="input-field" id="settings-detection-metrics-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu" selected>CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- OCR Device -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-fonts"></i> OCR Text Recognition</div>
          <p class="device-card-desc">Powers Optical Character Recognition and text box detection (PP-OCRv6 small).</p>
          <div class="device-card-row">
            <label>OCR Device:</label>
            <select class="input-field" id="settings-ocr-device" style="width: 150px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- Idle Timeout -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-memory"></i> Memory Management</div>
          <p class="device-card-desc">Automatically unload models from memory after a period of inactivity to free GPU/RAM.</p>
          <div class="device-card-row">
            <label>Idle timeout:</label>
            <select class="input-field" id="settings-idle-timeout" style="width: 150px;">
              <option value="60">1 minute</option>
              <option value="120">2 minutes</option>
              <option value="300" selected>5 minutes</option>
              <option value="600">10 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="0">Never unload</option>
            </select>
          </div>
        </div>
      </div>

      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="save-settings-btn">
          <i class="bi bi-check-lg"></i> Save Settings
        </button>
        <span id="settings-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
      <div style="background-color: #e8f5e9; border: 1px solid #a5d6a7; padding: 8px; border-radius: 2px; color: #2e7d32; font-size: 11px;">
        <strong>Note:</strong> Device changes take effect immediately. Models are automatically unloaded after the idle timeout, then reloaded on the next inference call.
      </div>
    </div>

    <!-- Thumbnail Settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Thumbnail Settings</div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Thumbnail Cache</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">Purge cached thumbnails for images that are no longer present on disk, or clear the entire thumbnail cache to force regeneration on demand.</p>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="win-button" id="clear-thumbnail-cache-btn"><i class="bi bi-trash"></i> Clear Thumbnail Cache</button>
          <span id="clear-thumbnail-status-msg" style="font-size: 11px;"></span>
          <button class="win-button danger" id="purge-missing-thumbs-btn"><i class="bi bi-trash"></i> Purge Missing Thumbnails</button>
          <span id="purge-status-msg" style="font-size: 11px;"></span>
        </div>
      </div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Crop Thumbnails</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">Clear the cached bounding box crops. This forces the system to regenerate crop thumbnails from original files on demand.</p>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="win-button" id="clear-crop-cache-btn">
            <i class="bi bi-trash"></i> Clear Crop Cache
          </button>
          <span id="clear-crop-cache-status-msg" style="font-size: 11px; min-height: 16px;"></span>
        </div>
      </div>
    </div>

    <!-- Folder Management -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Folder Management</div>
      <p style="font-size: 11px; color: #333333;">Assign existing images to their parent folders. This is useful if you have images imported before folder tracking was enabled.</p>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="backfill-folders-btn">
          <i class="bi bi-folder-fill"></i> Backfill Image Folders
        </button>
        <span id="backfill-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
    </div>

    <!-- Media Metadata -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Media Metadata</div>
      <p style="font-size: 11px; color: #333333;">Populate dimensions and GIF animation details (frame count, duration) for images imported before media metadata tracking existed.</p>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="backfill-media-metadata-btn">
          <i class="bi bi-film"></i> Backfill Media Metadata
        </button>
        <span id="backfill-media-metadata-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
    </div>

    <!-- FFmpeg -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title"><i class="bi bi-collection-play"></i> FFmpeg</div>
      <p style="font-size: 11px; color: #333333; margin: 0;">FFmpeg is required for video import, frame extraction, animated previews, and transcoding. Curator resolves it from your configured path, the local <code>bin</code> folder, or your system PATH.</p>
      <div id="ffmpeg-status-row" style="display: flex; align-items: center; gap: 8px; font-size: 11px;"></div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Executable Path (optional)</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" id="settings-ffmpeg-path" style="flex: 1; padding: 4px 8px; font-size: 11px; border: 1px solid #b0b0b0; border-radius: 2px;" placeholder="Leave empty to auto-detect" />
          <button class="win-button" id="browse-ffmpeg-btn"><i class="bi bi-folder2-open"></i> Browse</button>
          <button class="win-button primary" id="save-ffmpeg-path-btn"><i class="bi bi-check-lg"></i> Save</button>
        </div>
        <span id="ffmpeg-save-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Portable Download</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">Downloads the portable Windows FFmpeg build into the data <code>bin</code> folder and verifies it by running <code>ffmpeg -version</code>.</p>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Source: <a href="javascript:void(0)" id="ffmpeg-release-link" style="color: #004aad; text-decoration: none;">gyan.dev FFmpeg release builds</a>
          <span style="color: #777777;">(ffmpeg-release-essentials.zip)</span>
        </p>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="win-button" id="download-ffmpeg-btn"><i class="bi bi-download"></i> Download FFmpeg</button>
          <div class="progress-bar" style="flex: 1; max-width: 240px; display: none;" id="ffmpeg-dl-progress"><div class="progress-fill" id="ffmpeg-dl-progress-fill" style="width: 0%;"></div></div>
          <span id="ffmpeg-dl-status-msg" style="font-size: 11px; min-height: 16px;"></span>
        </div>
      </div>
    </div>

    <!-- Storage Usage -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title"><i class="bi bi-pie-chart"></i> Storage Usage</div>
      <p style="font-size: 11px; color: #333333; margin: 0 0 4px;">Analyze disk space occupied by different media types in your library.</p>
      <div style="display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 8px; align-items: flex-start;">
        <span style="font-size: 11px; font-weight: 600;" id="storage-total-display">Total Storage: Calculating...</span>
        <div style="display: flex; gap: 4px;">
          <span class="note-tab active" id="storage-tab-bar" style="user-select:none; cursor:pointer;">Stacked Bar</span>
          <span class="note-tab" id="storage-tab-pie" style="user-select:none; cursor:pointer;">Pie Chart</span>
          <span class="note-tab" id="storage-tab-tree" style="user-select:none; cursor:pointer;">Quadtree</span>
        </div>
      </div>
      <div id="storage-visual-container" style="min-height: 200px; display: flex; align-items: center; justify-content: flex-start; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px; position: relative; padding: 12px; box-sizing: border-box; width: 100%;">
        <!-- Charts rendered here -->
      </div>
    </div>
  `;
}

async function initStorageStats() {
  const totalDisplay = document.getElementById("storage-total-display");
  const container = document.getElementById("storage-visual-container");
  const tabBar = document.getElementById("storage-tab-bar");
  const tabPie = document.getElementById("storage-tab-pie");
  const tabTree = document.getElementById("storage-tab-tree");

  if (!container) return;

  container.innerHTML = '<div style="font-size:11px;color:#888;"><i class="bi bi-hourglass-split"></i> Loading storage stats...</div>';

  try {
    const resp = await typedCall("FoldersService.GetStorageStats", null, null, StorageStatsResultSchema);
    if (!resp.stats) {
      container.innerHTML = '<div style="font-size:11px;color:#dc3545;">Failed to load storage statistics.</div>';
      return;
    }

    const stats = resp.stats.stats;

    // Helper: format bytes to human readable
    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    // Calculate totals
    const totalBytes = stats.reduce((acc: number, s: any) => acc + Number(s.sizeBytes), 0);
    const totalCount = stats.reduce((acc: number, s: any) => acc + Number(s.count), 0);
    if (totalDisplay) {
      totalDisplay.textContent = `Total Storage: ${formatBytes(totalBytes)} (${totalCount} file(s))`;
    }

    // Group stats by Category: Images, GIFs, Videos, Other
    // Initial rich visualization colors restored
    const categoriesMap: Record<string, { size: number; count: number; color: string; textColor: string; borderColor: string; exts: string[] }> = {
      "Images": { size: 0, count: 0, color: "#0078d7", textColor: "#ffffff", borderColor: "#005499", exts: [] },
      "GIFs": { size: 0, count: 0, color: "#28a745", textColor: "#ffffff", borderColor: "#1e7e34", exts: [] },
      "Videos": { size: 0, count: 0, color: "#e0a800", textColor: "#ffffff", borderColor: "#b38600", exts: [] },
      "Other": { size: 0, count: 0, color: "#6c757d", textColor: "#ffffff", borderColor: "#545b62", exts: [] },
    };

    for (const stat of stats) {
      const cat = stat.category;
      if (categoriesMap[cat]) {
        categoriesMap[cat].size += Number(stat.sizeBytes);
        categoriesMap[cat].count += Number(stat.count);
        categoriesMap[cat].exts.push(stat.extension);
      } else {
        categoriesMap["Other"].size += Number(stat.sizeBytes);
        categoriesMap["Other"].count += Number(stat.count);
        categoriesMap["Other"].exts.push(stat.extension);
      }
    }

    const categories = Object.entries(categoriesMap)
      .map(([name, data]) => ({
        name,
        size: data.size,
        count: data.count,
        color: data.color,
        textColor: data.textColor,
        borderColor: data.borderColor,
        percentage: totalBytes > 0 ? (data.size / totalBytes) * 100 : 0,
        exts: data.exts,
      }))
      .filter(c => c.size > 0 || c.count > 0);

    let activeTab: "bar" | "pie" | "tree" = "bar";

    const updateTabs = (selected: "bar" | "pie" | "tree") => {
      activeTab = selected;
      [tabBar, tabPie, tabTree].forEach(t => t?.classList.remove("active"));
      if (selected === "bar") tabBar?.classList.add("active");
      if (selected === "pie") tabPie?.classList.add("active");
      if (selected === "tree") tabTree?.classList.add("active");
      renderChart();
    };

    tabBar?.addEventListener("click", () => updateTabs("bar"));
    tabPie?.addEventListener("click", () => updateTabs("pie"));
    tabTree?.addEventListener("click", () => updateTabs("tree"));

    const renderChart = () => {
      if (totalBytes === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#888;font-style:italic;">No media files indexed yet.</div>';
        return;
      }

      if (activeTab === "bar") {
        renderStackedBar();
      } else if (activeTab === "pie") {
        renderPieChart();
      } else {
        renderTreemap();
      }
    };

    const renderStackedBar = () => {
      let barSegments = "";
      let legendRows = "";

      categories.forEach(cat => {
        if (cat.size === 0) return;
        const w = cat.percentage;
        barSegments += `
          <div style="width: ${w}%; background: ${cat.color}; border: 1.5px solid ${cat.borderColor}; border-right: 1px solid var(--sys-border-dark); height: 100%; box-sizing: border-box;" 
               title="${cat.name}: ${formatBytes(cat.size)} (${cat.count} files, ${cat.percentage.toFixed(1)}%)">
          </div>
        `;

        legendRows += `
          <tr style="font-size:11px; border-bottom: 1px solid var(--sys-border-light);">
            <td style="width:14px;height:14px;padding:6px;"><div style="width:12px;height:12px;background:${cat.color};border:1.5px solid ${cat.borderColor};"></div></td>
            <td style="font-weight:600;padding:6px 8px;color:var(--sys-window-text);">${cat.name}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--sys-window-text);">${formatBytes(cat.size)}</td>
            <td style="padding:6px 8px;text-align:right;color:#888;">${cat.count} file(s)</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;color:var(--sys-window-text);">${cat.percentage.toFixed(1)}%</td>
          </tr>
        `;
      });

      container.innerHTML = `
        <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
          <div style="width:100%; height:32px; border:1px solid var(--sys-border-dark); background:#f0f0f0; border-radius:2px; display:flex; overflow:hidden; padding: 2px; box-sizing:border-box;">
            ${barSegments}
          </div>
          <table class="curator-table" style="width:100%;max-width:420px;margin-top:4px;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom: 1px solid var(--sys-border-dark); color: #555; text-align:left; font-size:11px;">
                <th colspan="2" style="padding:4px 8px;">Category</th>
                <th style="padding:4px 8px;text-align:right;">Size</th>
                <th style="padding:4px 8px;text-align:right;">Count</th>
                <th style="padding:4px 8px;text-align:right;">Percentage</th>
              </tr>
            </thead>
            <tbody>${legendRows}</tbody>
          </table>
        </div>
      `;
    };

    const renderPieChart = () => {
      let accumulatedAngle = 0;
      let paths = "";
      let legendRows = "";

      categories.forEach(cat => {
        if (cat.size === 0) return;
        
        const percentage = cat.percentage / 100;
        const angle = percentage * 360;
        
        const r = 70; 
        const ir = 38; 
        
        const x1_out = 100 + r * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y1_out = 100 - r * Math.cos((accumulatedAngle * Math.PI) / 180);
        const x1_in = 100 + ir * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y1_in = 100 - ir * Math.cos((accumulatedAngle * Math.PI) / 180);
        
        accumulatedAngle += angle;
        
        const x2_out = 100 + r * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y2_out = 100 - r * Math.cos((accumulatedAngle * Math.PI) / 180);
        const x2_in = 100 + ir * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y2_in = 100 - ir * Math.cos((accumulatedAngle * Math.PI) / 180);
        
        const largeArc = percentage > 0.5 ? 1 : 0;
        
        const d = `
          M ${x1_out} ${y1_out}
          A ${r} ${r} 0 ${largeArc} 1 ${x2_out} ${y2_out}
          L ${x2_in} ${y2_in}
          A ${ir} ${ir} 0 ${largeArc} 0 ${x1_in} ${y1_in}
          Z
        `;
        
        paths += `<path d="${d}" fill="${cat.color}" stroke="${cat.borderColor}" stroke-width="1.5">
          <title>${cat.name}: ${formatBytes(cat.size)} (${cat.percentage.toFixed(1)}%)</title>
        </path>`;

        legendRows += `
          <tr style="font-size:11px; border-bottom:1px solid var(--sys-border-light);">
            <td style="width:14px;height:14px;padding:6px;"><div style="width:12px;height:12px;background:${cat.color};border:1.5px solid ${cat.borderColor};"></div></td>
            <td style="font-weight:600;padding:6px 8px;color:var(--sys-window-text);">${cat.name}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--sys-window-text);">${formatBytes(cat.size)}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;color:var(--sys-window-text);">${cat.percentage.toFixed(1)}%</td>
          </tr>
        `;
      });

      container.innerHTML = `
        <div style="width:100%;display:flex;align-items:center;justify-content:flex-start;gap:40px;flex-wrap:wrap;padding: 10px 0;margin-right:auto;">
          <svg width="200" height="200" viewBox="0 0 200 200" style="filter: drop-shadow(0px 1px 3px rgba(0,0,0,0.15)); margin: 0;">
            ${paths}
          </svg>
          <table class="curator-table" style="max-width:320px;flex:1;border-collapse:collapse;margin: 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--sys-border-dark); color: #555; text-align:left; font-size:11px;">
                <th colspan="2" style="padding:4px 8px;">Category</th>
                <th style="padding:4px 8px;text-align:right;">Size</th>
                <th style="padding:4px 8px;text-align:right;">Percentage</th>
              </tr>
            </thead>
            <tbody>${legendRows}</tbody>
          </table>
        </div>
      `;
    };

    const renderTreemap = () => {
      const width = 480;
      const height = 200;

      interface TreemapItem {
        name: string;
        size: number;
        color: string;
        percent: number;
        textColor: string;
        borderColor: string;
      }

      const items: TreemapItem[] = categories
        .filter(c => c.size > 0)
        .map(c => ({
          name: c.name,
          size: c.size,
          color: c.color,
          percent: c.percentage,
          textColor: c.textColor,
          borderColor: c.borderColor,
        }))
        .sort((a, b) => b.size - a.size);

      let rectsHtml = "";

      const divide = (
        x: number,
        y: number,
        w: number,
        h: number,
        itemList: TreemapItem[],
        vertical: boolean
      ) => {
        if (itemList.length === 0) return;
        if (itemList.length === 1) {
          const item = itemList[0];
          const label = w > 60 && h > 30 ? `<text x="${x + 8}" y="${y + 18}" fill="${item.textColor}" font-size="10" font-weight="600" font-family="'Segoe UI', -apple-system, sans-serif">${item.name}</text>
             <text x="${x + 8}" y="${y + 30}" fill="${item.textColor}" opacity="0.85" font-size="9" font-family="'Segoe UI', -apple-system, sans-serif">${formatBytes(item.size)}</text>` : "";
          rectsHtml += `
            <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${item.color}" stroke="${item.borderColor}" stroke-width="1.5">
              <title>${item.name}: ${formatBytes(item.size)} (${item.percent.toFixed(1)}%)</title>
            </rect>
            ${label}
          `;
          return;
        }

        const sumSize = itemList.reduce((acc: number, it: TreemapItem) => acc + it.size, 0);

        let balanceIndex = 1;
        let runningSum = itemList[0].size;
        for (let i = 1; i < itemList.length - 1; i++) {
          if (Math.abs(2 * (runningSum + itemList[i].size) - sumSize) < Math.abs(2 * runningSum - sumSize)) {
            runningSum += itemList[i].size;
            balanceIndex = i + 1;
          } else {
            break;
          }
        }

        const leftList = itemList.slice(0, balanceIndex);
        const rightList = itemList.slice(balanceIndex);

        const leftRatio = runningSum / sumSize;

        if (vertical) {
          const splitW = w * leftRatio;
          divide(x, y, splitW, h, leftList, !vertical);
          divide(x + splitW, y, w - splitW, h, rightList, !vertical);
        } else {
          const splitH = h * leftRatio;
          divide(x, y, w, splitH, leftList, !vertical);
          divide(x, y + splitH, w, h - splitH, rightList, !vertical);
        }
      };

      divide(0, 0, width, height, items, true);

      container.innerHTML = `
        <svg width="100%" height="200" viewBox="0 0 480 200" preserveAspectRatio="xMinYMid meet" style="border:1px solid var(--sys-border-dark);border-radius:2px;background:var(--sys-window-bg);margin-right:auto;">
          ${rectsHtml}
        </svg>
      `;
    };

    renderChart();

  } catch (err) {
    console.error("Failed to load storage stats:", err);
    container.innerHTML = '<div style="font-size:11px;color:#dc3545;">Error loading storage statistics.</div>';
  }
}
