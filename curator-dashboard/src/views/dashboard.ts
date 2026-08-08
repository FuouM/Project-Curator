import { convertFileSrc } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { maskPath, SafeHtml, html } from "../components";
import { renderImages, attachCardEventHandlers, renderParsedMetadataHtml, renderCardTagsContainerHtml } from "../cards";
import { findSimilar } from "./concepts";
import { ImageDetails } from "../types";

let featuredCardCleanup: (() => void) | null = null;

export async function refreshDashboard() {
  try {
    const [statusResp, taggerResp] = await Promise.all([
      callService({ GetStatus: null }),
      callService({ GetTaggerStatus: null }),
    ]);
    if ("StatusResult" in statusResp) {
      applyStatusUpdate(statusResp);
    } else {
      throw new Error("Could not reach service");
    }
    applyTaggerUpdate(taggerResp);
    await loadDashboardImages(statusResp.StatusResult.image_count);
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

export function applyStatusUpdate(resp: any) {
  if ("StatusResult" in resp) {
    updateStatusIndicators(resp.StatusResult);
  } else if ("Error" in resp) {
    console.log("Status poll returned Error: " + resp.Error.message);
    const dot = document.getElementById("service-dot");
    const text = document.getElementById("service-status-text");
    if (dot && text) { dot.classList.add("offline"); text.textContent = "Service Error"; }
  }
}

export function applyTaggerUpdate(resp: any) {
  if ("TaggerStatusResult" in resp) {
    updateTaggerIndicators(resp.TaggerStatusResult);
  }
}

export async function refreshTaggerStatus() {
  try {
    const resp = await callService({ GetTaggerStatus: null });
    applyTaggerUpdate(resp);
  } catch (e: any) {
    console.log("refreshTaggerStatus exception: " + (e.message || e));
  }
}

export function startStatusPolling() {
  async function check() {
    try {
      const statusResp = await callService({ GetStatus: null });
      applyStatusUpdate(statusResp);
    } catch (e: any) {
      console.log("startStatusPolling exception: " + (e.message || e));
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
    callService({ GetDashboardInit: null }),
    callService({ ListImages: { limit: 8, offset: 0 } }),
  ]);

  if ("DashboardInitResult" in featuredResp && featuredResp.DashboardInitResult.featured_images.length > 0) {
    renderFeaturedDay(featuredResp.DashboardInitResult.featured_images[0]);
  }
  if ("ListResult" in latestResp) {
    renderImages(latestResp.ListResult.images, "latest-imports-grid");
  }
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
        ${(featured.character_identities && featured.character_identities.length > 0) ? html`<div class="identity-list" style="margin-top: 6px;">${featured.character_identities.map(ci => html`<span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> ${ci.name}</span>`).join("")}</div>` : ""}
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

export function applySettingsToUI(resp: any) {
  if (!("SettingsResult" in resp)) return;
  const s = resp.SettingsResult;
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const taggerWdSelect = document.getElementById("settings-tagger-wd-device") as HTMLSelectElement;
  const preferredTaggerSelect = document.getElementById("settings-preferred-tagger") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById("settings-detection-metrics-device") as HTMLSelectElement;
  const ocrDeviceSelect = document.getElementById("settings-ocr-device") as HTMLSelectElement;
  if (clipSelect) clipSelect.value = s.clip_device;
  if (taggerSelect) taggerSelect.value = s.tagger_device;
  if (taggerWdSelect) taggerWdSelect.value = s.tagger_wd_device;
  if (preferredTaggerSelect) preferredTaggerSelect.value = s.preferred_tagger;
  if (idleSelect) idleSelect.value = s.idle_timeout_secs.toString();
  if (embeddingSelect) {
    embeddingSelect.value = s.embedding_model;
    import("./benchmark").then(m => m.updateBenchmarkModelHeader(s.embedding_model));
  }
  if (detDeviceSelect) detDeviceSelect.value = s.detection_device;
  if (detMetricsSelect) detMetricsSelect.value = s.detection_metrics_device;
  if (ocrDeviceSelect) ocrDeviceSelect.value = s.ocr_device;
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
