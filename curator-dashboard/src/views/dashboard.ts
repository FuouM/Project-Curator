import { convertFileSrc } from "@tauri-apps/api/core";
import { typedCall } from "../ipc";
import { maskPath, SafeHtml, html } from "../components";
import { renderImages, attachCardEventHandlers } from "../cards";
import { renderParsedMetadataHtml, renderCardTagsContainerHtml, renderIdentityListHtml } from "../components/card-tags";
import { findSimilar } from "./concepts";
import { imageDetailsFromProto, taggerStatusInfoFromProto } from "../proto-adapters";
import { ImageDetails } from "../types";
import { StatusResultSchema, DashboardInitResultSchema, type StatusResult } from "../gen/system_pb";
import { TaggerStatusResultSchema, type TaggerStatusResult } from "../gen/tagging_pb";
import { DevicePreference, EmbeddingModel, TaggerModel } from "../gen/common_pb";
import { ListResultSchema, ListImagesRequestSchema } from "../gen/gallery_pb";

let featuredCardCleanup: (() => void) | null = null;

export async function refreshDashboard() {
  try {
    const [statusResp, taggerResp] = await Promise.all([
      typedCall("SystemService.GetStatus", null, null, StatusResultSchema),
      typedCall("TaggingService.GetTaggerStatus", null, null, TaggerStatusResultSchema),
    ]);
    applyStatusUpdate(statusResp);
    applyTaggerUpdate(taggerResp);
    await loadDashboardImages(Number(statusResp.imageCount));
  } catch (e: any) {
    console.error("Failed to refresh dashboard: ", e);
    const featuredContainer = document.getElementById("featured-day-content");
    if (featuredContainer) {
      featuredContainer.innerHTML = `
        <div style="text-align: center; color: #555555; padding: 20px;">
          <p style="font-weight: bold; color: #a80000; font-size: 13px;">Service Offline</p>
          <p style="margin-top: 6px;">Start the backend service to load featured content.</p>
        </div>`;
    }
  }
}

export function updateStatusIndicators(data: { image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number; ram_usage_bytes: number }) {
  const dot = document.getElementById("service-dot");
  const text = document.getElementById("service-status-text");
  if (dot && text) { dot.classList.remove("offline"); text.textContent = "Service Online"; }

  const imgEl = document.getElementById("stat-images");
  const vecEl = document.getElementById("stat-vectors");
  const pendEl = document.getElementById("stat-pending");
  if (imgEl) imgEl.textContent = data.image_count.toString();
  if (vecEl) vecEl.textContent = data.vector_count.toString();
  if (pendEl) pendEl.textContent = (data.pending_jobs + data.preprocessing_jobs).toString();

  // Update RAM status bar
  const ramEl = document.getElementById("status-ram-text");
  if (ramEl) {
    const bytes = data.ram_usage_bytes;
    let ramText = "";
    if (bytes === 0) {
      ramText = "RAM: —";
    } else {
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      ramText = `RAM: ${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }
    ramEl.textContent = ramText;
  }
}

export function updateTaggerIndicators(data: { loaded: boolean; model_path: string; total_tags: number }) {
  const taggerEl = document.getElementById("stat-tagger");
  const taggerDetail = document.getElementById("stat-tagger-detail");
  if (taggerEl) {
    taggerEl.textContent = data.loaded ? "Active in RAM" : "Ready to load";
    if (taggerDetail) {
      const parts: string[] = [];
      if (data.model_path) parts.push(maskPath(data.model_path));
      if (data.total_tags > 0) parts.push(`${data.total_tags} tags`);
      taggerDetail.textContent = parts.length > 0 ? parts.join(" | ") : "—";
    }
  }
}

export function applyStatusUpdate(resp: StatusResult) {
  updateStatusIndicators({
    image_count: Number(resp.imageCount),
    vector_count: Number(resp.vectorCount),
    pending_jobs: Number(resp.pendingJobs),
    preprocessing_jobs: Number(resp.preprocessingJobs),
    ram_usage_bytes: Number(resp.ramUsageBytes),
  });
}

export function applyTaggerUpdate(resp: TaggerStatusResult) {
  const preferredKey = taggerToString(resp.preferredTagger);
  const info = resp.taggers.find(t => t.key === preferredKey) ?? resp.taggers[0];
  if (info) {
    updateTaggerIndicators(taggerStatusInfoFromProto(info));
  }
}

export async function refreshTaggerStatus() {
  try {
    const resp = await typedCall("TaggingService.GetTaggerStatus", null, null, TaggerStatusResultSchema);
    applyTaggerUpdate(resp);
  } catch (_) {}
}

export function startStatusPolling() {
  async function check() {
    try {
      const statusResp = await typedCall("SystemService.GetStatus", null, null, StatusResultSchema);
      applyStatusUpdate(statusResp);
    } catch (_) {
      const dot = document.getElementById("service-dot");
      const text = document.getElementById("service-status-text");
      if (dot && text) { dot.classList.add("offline"); text.textContent = "Service Offline"; }
    }
  };

  setInterval(check, 5000);
}

async function loadDashboardImages(image_count: number) {
  const featuredContainer = document.getElementById("featured-day-content");

  if (image_count === 0) {
    if (featuredContainer) {
        featuredContainer.innerHTML = `
          <div style="text-align: center; color: #777; padding: 20px;">
            <p style="font-size: 13px;">No images imported yet.</p>
            <p style="margin-top: 4px; font-size: 11px;">Use <strong>Import</strong> to add images to your library.</p>
    </div>`;
    }
    renderImages([], "latest-imports-grid");
    return;
  }

  const [featuredResp, latestResp] = await Promise.all([
    typedCall("SystemService.GetDashboardInit", null, null, DashboardInitResultSchema),
    typedCall("GalleryService.ListImages", ListImagesRequestSchema, { limit: 8, offset: 0 }, ListResultSchema),
  ]);

  if (featuredResp.featuredImages.length > 0) {
    renderFeaturedDay(imageDetailsFromProto(featuredResp.featuredImages[0]));
  }
  renderImages(latestResp.images.map(imageDetailsFromProto), "latest-imports-grid");
}

export function renderFeaturedDay(featured: ImageDetails) {
  const container = document.getElementById("featured-day-content");
  if (!container) return;

  if (featuredCardCleanup) {
    featuredCardCleanup();
    featuredCardCleanup = null;
  }

  const srcUrl = convertFileSrc(featured.current_filepath);
  const badgeClass = featured.vector_state === "ready" ? "badge-ready" : "badge-pending";
  const parsedHtml = featured.parsed_metadata ? renderParsedMetadataHtml(featured.parsed_metadata) : "";
  const ocrHtml = featured.ocr_text
    ? `<div class="ocr-block" data-action="toggle-ocr"><i class="bi bi-file-earmark-text ocr-icon"></i><span class="ocr-block-text">${featured.ocr_text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</span></div>`
    : "";

  container.innerHTML = html`
    <div class="featured-layout">
      <div class="image-card featured-card" data-image-id="${featured.id}">
        <div class="star-btn ${featured.favorite ? 'favorite' : ''}" data-id="${featured.id}">
          <i class="bi ${featured.favorite ? 'bi-star-fill' : 'bi-star'}"></i>
        </div>
        <div class="image-preview featured-preview">
          <img src="${srcUrl}" alt="Featured Image" style="width: 100%; height: 100%; object-fit: cover;" />
          <div class="vector-badge ${badgeClass}">${featured.vector_state}</div>
          <div class="featured-badge-overlay"><i class="bi bi-stars"></i> Feature of the Day</div>
          <div class="copy-btn" title="Copy image to clipboard"><i class="bi bi-clipboard"></i></div>
          <div class="info-btn" title="View image details" data-id="${featured.id}"><i class="bi bi-info-circle"></i></div>
        </div>
        <div style="display: flex; gap: 4px; margin-top: 4px;">
          <button class="win-button" style="font-size: 11px; flex: 1;" data-action="open-tags" data-image-id="${featured.id}" data-filepath="${featured.current_filepath.replace(/\\/g, '\\\\')}">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" id="featured-search-btn">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
      <div class="featured-details">
        <div class="featured-filename" title="${featured.current_filepath}">${featured.current_filepath.split(/[\\/]/).pop()}</div>
        <div class="image-path-row">
          <div class="image-path" title="${featured.current_filepath}">${maskPath(featured.current_filepath)}</div>
          <button class="win-button image-open-folder-btn" style="display: none; font-size: 10px; padding: 1px 6px; white-space: nowrap;" title="Open containing folder">
            <i class="bi bi-folder2-open"></i>
          </button>
        </div>
        ${parsedHtml ? html`<div class="parsed-metadata-list" style="border-bottom: 1px solid var(--sys-border-light, #d0d0d0); padding-bottom: 6px; margin-bottom: 6px;">${parsedHtml}</div>` : ""}
        ${ocrHtml}
        ${renderIdentityListHtml(featured.character_identities, "margin-top: 6px;")}
         <div class="card-tags-container" style="width: 100%; margin-top: 6px;">
          ${renderCardTagsContainerHtml(featured, true)}
        </div>
      </div>
    </div>
  `;

  featuredCardCleanup = attachCardEventHandlers(container, featured.id, featured.current_filepath, featured, ".featured-preview", true);

  const tagList = container.querySelector(".featured-details .tag-list") as HTMLElement;
  const card = container.querySelector(".featured-card") as HTMLElement;
  if (tagList && card) {
    const applyTagListHeight = () => {
      const filename = container.querySelector(".featured-filename") as HTMLElement;
      const path = container.querySelector(".image-path") as HTMLElement;
      const fixedHeight = (filename?.offsetHeight || 0) + (path?.offsetHeight || 0) + 6;
      tagList.style.maxHeight = Math.max(0, card.offsetHeight - fixedHeight) + "px";
      tagList.style.overflowY = "auto";
    };
    const previewDiv = container.querySelector(".featured-preview");
    if (previewDiv) {
      const img = previewDiv.querySelector("img");
      if (img && !img.complete) {
        img.addEventListener("load", applyTagListHeight, { once: true });
      }
    }
    applyTagListHeight();
  }

  document.getElementById("featured-search-btn")?.addEventListener("click", async () => {
    findSimilar(featured.current_filepath);
  });
}

function deviceToString(d: DevicePreference): string {
  return d === DevicePreference.CPU ? "cpu" : d === DevicePreference.GPU ? "gpu" : "auto";
}

function embeddingToString(m: EmbeddingModel): string {
  return m === EmbeddingModel.MOBILECLIP_S2 ? "mobileclip-s2" : "clip-vit-b-32";
}

function taggerToString(t: TaggerModel): string {
  return t === TaggerModel.CAMIE ? "camie" : "wd-eva02";
}

export interface SettingsUISnapshot {
  clipDevice: DevicePreference;
  taggerDevice: DevicePreference;
  taggerWdDevice: DevicePreference;
  preferredTagger: TaggerModel;
  idleTimeoutSecs: bigint;
  embeddingModel: EmbeddingModel;
  detectionDevice: DevicePreference;
  detectionMetricsDevice: DevicePreference;
  ocrDevice: DevicePreference;
}

export function applySettingsToUI(s: SettingsUISnapshot) {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const taggerWdSelect = document.getElementById("settings-tagger-wd-device") as HTMLSelectElement;
  const preferredTaggerSelect = document.getElementById("settings-preferred-tagger") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById("settings-detection-metrics-device") as HTMLSelectElement;
  const ocrDeviceSelect = document.getElementById("settings-ocr-device") as HTMLSelectElement;
  if (clipSelect) clipSelect.value = deviceToString(s.clipDevice);
  if (taggerSelect) taggerSelect.value = deviceToString(s.taggerDevice);
  if (taggerWdSelect) taggerWdSelect.value = deviceToString(s.taggerWdDevice);
  if (preferredTaggerSelect) preferredTaggerSelect.value = taggerToString(s.preferredTagger);
  if (idleSelect) idleSelect.value = s.idleTimeoutSecs.toString();
  if (embeddingSelect) {
    embeddingSelect.value = embeddingToString(s.embeddingModel);
    import("./benchmark").then(m => m.updateBenchmarkModelHeader(embeddingToString(s.embeddingModel)));
  }
  if (detDeviceSelect) detDeviceSelect.value = deviceToString(s.detectionDevice);
  if (detMetricsSelect) detMetricsSelect.value = deviceToString(s.detectionMetricsDevice);
  if (ocrDeviceSelect) ocrDeviceSelect.value = deviceToString(s.ocrDevice);
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderDashboardHtml(): SafeHtml {
  return html`
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Images</div>
        <div class="stat-value" id="stat-images" style="display: flex; align-items: center; gap: 6px;">
          <span class="skeleton-text skeleton-pulse" style="width: 24px; height: 14px; display: inline-block;"></span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Indexed Vectors</div>
        <div class="stat-value" id="stat-vectors" style="display: flex; align-items: center; gap: 6px;">
          <span class="skeleton-text skeleton-pulse" style="width: 24px; height: 14px; display: inline-block;"></span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending Jobs</div>
        <div class="stat-value" id="stat-pending" style="display: flex; align-items: center; gap: 6px;">
          <span class="skeleton-text skeleton-pulse" style="width: 24px; height: 14px; display: inline-block;"></span>
        </div>
      </div>
      <div class="stat-card" id="tagger-stat-card">
        <div class="stat-label">AI Tagger</div>
        <div class="stat-value" id="stat-tagger" style="font-size: 13px;">
          <span class="skeleton-text skeleton-pulse" style="width: 60px; height: 14px; display: inline-block;"></span>
        </div>
        <div id="stat-tagger-detail" style="font-size: 11px; color: #888; margin-top: 4px; line-height: 1.4;">—</div>
      </div>
    </div>

    <div class="dashboard-bottom-row">
      <!-- Feature of the Day Panel -->
      <div class="group-box featured-panel" style="flex: 1; min-width: 300px; align-self: flex-start;">
        <div class="group-box-title">Feature of the Day</div>
        <div id="featured-day-content" style="display: flex; flex-direction: column; gap: 12px; justify-content: flex-start;">
          <div class="skeleton-card skeleton-pulse" style="width: 100%; height: 200px; border-radius: 4px;"></div>
        </div>
        <div style="margin-top: 8px;">
          <button type="button" class="win-button" id="dashboard-lucky-btn" style="width: 100%;">
            <i class="bi bi-shuffle"></i> I'm Feeling Lucky
          </button>
        </div>
      </div>

      <!-- Latest Imports Panel -->
      <div class="group-box imports-panel" style="flex: 1.5; min-width: 350px;">
        <div class="group-box-title">Latest Imports</div>
        <div class="imports-scroll">
          <div class="image-grid" id="latest-imports-grid">
            <div class="skeleton-card skeleton-pulse" style="width: 100%; height: 240px; border-radius: 4px;"></div>
            <div class="skeleton-card skeleton-pulse" style="width: 100%; height: 240px; border-radius: 4px;"></div>
            <div class="skeleton-card skeleton-pulse" style="width: 100%; height: 240px; border-radius: 4px;"></div>
            <div class="skeleton-card skeleton-pulse" style="width: 100%; height: 240px; border-radius: 4px;"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}
