import { callService } from "../ipc";
import { setStatusMessage } from "../utils";
import { getImageClickAction, setImageClickAction } from "../state";
import { applySettingsToUI, refreshTaggerStatus } from "./dashboard";
import { updateBenchmarkModelHeader } from "./benchmark";
import { updateReindexProgress, startReindexPolling } from "./settings-reindex";
import { setupMaintenanceButtons } from "./settings-maintenance";
import { buildOcrLabelSvg, getOcrTextSettings } from "../ocr-text";

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

  // OCR text rendering settings (localStorage) with live preview
  const ocrFontSizeSelect = document.getElementById("settings-ocr-font-size") as HTMLSelectElement;
  const ocrStrokeWidthSelect = document.getElementById("settings-ocr-stroke-width") as HTMLSelectElement;
  const { fontSize, strokeWidth } = getOcrTextSettings();
  if (ocrFontSizeSelect) ocrFontSizeSelect.value = fontSize.toString();
  if (ocrStrokeWidthSelect) ocrStrokeWidthSelect.value = strokeWidth.toString();

  const OCR_PREVIEW_BOXES = [
    { pts: [[20, 20], [150, 18], [152, 42], [22, 44]], text: "Lorem ipsum", color: "#3498db", fill: "rgba(52, 152, 219, 0.15)" },
    { pts: [[60, 34], [230, 30], [233, 64], [63, 68]], text: "overlapping labels", color: "#9b59b6", fill: "rgba(155, 89, 182, 0.15)" },
    { pts: [[30, 78], [210, 74], [214, 108], [34, 112]], text: "pushed below", color: "#3498db", fill: "rgba(52, 152, 219, 0.15)" },
  ];

  function renderOcrPreview() {
    const preview = document.getElementById("settings-ocr-preview");
    if (!preview) return;
    preview.innerHTML = buildOcrLabelSvg(OCR_PREVIEW_BOXES, 260, 130);
  }
  renderOcrPreview();

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

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderSettingsHtml(): string {
  return `
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
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;">
        <label style="font-weight: 600; min-width: 120px;">Favorites Button Visibility:</label>
        <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;">
          <input type="checkbox" id="settings-favorite-always-show" checked> Always show star on favorited images
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
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 12px;">
        <label style="font-weight: 600; display: block; margin-bottom: 6px;">OCR Text Rendering:</label>
        <div style="display: flex; gap: 16px; flex-wrap: wrap;">
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Font Size:</label>
            <select class="input-field" id="settings-ocr-font-size" style="width: 140px;">
              <option value="10">Small (10px)</option>
              <option value="12" selected>Normal (12px)</option>
              <option value="14">Large (14px)</option>
              <option value="16">Extra Large (16px)</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Text Outline:</label>
            <select class="input-field" id="settings-ocr-stroke-width" style="width: 140px;">
              <option value="0">None</option>
              <option value="2">Thin (2px)</option>
              <option value="3">Medium (3px)</option>
              <option value="5" selected>Thick (5px)</option>
            </select>
          </div>
        </div>
        <div style="margin-top: 4px;">
          <label style="font-weight: 600; display: block; margin-bottom: 4px;">Preview:</label>
          <div id="settings-ocr-preview" style="border: 1px solid #cccccc; border-radius: 4px; overflow: hidden; max-width: 420px;"></div>
        </div>
      </div>
    </div>

    <!-- Model Device Settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 16px;">
      <div class="group-box-title">Model Device Settings</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 8px;">Choose whether each model runs on CPU or GPU, and how long to keep models in memory after last use.</p>

      <div style="display: flex; flex-direction: column; gap: 16px;">
        <!-- Embedding Model -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">Active Embedding Model</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">
            Select the model used for vector embeddings. Changing the model will automatically clear the current vector index and reindex all images in the database.
          </p>
          <div style="display: flex; gap: 16px; align-items: center;">
            <div class="form-group" style="margin-bottom: 0;">
              <label style="font-weight: 600; min-width: 120px;">Model:</label>
              <select class="input-field" id="settings-embedding-model" style="width: 280px;">
                <option value="clip-vit-b-32">CLIP ViT-B/32 (Standard)</option>
                <option value="mobileclip-s2">MobileCLIP-S2 (Fast + Accurate)</option>
              </select>
            </div>
            <button class="win-button" id="reindex-vectors-btn" style="padding: 4px 8px; font-size: 11px;">
              <i class="bi bi-arrow-repeat"></i> Reindex Everything
            </button>
            <button class="win-button" id="reindex-failed-btn" style="padding: 4px 8px; font-size: 11px;">
              <i class="bi bi-arrow-repeat"></i> Retry Failed
            </button>
          </div>
          <!-- Reindexing Progress -->
          <div id="reindex-progress-container" style="display: none; margin-top: 12px; border-top: 1px solid #eee; padding-top: 12px;">
            <div style="margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;">
                <span id="reindex-preprocess-text">Preprocessing progress: 0/0 (0%)</span>
                <span style="font-weight: 600; color: #3b82f6;">CPU Preprocessing</span>
              </div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div id="reindex-preprocess-bar" style="width: 0%; height: 100%; background-color: #3b82f6; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;">
                <span id="reindex-index-text">Indexing progress: 0/0 (0%)</span>
                <span id="reindex-progress-status" style="font-weight: 600; color: #fbbf24;">Inference &amp; Indexing</span>
              </div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div id="reindex-index-bar" style="width: 0%; height: 100%; background-color: #10b981; transition: width 0.3s ease;"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- CLIP Device -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">CLIP ViT-B/32 (Semantic Search)</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">Powers image embedding generation and text-to-image semantic search.</p>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Device:</label>
            <select class="input-field" id="settings-clip-device" style="width: 180px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- Tagger Device -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">Camie Tagger v2 (Auto-Tagging)</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">Powers AI-based image tagging. Lazy-loaded on first use.</p>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Device:</label>
            <select class="input-field" id="settings-tagger-device" style="width: 180px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- Detection Devices -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">Character Detection (YOLO + CCIP)</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">
            YOLO detects character bounding boxes; CCIP extracts identity embeddings. The metrics model is tiny (16x768) and should stay on CPU.
          </p>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Feature extractors:</label>
            <select class="input-field" id="settings-detection-device" style="width: 180px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Metrics (similarity):</label>
            <select class="input-field" id="settings-detection-metrics-device" style="width: 180px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu" selected>CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- OCR Device -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">OCR Text Recognition (PP-OCRv6 small)</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">Powers Optical Character Recognition and text box detection.</p>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">OCR Device:</label>
            <select class="input-field" id="settings-ocr-device" style="width: 180px;">
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- Idle Timeout -->
        <div class="group-box" style="padding: 12px;">
          <div class="group-box-title">Memory Management</div>
          <p style="font-size: 11px; color: #666; margin-bottom: 8px; margin-top: 4px;">
            Automatically unload models from memory after a period of inactivity to free GPU/RAM.
          </p>
          <div class="form-group">
            <label style="font-weight: 600; min-width: 120px;">Idle timeout:</label>
            <select class="input-field" id="settings-idle-timeout" style="width: 180px;">
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

    <!-- Thumbnail Cache -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Thumbnail Cache</div>
      <p style="font-size: 11px; color: #333333;">Purge cached thumbnails for images that are no longer present on disk.</p>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="win-button danger" id="purge-missing-thumbs-btn"><i class="bi bi-trash"></i> Purge Missing Thumbnails</button>
        <span id="purge-status-msg" style="font-size: 11px;"></span>
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

    <!-- Cache Management -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Cache Management</div>
      <p style="font-size: 11px; color: #333333;">Clear the cached bounding box crops. This forces the system to regenerate crop thumbnails from original files on demand.</p>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="clear-crop-cache-btn">
          <i class="bi bi-trash"></i> Clear Crop Cache
        </button>
        <span id="clear-crop-cache-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
    </div>
  `;
}
