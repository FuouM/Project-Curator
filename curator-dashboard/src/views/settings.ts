import { html, SafeHtml } from "../components";
import { initStorageStats } from "./settings/storage-stats";
import {
  bindOcrPreviewControls,
  renderOcrPreview,
  setupOcrDragListeners,
} from "./settings/ocr-preview";
import { refreshFfmpegStatus, setupFfmpegListeners } from "./settings/ffmpeg-status";
import { bindSettingsForm } from "./settings/settings-form";
import {
  loadNsfwPrefs,
  saveNsfwPrefs,
  NsfwAction,
  refreshAllNsfw,
  DEFAULT_NSFW_PREFS,
} from "../nsfw";
import { getSafetyRescanProgress, triggerSafetyRescan } from "../ipc";

export function setupSettings() {
  bindSettingsForm();
  bindNsfwPreferences();

  const previewContainer = document.getElementById("settings-ocr-preview");
  const ffmpegStatusRow = document.getElementById("ffmpeg-status-row");
  const ffmpegPathInput = document.getElementById(
    "settings-ffmpeg-path",
  ) as HTMLInputElement | null;
  const ffmpegSaveStatus = document.getElementById("ffmpeg-save-status-msg");

  bindOcrPreviewControls();
  if (previewContainer) {
    renderOcrPreview();
    setupOcrDragListeners(previewContainer);
  }

  if (ffmpegStatusRow || ffmpegPathInput) {
    setupFfmpegListeners(ffmpegStatusRow, ffmpegPathInput, ffmpegSaveStatus);
  }

  refreshFfmpegStatus();
  initStorageStats();
}

const NSFW_ACTIONS: { value: NsfwAction; label: string; icon: string; hint: string }[] = [
  {
    value: "none",
    label: "Do Nothing",
    icon: "bi-eye",
    hint: "Show all content unmodified (default).",
  },
  {
    value: "blur",
    label: "Blur NSFW Content",
    icon: "bi-eye-slash",
    hint: "Blur redacted thumbnails; hover to preview.",
  },
  {
    value: "pixelate",
    label: "Pixelate NSFW Content",
    icon: "bi-grid",
    hint: "Pixelate redacted thumbnails; hover to preview.",
  },
  {
    value: "hide",
    label: "Hide NSFW Content",
    icon: "bi-check2-circle",
    hint: "Cover thumbnails with a solid black rectangle; no hover preview.",
  },
];

function bindNsfwPreferences() {
  const prefs = loadNsfwPrefs();

  const radios = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="nsfw-action"]'),
  );
  radios.forEach((radio) => {
    if (radio.value === prefs.action) radio.checked = true;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const action = radio.value as NsfwAction;
      saveNsfwPrefs({ ...loadNsfwPrefs(), action });
      updateNsfwHint(action);
      refreshAllNsfw();
    });
  });

  const slider = document.getElementById("nsfw-threshold") as HTMLInputElement | null;
  const sliderReadout = document.getElementById("nsfw-threshold-value");
  if (slider && sliderReadout) {
    slider.value = String(prefs.threshold);
    sliderReadout.textContent = `${Math.round(prefs.threshold * 100)}%`;
    slider.addEventListener("change", () => {
      const threshold = parseFloat(slider.value);
      if (isNaN(threshold)) return;
      saveNsfwPrefs({ ...loadNsfwPrefs(), threshold });
      refreshAllNsfw();
    });
    slider.addEventListener("input", () => {
      sliderReadout.textContent = `${Math.round(parseFloat(slider.value) * 100)}%`;
    });

    const resetBtn = document.getElementById("nsfw-threshold-reset") as HTMLButtonElement | null;
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const defaultThreshold = DEFAULT_NSFW_PREFS.threshold;
        slider.value = String(defaultThreshold);
        sliderReadout.textContent = `${Math.round(defaultThreshold * 100)}%`;
        saveNsfwPrefs({ ...loadNsfwPrefs(), threshold: defaultThreshold });
        refreshAllNsfw();
      });
    }
  }

  const scanBtn = document.getElementById("nsfw-scan-btn") as HTMLButtonElement | null;
  const progressWrap = document.getElementById("nsfw-scan-progress-wrap");
  const progressBar = document.getElementById("nsfw-scan-progress") as HTMLElement | null;
  const statusText = document.getElementById("nsfw-scan-status");

  if (scanBtn && progressWrap && progressBar && statusText) {
    const setScanState = (
      running: boolean,
      processed: number,
      total: number,
      updated: number,
      status: string,
    ) => {
      scanBtn.disabled = running;
      progressWrap.style.display = running ? "flex" : "none";
      const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
      progressBar.style.width = `${percent}%`;
      statusText.textContent = running
        ? `Scanning library: ${processed}/${total} images (${updated} updated)…`
        : `Last scan: ${processed} images, ${updated} updated. ${status}`;
    };

    scanBtn.addEventListener("click", async () => {
      scanBtn.disabled = true;
      try {
        const res = await triggerSafetyRescan();
        if (!res.started) {
          statusText.textContent = res.message || "A safety scan is already running.";
          return;
        }
        const poll = window.setInterval(async () => {
          try {
            const prog = await getSafetyRescanProgress();
            setScanState(
              prog.running,
              Number(prog.processed),
              Number(prog.total),
              Number(prog.updated),
              prog.status || "",
            );
            if (!prog.running) {
              window.clearInterval(poll);
              scanBtn.disabled = false;
              if (refreshAllPendingNsfw) refreshAllPendingNsfw();
            }
          } catch {
            window.clearInterval(poll);
            scanBtn.disabled = false;
          }
        }, 500);
      } catch (err: any) {
        statusText.textContent = "Failed to start safety scan: " + (err?.message || err);
        scanBtn.disabled = false;
      }
    });
  }

  updateNsfwHint(prefs.action);
}

function updateNsfwHint(action: NsfwAction) {
  const hint = document.getElementById("nsfw-action-hint");
  if (!hint) return;
  const meta = NSFW_ACTIONS.find((a) => a.value === action);
  hint.textContent = meta ? meta.hint : "";
}

function refreshAllPendingNsfw() {
  refreshAllNsfw();
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderSettingsHtml(): SafeHtml {
  return html`
    <!-- Display settings -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">Display</div>
      <p style="font-size: 11px; color: #333333;">Configure dashboard display preferences.</p>
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px;">
        <label style="font-weight: 600; min-width: 120px;">Path Visibility:</label>
        <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
          <label
            style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
          >
            <input type="radio" name="path-vis" value="full" /> Full path
          </label>
          <label
            style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
          >
            <input type="radio" name="path-vis" value="filename" checked /> Only filename
          </label>
          <label
            style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
          >
            <input type="radio" name="path-vis" value="drive-filename" /> Drive + filename
          </label>
          <label
            style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
          >
            <input type="radio" name="path-vis" value="drive-folders" /> Drive +
            <input
              type="number"
              id="settings-path-folders"
              class="input-field"
              min="0"
              max="10"
              value="1"
              style="width: 48px; padding: 2px 4px; font-size: 12px;"
            />
            folder(s) + filename
          </label>
        </div>
      </div>
      <div
        style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 3px;"
      >
        <i
          class="bi bi-file-earmark-image"
          style="color: var(--sys-border-focus); font-size: 13px;"
        ></i>
        <span
          id="settings-path-preview"
          style="font-size: 12px; font-family: 'Consolas', 'Courier New', monospace; color: #333333; user-select: text;"
        ></span>
      </div>
      <div
        class="form-group"
        style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;"
      >
        <label style="font-weight: 600; min-width: 120px;">Favorites Button Visibility:</label>
        <label
          style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
        >
          <input type="checkbox" id="settings-favorite-always-show" checked /> Always show star on
          favorited images
        </label>
      </div>
      <div
        class="form-group"
        style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;"
      >
        <label style="font-weight: 600; min-width: 120px;">Copied Tags:</label>
        <label
          style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
        >
          <input type="checkbox" id="settings-tag-copy-replace-underscores" /> Replace underscores
          with spaces in copied tags
        </label>
      </div>
      <div
        class="form-group"
        style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;"
      >
        <label style="font-weight: 600; min-width: 120px;">Zen Mode Images:</label>
        <label
          style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;"
          title="Disabling full resolution image load in Zen mode guarantees maximum smooth, 60fps scrolling performance"
        >
          <input type="checkbox" id="settings-zen-mode-full-images" /> Load full resolution images
          in Zen Mode (uncheck for maximum 60fps scroll smoothness)
        </label>
      </div>
    </div>

    <!-- Content Safety & Privacy Filter -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">
        <i class="bi bi-shield-check"></i> Content Safety &amp; Privacy Filter
      </div>
      <p style="font-size: 11px; color: #333333; margin: 0;">
        Decide how NSFW-rated images appear in the gallery, search results, and favorites.
        Thresholding happens locally in the browser; no re-inference needed.
      </p>
      <div class="form-group" style="flex-direction: column; align-items: flex-start; gap: 6px;">
        <label style="font-weight: 600; min-width: 120px;">Display Mode:</label>
        <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px;">
          ${NSFW_ACTIONS.map(
            (a) => `
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
              <input type="radio" name="nsfw-action" value="${a.value}">
              <i class="bi ${a.icon}" style="color: var(--sys-text-subtle);"></i> ${a.label}
            </label>
          `,
          ).join("")}
          <span
            id="nsfw-action-hint"
            style="font-size: 11px; color: #666666; margin-left: 22px;"
          ></span>
        </div>
      </div>
      <div
        class="form-group"
        style="flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px;"
      >
        <label
          style="font-weight: 600; min-width: 120px; display: flex; justify-content: space-between; width: 100%; align-items: center;"
        >
          <span>Sensitivity Threshold:</span>
          <span style="display: flex; gap: 8px; align-items: center;">
            <button
              class="win-button"
              id="nsfw-threshold-reset"
              style="font-size: 10px; padding: 2px 6px; font-weight: normal; line-height: 1;"
            >
              Reset to Default
            </button>
            <span
              id="nsfw-threshold-value"
              style="color: var(--sys-accent, #0078d7); font-weight: 700;"
            ></span>
          </span>
        </label>
        <input
          type="range"
          id="nsfw-threshold"
          min="0.10"
          max="0.99"
          step="0.01"
          value="0.91"
          style="width: 100%;"
        />
        <span style="font-size: 11px; color: #666666;"
          >Lower = block more aggressively; values apply to all already-scanned images instantly, no
          re-inference.</span
        >
      </div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Library Scan</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Analyze all existing images and store their per-class safety probabilities. Newly imported
          images are classified automatically.
        </p>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="win-button" id="nsfw-scan-btn">
            <i class="bi bi-search"></i> Scan Existing Library for Safety Ratings
          </button>
          <div
            class="progress-bar"
            id="nsfw-scan-progress-wrap"
            style="flex: 1; max-width: 240px; display: none;"
          >
            <div class="progress-fill" id="nsfw-scan-progress" style="width: 0%;"></div>
          </div>
        </div>
        <span
          id="nsfw-scan-status"
          style="font-size: 11px; min-height: 16px; display: block; margin-top: 4px;"
        ></span>
      </div>
    </div>

    <!-- Image Viewer settings -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">Image Viewer</div>
      <p style="font-size: 11px; color: #333333;">
        Configure how images open in the viewer and how OCR result text labels are drawn on
        detection boxes.
      </p>
      <div class="form-group">
        <label style="font-weight: 600; min-width: 120px;">Click Action:</label>
        <select class="input-field" id="settings-image-click-action" style="width: 220px;">
          <option value="in-app">Open in App (Image Viewer)</option>
          <option value="external">Open with Default Application</option>
        </select>
      </div>
      <div
        style="border: 1px solid var(--sys-border-dark); border-radius: 3px; background-color: var(--sys-window-bg); padding: 10px 12px; display: flex; flex-direction: column; gap: 10px;"
      >
        <label
          style="font-weight: 600; display: flex; align-items: center; gap: 6px; color: #333333;"
          ><i class="bi bi-fonts" style="color: var(--sys-border-focus);"></i> OCR Text
          Rendering</label
        >
        <div class="ocr-render-grid">
          <div style="display: flex; flex-direction: column; gap: 10px; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Font:</label>
              <select
                class="input-field"
                id="settings-ocr-font-family"
                style="flex: 1; min-width: 0;"
              >
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
              <select
                class="input-field"
                id="settings-ocr-font-size"
                style="flex: 1; min-width: 0;"
              >
                <option value="10">Small (10px)</option>
                <option value="12" selected>Normal (12px)</option>
                <option value="14">Large (14px)</option>
                <option value="16">Extra Large (16px)</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;"
                >Text Outline:</label
              >
              <select
                class="input-field"
                id="settings-ocr-stroke-width"
                style="flex: 1; min-width: 0;"
              >
                <option value="0">None</option>
                <option value="2">Thin (2px)</option>
                <option value="3">Medium (3px)</option>
                <option value="5" selected>Thick (5px)</option>
              </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;">Fit to Box:</label>
              <label
                style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; flex: 1; min-width: 0;"
              >
                <input type="checkbox" id="settings-ocr-fit-in-box" />
                Fit text inside its detection box
              </label>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <label style="font-weight: 600; white-space: nowrap; width: 88px;"
                >Vertical Text:</label
              >
              <label
                style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; flex: 1; min-width: 0;"
              >
                <input type="checkbox" id="settings-ocr-vertical-text" />
                Stack text vertically in vertical boxes
              </label>
            </div>
          </div>
          <div style="min-width: 0;">
            <label style="font-weight: 600; display: block; margin-bottom: 4px;">Preview:</label>
            <div
              id="settings-ocr-preview"
              style="border: 1px solid #cccccc; border-radius: 4px; overflow: hidden; max-width: 600px; width: 100%;"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Model Device Settings -->
    <div class="group-box" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="group-box-title">Model Device Settings</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 4px;">
        Choose whether each model runs on CPU or GPU, and how long to keep models in memory after
        last use.
      </p>

      <div class="device-grid">
        <!-- Embedding Model -->
        <div class="device-card span-full">
          <div class="device-card-title"><i class="bi bi-layers"></i> Active Embedding Model</div>
          <p class="device-card-desc">
            Select the model used for vector embeddings. Changing the model will automatically clear
            the current vector index and reindex all images in the database.
          </p>
          <div class="device-card-row">
            <label>Model:</label>
            <select class="input-field" id="settings-embedding-model" style="width: 220px;">
              <option value="clip-vit-b-32">CLIP ViT-B/32 (Standard)</option>
              <option value="mobileclip-s2">MobileCLIP-S2 (Fast + Accurate)</option>
            </select>
            <button
              class="win-button"
              id="reindex-vectors-btn"
              style="padding: 2px 8px; font-size: 11px;"
            >
              <i class="bi bi-arrow-repeat"></i> Reindex Everything
            </button>
            <button
              class="win-button"
              id="reindex-failed-btn"
              style="padding: 2px 8px; font-size: 11px;"
            >
              <i class="bi bi-arrow-repeat"></i> Retry Failed
            </button>
          </div>
          <!-- Reindexing Progress -->
          <div
            id="reindex-progress-container"
            style="display: none; margin-top: 4px; border-top: 1px solid #eee; padding-top: 10px;"
          >
            <div style="margin-bottom: 8px;">
              <div
                style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;"
              >
                <span id="reindex-preprocess-text">Preprocessing progress: 0/0 (0%)</span>
                <span style="font-weight: 600; color: #3b82f6;">CPU Preprocessing</span>
              </div>
              <div class="progress-bar">
                <div id="reindex-preprocess-bar" class="progress-fill" style="width: 0%;"></div>
              </div>
            </div>
            <div>
              <div
                style="display: flex; justify-content: space-between; font-size: 11px; color: #333; margin-bottom: 4px;"
              >
                <span id="reindex-index-text">Indexing progress: 0/0 (0%)</span>
                <span id="reindex-progress-status" style="font-weight: 600; color: #b78103;"
                  >Inference &amp; Indexing</span
                >
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
          <p class="device-card-desc">
            Powers image embedding generation and text-to-image semantic search.
          </p>
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
          <p class="device-card-desc">
            Choose which auto-tagger model is active and displayed across the app.
          </p>
          <div class="device-card-row">
            <label>Tagger:</label>
            <select class="input-field" id="settings-preferred-tagger" style="width: 150px;">
              <option value="camie">Camie Tagger v2 (Default)</option>
              <option value="wd-eva02">WD EVA02 Tagger (Canary)</option>
            </select>
            <button
              class="win-button"
              id="save-preferred-tagger-btn"
              style="padding: 2px 8px; font-size: 11px;"
            >
              <i class="bi bi-save"></i> Save
            </button>
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
            <button
              class="win-button"
              id="save-tagger-device-btn"
              style="padding: 2px 8px; font-size: 11px;"
            >
              <i class="bi bi-save"></i> Save
            </button>
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
            <button
              class="win-button"
              id="save-tagger-wd-device-btn"
              style="padding: 2px 8px; font-size: 11px;"
            >
              <i class="bi bi-save"></i> Save
            </button>
          </div>
        </div>

        <!-- Detection Devices -->
        <div class="device-card">
          <div class="device-card-title">
            <i class="bi bi-bounding-box"></i> Character Detection
          </div>
          <p class="device-card-desc">
            YOLO detects character bounding boxes; CCIP extracts identity embeddings. The metrics
            model is tiny (16x768) and should stay on CPU.
          </p>
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
            <select
              class="input-field"
              id="settings-detection-metrics-device"
              style="width: 150px;"
            >
              <option value="auto">Auto (GPU if available)</option>
              <option value="cpu" selected>CPU Only</option>
              <option value="gpu">GPU Only</option>
            </select>
          </div>
        </div>

        <!-- OCR Device -->
        <div class="device-card">
          <div class="device-card-title"><i class="bi bi-fonts"></i> OCR Text Recognition</div>
          <p class="device-card-desc">
            Powers Optical Character Recognition and text box detection (PP-OCRv6 medium).
          </p>
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
          <p class="device-card-desc">
            Automatically unload models from memory after a period of inactivity to free GPU/RAM.
          </p>
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
      <div
        style="background-color: #e8f5e9; border: 1px solid #a5d6a7; padding: 8px; border-radius: 2px; color: #2e7d32; font-size: 11px;"
      >
        <strong>Note:</strong> Device changes take effect immediately. Models are automatically
        unloaded after the idle timeout, then reloaded on the next inference call.
      </div>
    </div>

    <!-- Thumbnail Settings -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">Thumbnail Settings</div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Thumbnail Cache</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Purge cached thumbnails for images that are no longer present on disk, or clear the entire
          thumbnail cache to force regeneration on demand.
        </p>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="win-button" id="clear-thumbnail-cache-btn">
            <i class="bi bi-trash"></i> Clear Thumbnail Cache
          </button>
          <span id="clear-thumbnail-status-msg" style="font-size: 11px;"></span>
          <button class="win-button danger" id="purge-missing-thumbs-btn">
            <i class="bi bi-trash"></i> Purge Missing Thumbnails
          </button>
          <span id="purge-status-msg" style="font-size: 11px;"></span>
        </div>
      </div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;">Crop Thumbnails</label>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Clear the cached bounding box crops. This forces the system to regenerate crop thumbnails
          from original files on demand.
        </p>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="win-button" id="clear-crop-cache-btn">
            <i class="bi bi-trash"></i> Clear Crop Cache
          </button>
          <span id="clear-crop-cache-status-msg" style="font-size: 11px; min-height: 16px;"></span>
        </div>
      </div>
    </div>

    <!-- Folder Management -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">Folder Management</div>
      <p style="font-size: 11px; color: #333333;">
        Assign existing images to their parent folders. This is useful if you have images imported
        before folder tracking was enabled.
      </p>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="backfill-folders-btn">
          <i class="bi bi-folder-fill"></i> Backfill Image Folders
        </button>
        <span id="backfill-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
    </div>

    <!-- Media Metadata -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title">Media Metadata</div>
      <p style="font-size: 11px; color: #333333;">
        Populate dimensions and GIF animation details (frame count, duration) for images imported
        before media metadata tracking existed.
      </p>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="win-button" id="backfill-media-metadata-btn">
          <i class="bi bi-film"></i> Backfill Media Metadata
        </button>
        <span
          id="backfill-media-metadata-status-msg"
          style="font-size: 11px; min-height: 16px;"
        ></span>
      </div>
    </div>

    <!-- FFmpeg -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title"><i class="bi bi-collection-play"></i> FFmpeg</div>
      <p style="font-size: 11px; color: #333333; margin: 0;">
        FFmpeg is required for video import, frame extraction, animated previews, and transcoding.
        Curator resolves it from your configured path, the local <code>bin</code> folder, or your
        system PATH.
      </p>
      <div
        id="ffmpeg-status-row"
        style="display: flex; align-items: center; gap: 8px; font-size: 11px;"
      ></div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;"
          >Executable Path (optional)</label
        >
        <div style="display: flex; gap: 8px; align-items: center;">
          <input
            type="text"
            id="settings-ffmpeg-path"
            style="flex: 1; padding: 4px 8px; font-size: 11px; border: 1px solid #b0b0b0; border-radius: 2px;"
            placeholder="Leave empty to auto-detect"
          />
          <button class="win-button" id="browse-ffmpeg-btn">
            <i class="bi bi-folder2-open"></i> Browse
          </button>
          <button class="win-button primary" id="save-ffmpeg-path-btn">
            <i class="bi bi-check-lg"></i> Save
          </button>
        </div>
        <span id="ffmpeg-save-status-msg" style="font-size: 11px; min-height: 16px;"></span>
      </div>
      <div style="border-top: 1px solid #e5e7eb; margin: 4px 0; padding-top: 8px;">
        <label style="font-weight: 600; display: block; margin-bottom: 4px;"
          >Portable Download</label
        >
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Downloads the portable Windows FFmpeg build into the data <code>bin</code> folder and
          verifies it by running <code>ffmpeg -version</code>.
        </p>
        <p style="font-size: 11px; color: #333333; margin: 0 0 8px;">
          Source:
          <a
            href="javascript:void(0)"
            id="ffmpeg-release-link"
            style="color: #004aad; text-decoration: none;"
            >gyan.dev FFmpeg release builds</a
          >
          <span style="color: #777777;">(ffmpeg-release-essentials.zip)</span>
        </p>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button class="win-button" id="download-ffmpeg-btn">
            <i class="bi bi-download"></i> Download FFmpeg
          </button>
          <div
            class="progress-bar"
            style="flex: 1; max-width: 240px; display: none;"
            id="ffmpeg-dl-progress"
          >
            <div class="progress-fill" id="ffmpeg-dl-progress-fill" style="width: 0%;"></div>
          </div>
          <span id="ffmpeg-dl-status-msg" style="font-size: 11px; min-height: 16px;"></span>
        </div>
      </div>
    </div>

    <!-- Storage Usage -->
    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;"
    >
      <div class="group-box-title"><i class="bi bi-pie-chart"></i> Storage Usage</div>
      <p style="font-size: 11px; color: #333333; margin: 0 0 4px;">
        Analyze disk space occupied by different media types in your library.
      </p>
      <div
        style="display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 8px; align-items: flex-start;"
      >
        <span style="font-size: 11px; font-weight: 600;" id="storage-total-display"
          >Total Storage: Calculating...</span
        >
        <div style="display: flex; gap: 4px;">
          <span
            class="note-tab active"
            id="storage-tab-bar"
            style="user-select:none; cursor:pointer;"
            >Stacked Bar</span
          >
          <span class="note-tab" id="storage-tab-pie" style="user-select:none; cursor:pointer;"
            >Pie Chart</span
          >
          <span class="note-tab" id="storage-tab-tree" style="user-select:none; cursor:pointer;"
            >Quadtree</span
          >
        </div>
      </div>
      <div
        id="storage-visual-container"
        style="min-height: 200px; display: flex; align-items: center; justify-content: flex-start; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px; position: relative; padding: 12px; box-sizing: border-box; width: 100%;"
      >
        <!-- Charts rendered here -->
      </div>
    </div>
  `;
}
