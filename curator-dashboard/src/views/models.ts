import { typedCall } from "../ipc";
import { ModelStatusInfo, DownloadProgress } from "../types";
import { SafeHtml, html } from "../components";
import { showErrorAlert, showInfoAlert } from "../alert";
import {
  ModelStatusResultSchema,
  DownloadProgressResultSchema,
  ModelIdRequestSchema,
  ModelActionResultSchema,
  QuantizeModelRequestSchema,
  ConversionLogsResultSchema,
  DownloadStatusUpdateSchema,
  ConversionStatusUpdateSchema,
} from "../gen/models_pb";
import { SettingsResultSchema, UpdateSettingsRequestSchema } from "../gen/system_pb";
import { ModelPrecision, ModelStatusInfo as PModelStatusInfo, DownloadProgress as PDownloadProgress } from "../gen/common_pb";

let pollInterval: number | null = null;
let activeConversionModelId: string | null = null;
let activeConversionPollInterval: any = null;

const actionsNormalizer = document.createElement("div");

interface ConversionConsoleState {
  modelId: string;
  logs: string;
  statusText: string;
  isRunning: boolean;
}

const activeConsoleLogs: Record<string, ConversionConsoleState> = {};
const dismissedConsoleLogs = new Set<string>();

export function clearCompletedModelsConsoleLogs() {
  for (const [modelId, state] of Object.entries(activeConsoleLogs)) {
    if (!state.isRunning) {
      delete activeConsoleLogs[modelId];
      dismissedConsoleLogs.add(modelId);
      const logContainer = document.getElementById(`conversion-log-container-${modelId}`);
      if (logContainer) {
        logContainer.style.display = "none";
      }
    }
  }
}

// Expose actions to window so that inline buttons/event handlers can access them
(window as any).downloadModel = downloadModel;
(window as any).cancelDownload = cancelDownload;
(window as any).removeModel = removeModel;
(window as any).quantizeModel = quantizeModel;
(window as any).convertModel = convertModel;

function modelStatusInfoFromProto(p: PModelStatusInfo): ModelStatusInfo {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    optional: p.optional,
    url: p.url,
    files: p.files.map((f) => ({ url: f.url, dest: f.dest, sha256: f.sha256 })),
    downloaded_files: p.downloadedFiles,
    total_size: Number(p.totalSize),
    downloaded_size: Number(p.downloadedSize),
    status: p.status as ModelStatusInfo["status"],
    quantized_variants: p.quantizedVariants,
    quantizable: p.quantizable,
    required_by: p.requiredBy,
  };
}

function downloadProgressFromProto(p: PDownloadProgress): DownloadProgress {
  return {
    model_id: p.modelId,
    status: p.status as DownloadProgress["status"],
    files_total: p.filesTotal,
    files_completed: p.filesCompleted,
    bytes_total: Number(p.bytesTotal),
    bytes_downloaded: Number(p.bytesDownloaded),
    bytes_per_second: Number(p.bytesPerSecond),
    elapsed_secs: p.elapsedSecs,
    error: p.error ?? null,
  };
}

function modelPrecisionsFromProto(map: { [key: string]: ModelPrecision } | undefined): Record<string, "original" | "fp16" | "int8"> {
  const out: Record<string, "original" | "fp16" | "int8"> = {};
  if (!map) return out;
  for (const [k, v] of Object.entries(map)) {
    if (v === ModelPrecision.INT8) out[k] = "int8";
    else if (v === ModelPrecision.FP16) out[k] = "fp16";
    else out[k] = "original";
  }
  return out;
}

export function renderModelsHtml(): SafeHtml {
  return html`
    <div class="group-box" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
      <div class="group-box-title">Model Management</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 8px;">Download and manage local AI model weights on disk.</p>
      <div id="settings-models"></div>
    </div>
  `;
}

export function setupModelsView() {
  refreshModelStatus();
}

export async function refreshModelStatus() {
  const container = document.getElementById("settings-models");
  if (!container) return;

  const scrollParent = container.closest(".tab-page") || container.closest("#view-settings") || container.parentElement || document.documentElement;
  const savedScrollTop = scrollParent ? scrollParent.scrollTop : 0;

  if (container.children.length === 0) {
    container.innerHTML = `<div style="padding: 8px; text-align: center;"><i class="bi bi-arrow-repeat spin"></i> Loading models status...</div>`;
  }

  try {
    const resp = await typedCall("ModelsService.GetModelStatus", null, null, ModelStatusResultSchema);

    let modelPrecisions: Record<string, "original" | "fp16" | "int8"> = {};
    try {
      const settingsResp = await typedCall("SystemService.GetSettings", null, null, SettingsResultSchema);
      modelPrecisions = modelPrecisionsFromProto(settingsResp.modelPrecisions);
    } catch (se) {}
    // Check conversion logs for models that support conversion to sync background completions
    const parsedModels = resp.models.map(modelStatusInfoFromProto);
    for (const m of parsedModels) {
      if (m.files.some((f) => f.dest.endsWith(".safetensors"))) {
        try {
          const logResp = await typedCall("ModelsService.GetConversionLogs", ModelIdRequestSchema, { modelId: m.id }, ConversionLogsResultSchema);
          if (logResp.logs && logResp.logs.trim().length > 0) {
            const isSuccess = logResp.logs.includes("successfully") || logResp.logs.includes("conversion complete");
            const statusText = logResp.isRunning ? "Converting..." : (isSuccess ? "Completed" : "Failed");

            // Only track if not dismissed, OR if currently running
            if (logResp.isRunning || (!dismissedConsoleLogs.has(m.id) && (activeConsoleLogs[m.id] || isSuccess))) {
              activeConsoleLogs[m.id] = {
                modelId: m.id,
                logs: logResp.logs,
                statusText,
                isRunning: logResp.isRunning,
              };
              if (logResp.isRunning) {
                dismissedConsoleLogs.delete(m.id);
                resumeConversionPolling(m.id);
              }
            }
          }
        } catch (_) {}
      }
    }

    renderModelsList(parsedModels, modelPrecisions);

    // Restoring scrollTop scrolls the tab page, which closes any open native
    // <select> popup in the models panel. Defer the restore until no select
    // inside the panel is focused (i.e. no dropdown is open).
    if (scrollParent && !isModelsSelectPopupOpen()) {
      scrollParent.scrollTop = savedScrollTop;
    }

    const progResp = await typedCall("ModelsService.GetDownloadProgress", null, null, DownloadProgressResultSchema);
    if (progResp.downloads.length > 0) {
      startModelDownloadPolling();
    }
  } catch (e: any) {
    container.innerHTML = `<div style="color: #a80000; padding: 8px;">Error: ${e.message || e}</div>`;
  }
}

/// True when `document.activeElement` is inside the models panel and is a
/// `<select>` — i.e. a native variant dropdown is open (or the select is
/// focused). Used to avoid re-render/scroll work that would close the popup.
function isModelsSelectPopupOpen(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return (
    !!ae &&
    ae.tagName === "SELECT" &&
    !!ae.closest("#settings-models")
  );
}

/// True when `el` (or a descendant) currently holds focus.
function isElementFocused(el: Element | null): boolean {
  if (!el) return false;
  const ae = document.activeElement as HTMLElement | null;
  return !!ae && el.contains(ae);
}

function getStatusIconHtml(m: ModelStatusInfo): string {
  return m.status === "downloaded"
    ? '<span style="color: #2e7d32; font-weight: bold;"><i class="bi bi-check-circle-fill"></i> Installed</span>'
    : m.status === "partial"
      ? '<span style="color: #b78103; font-weight: bold;"><i class="bi bi-exclamation-circle-fill"></i> Partial</span>'
      : '<span style="color: #666666;"><i class="bi bi-circle"></i> Not Installed</span>';
}

function getFileStatusText(m: ModelStatusInfo): string {
  const filesCount = m.files.length;
  const downloadedFilesCount = m.downloaded_files.length;
  const sizeStr = m.total_size > 0
    ? ` (${formatBytes(m.downloaded_size)} / ${formatBytes(m.total_size)})`
    : m.downloaded_size > 0
      ? ` (${formatBytes(m.downloaded_size)})`
      : "";
  return `${downloadedFilesCount}/${filesCount} files ready${sizeStr}`;
}

function renderModelActionsHtml(m: ModelStatusInfo, modelPrecisions: Record<string, "original" | "fp16" | "int8">): string {
  let actionsHtml = "";
  if (m.status !== "downloaded") {
    actionsHtml += `<button class="win-button primary" onclick="downloadModel('${m.id}')"><i class="bi bi-download"></i> Download</button>`;
  } else {
    actionsHtml += `<button class="win-button danger" onclick="removeModel('${m.id}')"><i class="bi bi-trash"></i> Delete</button>`;
  }

  const needsConversion = m.files.some(f => f.dest.endsWith(".safetensors"));
  if (m.status === "downloaded" && needsConversion) {
    const isConverted = m.quantized_variants.includes("onnx");
    if (isConverted) {
      actionsHtml += `<span style="margin-left: 12px; color: #2e7d32; padding: 2px 4px; border: 1px solid #a5d6a7; background: #e8f5e9; border-radius: 2px; font-size: 11px;"><i class="bi bi-check"></i> ONNX Converted</span>`;
    } else {
      actionsHtml += `<button class="win-button" style="margin-left: 12px; font-weight: bold; background-color: #2b5797; color: white;" id="convert-btn-${m.id}" onclick="convertModel('${m.id}')"><i class="bi bi-gear-fill"></i> Convert to ONNX</button>`;
    }
  }

  if (m.status === "downloaded" && m.quantizable && m.quantizable.length > 0) {
    actionsHtml += `<span style="margin-left: 12px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px;">`;
    actionsHtml += `Quantize:`;
    for (const fmt of m.quantizable) {
      const isDone = m.quantized_variants.includes(fmt);
      if (isDone) {
        actionsHtml += `<span style="color: #2e7d32; padding: 2px 4px; border: 1px solid #a5d6a7; background: #e8f5e9; border-radius: 2px;">${fmt.toUpperCase()} (Done)</span>`;
      } else {
        actionsHtml += `<button class="win-button" style="padding: 2px 6px; height: 18px; font-size: 10px;" onclick="quantizeModel('${m.id}', '${fmt}')">${fmt.toUpperCase()}</button>`;
      }
    }
    actionsHtml += `</span>`;
  }

  if (m.status === "downloaded" && m.quantizable && m.quantizable.length > 0) {
    const currentPrec = modelPrecisions[m.id] || "original";
    actionsHtml += `<span style="margin-left: 12px; display: inline-flex; align-items: center; gap: 4px; font-size: 11px;">`;
    actionsHtml += `Active Variant:`;
    actionsHtml += `<select class="input-field" style="padding: 1px 4px; height: 20px; font-size: 11px; width: 100px;" onchange="updateModelPrecision('${m.id}', this.value)">`;
    actionsHtml += `<option value="original" ${currentPrec === "original" ? "selected" : ""}>Original</option>`;
    for (const fmt of m.quantizable) {
      const isDone = m.quantized_variants.includes(fmt);
      actionsHtml += `<option value="${fmt}" ${currentPrec === fmt ? "selected" : ""} ${!isDone ? "disabled" : ""}>${fmt.toUpperCase()}</option>`;
    }
    actionsHtml += `</select>`;
    actionsHtml += `</span>`;
  }

  return actionsHtml;
}

function renderModelsList(models: ModelStatusInfo[], modelPrecisions: Record<string, "original" | "fp16" | "int8">) {
  const container = document.getElementById("settings-models");
  if (!container) return;

  if (models.length === 0) {
    container.innerHTML = `<div style="padding: 8px; color: #666;">No models defined in manifest.</div>`;
    return;
  }

  // If model cards already exist in the DOM, perform targeted in-place element updates without replacing card DOM nodes
  const existingCards = container.querySelectorAll("[id^='model-card-']");
  if (existingCards.length > 0 && container.children.length > 0) {
    for (const m of models) {
      const card = document.getElementById(`model-card-${m.id}`);
      if (!card) continue;

      const actionsEl = document.getElementById(`model-actions-${m.id}`);
      const fileStatusEl = document.getElementById(`file-status-${m.id}`);
      const statusIconEl = document.getElementById(`status-icon-${m.id}`);
      const logContainerEl = document.getElementById(`conversion-log-container-${m.id}`);

      if (fileStatusEl) fileStatusEl.textContent = getFileStatusText(m);
      if (statusIconEl) statusIconEl.innerHTML = getStatusIconHtml(m);
      // Defer replacing the actions row while any of its own <select> elements
      // is focused (an open native dropdown): destroying a focused select node
      // closes the popup and swallows the pending click. The state change is
      // applied by the next refresh once focus leaves the element.
      if (actionsEl && !isElementFocused(actionsEl)) {
        const newActionsHtml = renderModelActionsHtml(m, modelPrecisions);
        actionsNormalizer.innerHTML = newActionsHtml;
        if (actionsEl.innerHTML !== actionsNormalizer.innerHTML) {
          actionsEl.innerHTML = newActionsHtml;
        }
      }

      const consoleState = activeConsoleLogs[m.id];
      if (logContainerEl) {
        logContainerEl.style.display = consoleState ? "block" : "none";
      }
    }
    return;
  }

  // Group by category
  const categories: { [key: string]: ModelStatusInfo[] } = {};
  for (const m of models) {
    if (!categories[m.category]) {
      categories[m.category] = [];
    }
    categories[m.category].push(m);
  }

  const categoryLabels: { [key: string]: string } = {
    embedding: "Embedding Models (Semantic Search)",
    tagging: "Auto-Tagging Models",
    detection: "Character Detection & CCIP",
    ocr: "Optical Character Recognition (OCR) & Bubble Detection"
  };

  let htmlResult = `<div style="display: flex; flex-direction: column; gap: 16px;">`;

  for (const cat of Object.keys(categories)) {
    const label = categoryLabels[cat] || cat;
    htmlResult += `
      <div class="group-box" style="padding: 12px;">
        <div class="group-box-title">${label}</div>
        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 4px;">
    `;

    for (const m of categories[cat]) {
      const statusIcon = getStatusIconHtml(m);
      const fileStatusText = getFileStatusText(m);
      const actionsHtml = renderModelActionsHtml(m, modelPrecisions);

      const reqLabel = m.required_by.length > 0
        ? `<div style="font-size: 10px; color: #666; margin-top: 2px;">Required by: ${m.required_by.join(", ")}</div>`
        : "";

      const optLabel = m.optional
        ? `<span style="font-size: 9px; padding: 1px 4px; border: 1px solid #b8daff; background: #cce5ff; color: #004085; margin-left: 6px; font-weight: normal; vertical-align: middle;">Optional</span>`
        : "";

      const consoleState = activeConsoleLogs[m.id];
      const isConsoleVisible = !!consoleState;
      const logContent = consoleState ? consoleState.logs : "";
      const logStatusText = consoleState ? consoleState.statusText : "Converting...";

      htmlResult += `
        <div id="model-card-${m.id}" style="padding-bottom: 12px; border-bottom: 1px solid #e0e0e0; display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <strong style="font-size: 13px;">${m.name}</strong> ${optLabel}
              <div style="font-size: 11px; color: #555; margin-top: 2px;">${m.description}</div>
              ${m.url ? `<div style="font-size: 10px; margin-top: 2px;"><a href="${m.url}" target="_blank" rel="noopener" style="color: #2b5797; text-decoration: none;">${m.url} <i class="bi bi-box-arrow-up-right" style="font-size: 9px;"></i></a></div>` : ""}
              <div id="file-status-${m.id}" style="font-size: 11px; color: #777; margin-top: 2px;">${fileStatusText}</div>
              ${reqLabel}
            </div>
            <div style="text-align: right; font-size: 11px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
              <div>Status: <span id="status-icon-${m.id}">${statusIcon}</span></div>
              <div style="display: flex; gap: 6px;" id="model-actions-${m.id}">
                ${actionsHtml}
              </div>
            </div>
          </div>
          <div id="progress-${m.id}" class="model-progress" style="display: none;"></div>
          <div id="conversion-log-container-${m.id}" style="display: ${isConsoleVisible ? 'block' : 'none'}; margin-top: 8px; border: 1px solid var(--sys-border-dark, #b0b0b0); background: #1e1e1e; color: #d4d4d4; font-family: 'Consolas', monospace; font-size: 11px; padding: 6px; border-radius: 2px; box-sizing: border-box;">
            <div style="font-weight: bold; border-bottom: 1px solid #444; padding-bottom: 4px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; color: #858585;">
              <span>CONVERSION CONSOLE LOGS</span>
              <span id="conversion-status-${m.id}">${logStatusText}</span>
            </div>
            <pre id="conversion-log-text-${m.id}" style="margin: 0; max-height: 150px; overflow-y: auto; white-space: pre-wrap; font-family: inherit; line-height: 1.4; color: #a9b7c6; text-align: left;">${logContent}</pre>
          </div>
        </div>
      `;
    }

    htmlResult = htmlResult.trim().replace(/border-bottom: 1px solid #e0e0e0; display: flex; flex-direction: column; gap: 4px;\s*<\/div>\s*$/, "display: flex; flex-direction: column; gap: 4px;\n</div>");

    htmlResult += `
        </div>
      </div>
    `;
  }

  htmlResult += `</div>`;
  container.innerHTML = htmlResult;

  if (activeConversionModelId) {
    resumeConversionPolling(activeConversionModelId);
  }
}

export function startModelDownloadPolling() {
  if (pollInterval) return;

  const check = async () => {
    try {
      const result = await typedCall("ModelsService.GetDownloadProgress", null, null, DownloadProgressResultSchema);
      updateProgressBars(result.downloads.map(downloadProgressFromProto));
      if (result.downloads.length === 0) {
        stopModelDownloadPolling();
        refreshModelStatus();
      }
    } catch (_) {}
  };

  check();
  pollInterval = window.setInterval(check, 1000);
}

export function stopModelDownloadPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function updateProgressBars(downloads: DownloadProgress[]) {
  const activeIds = new Set(downloads.map((d) => d.model_id));

  // Hide progress bar and restore actions for any model not in the active downloads list
  const allProgressEls = document.querySelectorAll("[id^='progress-']");
  allProgressEls.forEach((el) => {
    const modelId = el.id.replace("progress-", "");
    if (!activeIds.has(modelId)) {
      (el as HTMLElement).style.display = "none";
      const actionsEl = document.getElementById(`model-actions-${modelId}`);
      if (actionsEl) actionsEl.style.display = "flex";
    }
  });

  for (const dl of downloads) {
    const el = document.getElementById(`progress-${dl.model_id}`);
    const actionsEl = document.getElementById(`model-actions-${dl.model_id}`);
    if (!el) continue;

    if (dl.status === "failed") {
      el.style.display = "flex";
      if (actionsEl) actionsEl.style.display = "flex";
      el.innerHTML = `
        <div style="color: #d32f2f; font-size: 11px; font-weight: bold; display: flex; align-items: center; gap: 6px;">
          <i class="bi bi-exclamation-triangle-fill"></i> Download Failed: ${dl.error || "Unknown download error"}
        </div>
      `;
      continue;
    }

    if (dl.status === "completed") {
      el.style.display = "none";
      if (actionsEl) actionsEl.style.display = "flex";
      continue;
    }

    el.style.display = "flex";

    if (actionsEl) {
      actionsEl.style.display = "none";
    }

    const pct = dl.bytes_total > 0
      ? Math.round((dl.bytes_downloaded / dl.bytes_total) * 100)
      : 0;

    const speed = formatBytes(dl.bytes_per_second) + "/s";
    const eta = dl.bytes_per_second > 0
      ? Math.ceil((dl.bytes_total - dl.bytes_downloaded) / dl.bytes_per_second)
      : null;

    const statusText = dl.status === "quantizing" ? "Quantizing..." : `Downloading (${dl.files_completed}/${dl.files_total} files)`;

    el.innerHTML = `
      <div style="font-size: 11px; font-weight: bold; min-width: 140px; white-space: nowrap;">${statusText}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
      <span class="progress-text">${pct}%</span>
      <span class="progress-speed">${speed}</span>
      ${eta !== null ? `<span class="progress-eta">ETA ${eta}s</span>` : ""}
      <button class="win-button" style="padding: 2px 8px; height: 20px; font-size: 10px;" onclick="cancelDownload('${dl.model_id}')"><i class="bi bi-x-lg"></i> Cancel</button>
    `;
  }
}

async function downloadModel(modelId: string) {
  try {
    const resp = await typedCall("ModelsService.DownloadModel", ModelIdRequestSchema, { modelId }, DownloadStatusUpdateSchema);
    const prog = resp.progress;
    if (prog && prog.status === "downloading" && !resp.complete) {
      startModelDownloadPolling();
      const el = document.getElementById(`progress-${modelId}`);
      if (el) {
        el.style.display = "flex";
        el.innerHTML = `<div style="font-size: 11px; font-weight: bold;"><i class="bi bi-arrow-repeat spin"></i> Starting download...</div>`;
      }
    } else if (prog && (prog.status === "completed" || resp.complete)) {
      refreshModelStatus();
    } else {
      showErrorAlert("Failed to start download:\n" + (prog?.error || "Model download did not start."));
    }
  } catch (e: any) {
    showErrorAlert("Error:\n" + (e.message || e));
  }
}

async function cancelDownload(modelId: string) {
  try {
    const resp = await typedCall("ModelsService.CancelDownload", ModelIdRequestSchema, { modelId }, ModelActionResultSchema);
    if (resp.success) {
      refreshModelStatus();
    } else {
      showErrorAlert("Failed to cancel download:\n" + resp.message);
    }
  } catch (e: any) {
    showErrorAlert("Error:\n" + (e.message || e));
  }
}

async function removeModel(modelId: string) {
  if (!confirm(`Are you sure you want to delete all files for model '${modelId}'?`)) {
    return;
  }

  try {
    const resp = await typedCall("ModelsService.RemoveModel", ModelIdRequestSchema, { modelId }, ModelActionResultSchema);
    showInfoAlert(resp.message);
    refreshModelStatus();
  } catch (e: any) {
    showErrorAlert("Error:\n" + (e.message || e));
  }
}

function resumeConversionPolling(modelId: string) {
  if (activeConversionPollInterval) {
    clearInterval(activeConversionPollInterval);
    activeConversionPollInterval = null;
  }

  // Pre-configure the current button and log container status if they exist
  const initialBtn = document.getElementById(`convert-btn-${modelId}`) as HTMLButtonElement;
  if (initialBtn) {
    initialBtn.disabled = true;
    initialBtn.innerHTML = `<i class="bi bi-arrow-repeat spin"></i> Converting...`;
  }
  const initialLogContainer = document.getElementById(`conversion-log-container-${modelId}`);
  if (initialLogContainer) {
    initialLogContainer.style.display = "block";
    const initialLogStatus = document.getElementById(`conversion-status-${modelId}`);
    if (initialLogStatus) {
      initialLogStatus.textContent = "Converting...";
    }
  }

  activeConversionPollInterval = setInterval(async () => {
    // Check if the models view is currently active in the DOM.
    // If not, pause polling to avoid polluting backend logs.
    const modelsContainer = document.getElementById("settings-models");
    if (!modelsContainer) {
      clearInterval(activeConversionPollInterval);
      activeConversionPollInterval = null;
      return;
    }

    // Resolve elements dynamically inside the tick to handle tab switches
    const btn = document.getElementById(`convert-btn-${modelId}`) as HTMLButtonElement;
    const logContainer = document.getElementById(`conversion-log-container-${modelId}`);
    const logText = document.getElementById(`conversion-log-text-${modelId}`);
    const logStatus = document.getElementById(`conversion-status-${modelId}`);

    try {
      const logResp = await typedCall("ModelsService.GetConversionLogs", ModelIdRequestSchema, { modelId }, ConversionLogsResultSchema);
      const { logs, isRunning } = logResp;

      const isSuccess = logs.includes("successfully") || logs.includes("conversion complete");
      const statusText = isRunning ? "Converting..." : (isSuccess ? "Completed" : "Failed");

      activeConsoleLogs[modelId] = {
        modelId,
        logs,
        statusText,
        isRunning,
      };

      if (logText) {
        logText.textContent = logs;
        logText.scrollTop = logText.scrollHeight;
      }
      if (logContainer) {
        logContainer.style.display = "block";
      }
      if (logStatus) {
        logStatus.textContent = statusText;
      }
      if (btn && isRunning) {
        btn.disabled = true;
        btn.innerHTML = `<i class="bi bi-arrow-repeat spin"></i> Converting...`;
      }

      if (!isRunning) {
        clearInterval(activeConversionPollInterval);
        activeConversionPollInterval = null;
        activeConversionModelId = null;
        if (btn) {
          btn.disabled = false;
          if (isSuccess) {
            btn.style.display = "none";
          } else {
            btn.innerHTML = `<i class="bi bi-gear-fill"></i> Convert to ONNX`;
          }
        }
        if (isSuccess) {
          refreshModelStatus();
        }
      }
    } catch (err: any) {
      clearInterval(activeConversionPollInterval);
      activeConversionPollInterval = null;
      if (logStatus) logStatus.textContent = "Failed";
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-gear-fill"></i> Convert to ONNX`;
      }
    }
  }, 500);
}

async function convertModel(modelId: string) {
  dismissedConsoleLogs.delete(modelId);
  const btn = document.getElementById(`convert-btn-${modelId}`) as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="bi bi-arrow-repeat spin"></i> Converting...`;
  }

  const logContainer = document.getElementById(`conversion-log-container-${modelId}`);
  const logText = document.getElementById(`conversion-log-text-${modelId}`);
  const logStatus = document.getElementById(`conversion-status-${modelId}`);

  if (logContainer) logContainer.style.display = "block";
  if (logText) logText.textContent = "Starting conversion process...\n";
  if (logStatus) logStatus.textContent = "Converting...";

  try {
    const firstUpdate = await typedCall("ModelsService.ConvertModel", ModelIdRequestSchema, { modelId }, ConversionStatusUpdateSchema);
    if (firstUpdate && firstUpdate.complete) {
      if (logText) logText.textContent = firstUpdate.logs;
      const isSuccess = firstUpdate.logs.includes("successfully") || firstUpdate.logs.includes("conversion complete");
      if (logStatus) logStatus.textContent = isSuccess ? "Completed" : "Failed";
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-gear-fill"></i> Convert to ONNX`;
      }
      if (!isSuccess) {
        showErrorAlert("Conversion Failed:\n" + firstUpdate.logs);
      }
      return;
    }
    activeConversionModelId = modelId;
    resumeConversionPolling(modelId);
  } catch (e: any) {
    if (logStatus) logStatus.textContent = "Error";
    if (logText) logText.textContent += `\nError: ${e.message || e}`;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="bi bi-gear-fill"></i> Convert to ONNX`;
    }
    showErrorAlert("Error", e.message || e);
  }
}

async function quantizeModel(modelId: string, format: string) {
  const btn = event?.target as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="bi bi-arrow-repeat spin"></i> Quantizing...`;
  }

  try {
    const resp = await typedCall("ModelsService.QuantizeModel", QuantizeModelRequestSchema, { modelId, format }, ModelActionResultSchema);
    showInfoAlert(resp.message);
    refreshModelStatus();
  } catch (e: any) {
    showErrorAlert("Quantization failed:\n" + (e.message || e));
    refreshModelStatus();
  }
};

(window as any).updateModelPrecision = async (modelId: string, precision: string) => {
  try {
    const settingsResp = await typedCall("SystemService.GetSettings", null, null, SettingsResultSchema);

    const precs: { [key: string]: ModelPrecision } = { ...settingsResp.modelPrecisions };
    if (precision === "int8") precs[modelId] = ModelPrecision.INT8;
    else if (precision === "fp16") precs[modelId] = ModelPrecision.FP16;
    else precs[modelId] = ModelPrecision.ORIGINAL;

    await typedCall("SystemService.UpdateSettings", UpdateSettingsRequestSchema, {
      clipDevice: settingsResp.clipDevice,
      taggerDevice: settingsResp.taggerDevice,
      taggerWdDevice: settingsResp.taggerWdDevice,
      idleTimeoutSecs: settingsResp.idleTimeoutSecs,
      embeddingModel: settingsResp.embeddingModel,
      detectionDevice: settingsResp.detectionDevice,
      detectionMetricsDevice: settingsResp.detectionMetricsDevice,
      ocrDevice: settingsResp.ocrDevice,
      modelPrecisions: precs,
      preferredTagger: settingsResp.preferredTagger,
    }, SettingsResultSchema);

    refreshModelStatus();
  } catch (e: any) {
    showErrorAlert("Error:\n" + (e.message || e));
  }
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
