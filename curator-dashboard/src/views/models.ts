import { callService } from "../ipc";
import { ModelStatusInfo, DownloadProgress } from "../types";
import { SafeHtml, html } from "../components";
import { showErrorAlert, showInfoAlert } from "../alert";

let pollInterval: number | null = null;
let activeConversionModelId: string | null = null;
let activeConversionPollInterval: any = null;

// Expose actions to window so that inline buttons/event handlers can access them
(window as any).downloadModel = downloadModel;
(window as any).cancelDownload = cancelDownload;
(window as any).removeModel = removeModel;
(window as any).quantizeModel = quantizeModel;
(window as any).convertModel = convertModel;

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

  container.innerHTML = `<div style="padding: 8px; text-align: center;"><i class="bi bi-arrow-repeat spin"></i> Loading models status...</div>`;

  try {
    const resp = await callService({ GetModelStatus: null });
    if ("ModelStatusResult" in resp) {
      let modelPrecisions: Record<string, "original" | "int8"> = {};
      try {
        const settingsResp = await callService({ GetSettings: null });
        if ("SettingsResult" in settingsResp) {
          modelPrecisions = settingsResp.SettingsResult.model_precisions || {};
        }
      } catch (se) {}
      renderModelsList(resp.ModelStatusResult.models, modelPrecisions);
      
      const progResp = await callService({ GetDownloadProgress: null });
      if ("DownloadProgressResult" in progResp && progResp.DownloadProgressResult.downloads.length > 0) {
        startModelDownloadPolling();
      }
    } else if ("Error" in resp) {
      container.innerHTML = `<div style="color: #a80000; padding: 8px;">Error loading models: ${resp.Error.message}</div>`;
    }
  } catch (e: any) {
    container.innerHTML = `<div style="color: #a80000; padding: 8px;">Error: ${e.message || e}</div>`;
  }
}

function renderModelsList(models: ModelStatusInfo[], modelPrecisions: Record<string, "original" | "int8">) {
  const container = document.getElementById("settings-models");
  if (!container) return;

  if (models.length === 0) {
    container.innerHTML = `<div style="padding: 8px; color: #666;">No models defined in manifest.</div>`;
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
      const statusIcon = m.status === "downloaded"
        ? '<span style="color: #2e7d32; font-weight: bold;"><i class="bi bi-check-circle-fill"></i> Installed</span>'
        : m.status === "partial"
          ? '<span style="color: #b78103; font-weight: bold;"><i class="bi bi-exclamation-circle-fill"></i> Partial</span>'
          : '<span style="color: #666666;"><i class="bi bi-circle"></i> Not Installed</span>';

      const filesCount = m.files.length;
      const downloadedFilesCount = m.downloaded_files.length;
      
      const sizeStr = m.total_size > 0 
        ? ` (${formatBytes(m.downloaded_size)} / ${formatBytes(m.total_size)})`
        : m.downloaded_size > 0 
          ? ` (${formatBytes(m.downloaded_size)})`
          : "";

      const fileStatusText = `${downloadedFilesCount}/${filesCount} files ready${sizeStr}`;

      let actionsHtml = "";
      if (m.status !== "downloaded") {
        actionsHtml += `<button class="win-button primary" onclick="downloadModel('${m.id}')"><i class="bi bi-download"></i> Download</button>`;
      } else {
        actionsHtml += `<button class="win-button danger" onclick="removeModel('${m.id}')"><i class="bi bi-trash"></i> Delete</button>`;
      }

      if (m.status === "downloaded" && m.id === "wd-eva02-tagger-2026-canary") {
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

      const reqLabel = m.required_by.length > 0 
        ? `<div style="font-size: 10px; color: #666; margin-top: 2px;">Required by: ${m.required_by.join(", ")}</div>` 
        : "";

      const optLabel = m.optional 
        ? `<span style="font-size: 9px; padding: 1px 4px; border: 1px solid #b8daff; background: #cce5ff; color: #004085; margin-left: 6px; font-weight: normal; vertical-align: middle;">Optional</span>`
        : "";

      htmlResult += `
        <div id="model-card-${m.id}" style="padding-bottom: 12px; border-bottom: 1px solid #e0e0e0; display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <strong style="font-size: 13px;">${m.name}</strong> ${optLabel}
              <div style="font-size: 11px; color: #555; margin-top: 2px;">${m.description}</div>
              <div style="font-size: 11px; color: #777; margin-top: 2px;">${fileStatusText}</div>
              ${reqLabel}
            </div>
            <div style="text-align: right; font-size: 11px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
              <div>Status: ${statusIcon}</div>
              <div style="display: flex; gap: 6px;" id="model-actions-${m.id}">
                ${actionsHtml}
              </div>
            </div>
          </div>
          <div id="progress-${m.id}" class="model-progress" style="display: none;"></div>
          <div id="conversion-log-container-${m.id}" style="display: ${m.id === activeConversionModelId ? 'block' : 'none'}; margin-top: 8px; border: 1px solid var(--sys-border-dark, #b0b0b0); background: #1e1e1e; color: #d4d4d4; font-family: 'Consolas', monospace; font-size: 11px; padding: 6px; border-radius: 2px; box-sizing: border-box;">
            <div style="font-weight: bold; border-bottom: 1px solid #444; padding-bottom: 4px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; color: #858585;">
              <span>CONVERSION CONSOLE LOGS</span>
              <span id="conversion-status-${m.id}">Converting...</span>
            </div>
            <pre id="conversion-log-text-${m.id}" style="margin: 0; max-height: 150px; overflow-y: auto; white-space: pre-wrap; font-family: inherit; line-height: 1.4; color: #a9b7c6; text-align: left;"></pre>
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
      const result = await callService({ GetDownloadProgress: null });
      if ("DownloadProgressResult" in result) {
        updateProgressBars(result.DownloadProgressResult.downloads);
        if (result.DownloadProgressResult.downloads.length === 0) {
          stopModelDownloadPolling();
          refreshModelStatus();
        }
      }
    } catch (e) {
      console.error("Error polling model downloads:", e);
    }
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
  for (const dl of downloads) {
    const el = document.getElementById(`progress-${dl.model_id}`);
    const actionsEl = document.getElementById(`model-actions-${dl.model_id}`);
    if (!el) continue;

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
    const resp = await callService({ DownloadModel: { model_id: modelId } });
    if ("ModelActionResult" in resp) {
      if (resp.ModelActionResult.success) {
        startModelDownloadPolling();
        const el = document.getElementById(`progress-${modelId}`);
        if (el) {
          el.style.display = "flex";
          el.innerHTML = `<div style="font-size: 11px; font-weight: bold;"><i class="bi bi-arrow-repeat spin"></i> Starting download...</div>`;
        }
      } else {
        showErrorAlert("Failed to start download:\n" + resp.ModelActionResult.message);
      }
    }
  } catch (e: any) {
    showErrorAlert("Error:\n" + (e.message || e));
  }
}

async function cancelDownload(modelId: string) {
  try {
    const resp = await callService({ CancelDownload: { model_id: modelId } });
    if ("ModelActionResult" in resp) {
      if (resp.ModelActionResult.success) {
        refreshModelStatus();
      } else {
        showErrorAlert("Failed to cancel download:\n" + resp.ModelActionResult.message);
      }
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
    const resp = await callService({ RemoveModel: { model_id: modelId } });
    if ("ModelActionResult" in resp) {
      showInfoAlert(resp.ModelActionResult.message);
      refreshModelStatus();
    }
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
      const logResp = await callService({ GetConversionLogs: { model_id: modelId } });
      if ("ConversionLogsResult" in logResp) {
        const { logs, is_running } = logResp.ConversionLogsResult;
        
        if (logText) {
          logText.textContent = logs;
          logText.scrollTop = logText.scrollHeight;
        }
        if (logContainer) {
          logContainer.style.display = "block";
        }
        if (logStatus) {
          logStatus.textContent = is_running ? "Converting..." : "Completed";
        }
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<i class="bi bi-arrow-repeat spin"></i> Converting...`;
        }

        if (!is_running) {
          clearInterval(activeConversionPollInterval);
          activeConversionPollInterval = null;
          activeConversionModelId = null;
          if (logStatus) logStatus.textContent = "Completed";
          if (btn) {
            btn.style.display = "none";
          }
          refreshModelStatus();
        }
      } else {
        clearInterval(activeConversionPollInterval);
        activeConversionPollInterval = null;
        if (logStatus) logStatus.textContent = "Error reading logs";
        if (btn) btn.disabled = false;
      }
    } catch (err: any) {
      clearInterval(activeConversionPollInterval);
      activeConversionPollInterval = null;
      if (logStatus) logStatus.textContent = "Failed";
      if (btn) btn.disabled = false;
    }
  }, 500);
}

async function convertModel(modelId: string) {
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
    const resp = await callService({ ConvertModel: { model_id: modelId } });
    if ("ModelActionResult" in resp && resp.ModelActionResult.success) {
      activeConversionModelId = modelId;
      resumeConversionPolling(modelId);
    } else {
      const msg = "ModelActionResult" in resp ? resp.ModelActionResult.message : "Failed to initiate conversion.";
      if (logStatus) logStatus.textContent = "Failed to start";
      if (logText) logText.textContent += `\nError: ${msg}`;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-gear-fill"></i> Convert to ONNX`;
      }
      showErrorAlert("Error", msg);
    }
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
    const resp = await callService({ QuantizeModel: { model_id: modelId, format } });
    if ("ModelActionResult" in resp) {
      showInfoAlert(resp.ModelActionResult.message);
      refreshModelStatus();
    }
  } catch (e: any) {
    showErrorAlert("Quantization failed:\n" + (e.message || e));
    refreshModelStatus();
  }
};

(window as any).updateModelPrecision = async (modelId: string, precision: string) => {
  try {
    const settingsResp = await callService({ GetSettings: null });
    if (!("SettingsResult" in settingsResp)) return;
    const s = settingsResp.SettingsResult;
    
    const precs = s.model_precisions || {};
    precs[modelId] = precision;
    
    const saveResp = await callService({
      UpdateSettings: {
        clip_device: s.clip_device,
        tagger_device: s.tagger_device,
        tagger_wd_device: s.tagger_wd_device,
        idle_timeout_secs: s.idle_timeout_secs,
        embedding_model: s.embedding_model,
        detection_device: s.detection_device,
        detection_metrics_device: s.detection_metrics_device,
        ocr_device: s.ocr_device,
        model_precisions: precs,
        preferred_tagger: s.preferred_tagger,
      }
    });
    
    if ("SettingsResult" in saveResp) {
      refreshModelStatus();
    } else if ("Error" in saveResp) {
      showErrorAlert("Failed to update precision:\n" + saveResp.Error.message);
    }
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
