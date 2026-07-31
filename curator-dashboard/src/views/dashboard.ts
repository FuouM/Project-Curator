import { convertFileSrc } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { maskPath } from "../components";
import { renderImages, attachCardEventHandlers, getTagPillHtml, renderParsedMetadataHtml } from "../cards";
import { ImageDetails } from "../types";

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

export function updateStatusIndicators(data: { image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number }) {
  const dot = document.getElementById("service-dot");
  const text = document.getElementById("service-status-text");
  if (dot && text) { dot.classList.remove("offline"); text.textContent = "Service Online"; }

  const imgEl = document.getElementById("stat-images");
  const vecEl = document.getElementById("stat-vectors");
  const pendEl = document.getElementById("stat-pending");
  if (imgEl) imgEl.textContent = data.image_count.toString();
  if (vecEl) vecEl.textContent = data.vector_count.toString();
  if (pendEl) pendEl.textContent = (data.pending_jobs + data.preprocessing_jobs).toString();
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

  const srcUrl = convertFileSrc(featured.current_filepath);
  const badgeClass = featured.vector_state === "ready" ? "badge-ready" : "badge-pending";
  const parsedHtml = featured.parsed_metadata ? renderParsedMetadataHtml(featured.parsed_metadata) : "";

  container.innerHTML = `
    <div class="featured-layout">
      <div class="image-card featured-card" data-image-id="${featured.id}">
        <div class="star-btn ${featured.favorite ? 'favorite' : ''}" data-id="${featured.id}">
          <i class="bi ${featured.favorite ? 'bi-star-fill' : 'bi-star'}"></i>
        </div>
        <div class="image-preview featured-preview">
          <img src="${srcUrl}" alt="Featured Image" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
          <span style="display: none;"><i class="bi bi-image"></i></span>
          <div class="vector-badge ${badgeClass}">${featured.vector_state}</div>
          <div class="featured-badge-overlay"><i class="bi bi-stars"></i> Feature of the Day</div>
          <div class="copy-btn" title="Copy image to clipboard"><i class="bi bi-clipboard"></i></div>
          <div class="info-btn" title="View image details" data-id="${featured.id}"><i class="bi bi-info-circle"></i></div>
        </div>
        <div style="display: flex; gap: 4px; margin-top: 4px;">
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.openTags(${featured.id}, '${featured.current_filepath.replace(/\\/g, '\\\\')}')">
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
        ${parsedHtml ? `<div class="parsed-metadata-list" style="border-bottom: 1px solid var(--sys-border-light, #d0d0d0); padding-bottom: 6px; margin-bottom: 6px;">${parsedHtml}</div>` : ""}
        <div class="tag-list" style="margin-top: 6px;">
          ${featured.tags.length > 0 ? featured.tags.map(t => getTagPillHtml(t)).join("") : '<span style="color: #999; font-style: italic; font-size: 11px;">No tags</span>'}
        </div>
      </div>
    </div>
  `;

  attachCardEventHandlers(container, featured.id, featured.current_filepath, featured, ".featured-preview", true);

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
    (window as any).findSimilar(featured.current_filepath);
  });
}

export function applySettingsToUI(resp: any) {
  if (!("SettingsResult" in resp)) return;
  const s = resp.SettingsResult;
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const detDeviceSelect = document.getElementById("settings-detection-device") as HTMLSelectElement;
  const detMetricsSelect = document.getElementById("settings-detection-metrics-device") as HTMLSelectElement;
  const ocrDeviceSelect = document.getElementById("settings-ocr-device") as HTMLSelectElement;
  if (clipSelect) clipSelect.value = s.clip_device;
  if (taggerSelect) taggerSelect.value = s.tagger_device;
  if (idleSelect) idleSelect.value = s.idle_timeout_secs.toString();
  if (embeddingSelect) {
    embeddingSelect.value = s.embedding_model;
    import("./benchmark").then(m => m.updateBenchmarkModelHeader(s.embedding_model));
  }
  if (detDeviceSelect) detDeviceSelect.value = s.detection_device;
  if (detMetricsSelect) detMetricsSelect.value = s.detection_metrics_device;
  if (ocrDeviceSelect) ocrDeviceSelect.value = s.ocr_device;
}
