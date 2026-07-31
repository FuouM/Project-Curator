import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { renderTagPill, maskPath } from "./components";
import { CardImageData, ImageDetails, SearchMatch, TagSummary, ParsedMetadata } from "./types";
import { imageBytesToPngBlob } from "./utils";
import { getImageClickAction, isSelectMode, selectedImageIds } from "./state";
import { openImageViewer } from "./image-viewer";
import { callService } from "./ipc";
import { refreshCharacters } from "./views/characters";
import { attachAutocomplete } from "./autocomplete";
import { LruCache } from "./lru-cache";

// --- Thumbnail Queue ---
const MAX_CONCURRENT = 2;
let generation = 0;
let activeCount = 0;
let thumbTotal = 0;
let thumbLoaded = 0;
let thumbHideTimer: number | null = null;

// --- Thumbnail Cache (LRU, limited to 500 entries) ---
const thumbCache = new LruCache<string>(500);

function cacheThumbnail(imageId: number, url: string) {
  thumbCache.set(imageId, url);
}

// --- Crop Cache (LRU, limited to 100 entries) ---
const cropCache = new LruCache<string>(100);

function cacheCrop(detectionId: number, url: string) {
  cropCache.set(detectionId, url);
}

export function getCachedCrop(detectionId: number): string | undefined {
  return cropCache.get(detectionId);
}

export function setCachedCrop(detectionId: number, url: string) {
  cacheCrop(detectionId, url);
}

export function invalidateCropCache(detectionId: number) {
  cropCache.delete(detectionId);
}

export function clearAllCropCaches() {
  cropCache.clear();
}

interface ThumbJob {
  imageId: number;
  img: HTMLImageElement;
  preview: HTMLElement;
  gen: number;
}

const queue: ThumbJob[] = [];

function processQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    activeCount++;
    invokeThumbnail(job);
  }
}

function invokeThumbnail(job: ThumbJob) {
  if (job.gen !== generation) { activeCount--; processQueue(); return; }
  if (!job.img.isConnected) { activeCount--; thumbLoaded++; updateThumbProgress(); processQueue(); return; }

  invoke("get_thumbnail", { imageId: job.imageId }).then((data: any) => {
    if (job.gen !== generation || !job.img.isConnected || !data) return;
    const bytes = new Uint8Array(data);
    const blob = new Blob([bytes], { type: "image/webp" });
    const url = URL.createObjectURL(blob);
    cacheThumbnail(job.imageId, url);
    job.img.src = url;
    job.img.classList.add("loaded");
  }).catch(() => {}).finally(() => {
    if (job.preview) job.preview.classList.remove("thumb-loading");
    thumbLoaded++;
    updateThumbProgress();
    activeCount--;
    processQueue();
  });
}

function updateThumbProgress() {
  const cell = document.getElementById("thumb-progress-cell");
  const text = document.getElementById("thumb-progress-text");
  const fill = document.getElementById("thumb-progress-fill");
  if (!cell || !text || !fill) return;

  if (thumbTotal === 0) {
    cell.style.display = "none";
    return;
  }
  cell.style.display = "flex";
  text.textContent = `${thumbLoaded}/${thumbTotal}`;
  fill.style.width = `${Math.round((thumbLoaded / thumbTotal) * 100)}%`;

  if (thumbLoaded >= thumbTotal) {
    if (thumbHideTimer) clearTimeout(thumbHideTimer);
    thumbHideTimer = window.setTimeout(() => { cell.style.display = "none"; }, 1000);
  }
}

// --- Lazy Loading via IntersectionObserver (queues jobs, does not invoke directly) ---
const lazyObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const img = entry.target as HTMLImageElement;
      const imageId = parseInt(img.dataset.thumbId || "0", 10);
      if (imageId > 0 && img.dataset.pending === "1") {
        img.dataset.pending = "0";
        const preview = img.closest(".image-preview") as HTMLElement;
        const fp = img.dataset.filepath || "";

        if (/\.gif$/i.test(fp)) {
          img.src = convertFileSrc(fp);
          img.classList.add("loaded");
          if (preview) preview.classList.remove("thumb-loading");
          thumbLoaded++;
          updateThumbProgress();
        } else {
          if (preview) preview.classList.add("thumb-loading");
          queue.push({ imageId, img, preview, gen: generation });
          processQueue();
        }
      }
      lazyObserver.unobserve(img);
    }
  }
}, { rootMargin: "300px" });

// --- Tag Pill Helpers ---

export function getTagPillHtml(t: TagSummary, isDeletable = false, imageId = 0): string {
  return renderTagPill(t, { isDeletable, imageId });
}

export function renderTagListHtml(tags: TagSummary[], maxVisible = 10): string {
  const display = tags.slice(0, maxVisible);
  const extraCount = tags.length - maxVisible;
  return display.map(t => getTagPillHtml(t)).join("") +
    (extraCount > 0 ? `<span class="tag-pill" style="background-color: #f0f0f0; color: #555555; font-style: italic;">+${extraCount} more</span>` : "");
}

export function renderParsedMetadataHtml(meta: ParsedMetadata): string {
  const parts: string[] = [];

  if (meta.match_type === "anime_screenshot") {
    const animeTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const epTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    const animeName = animeTag ? animeTag.split(":").slice(1).join(":") : "Unknown";
    const epNum = epTag ? epTag.split(":").slice(1).join(":") : "?";
    const partialBadge = meta.partial ? ' <span style="font-size: 9px; color: #856404;">(partial)</span>' : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-film"></i> Anime Screenshot: ${animeName} - ${epNum}${partialBadge}</span>`);
  } else if (meta.match_type === "danbooru") {
    const hashTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("hash:"));
    const artistTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("artist:"));
    const hash = hashTag ? hashTag.split(":").slice(1).join(":") : "";
    const artist = artistTag ? artistTag.split(":").slice(1).join(":") : "?";
    const hashDisplay = hash.length > 8 ? `${hash.slice(0, 4)}...${hash.slice(-4)}` : hash;
    const hashLink = hash ? `<a href="https://danbooru.donmai.us/posts?tags=md5%3A${hash}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'" title="${hash}">${hashDisplay}</a>` : "?";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-grid-3x3-gap"></i> ${artist} - ${hashLink}</span>`);
  } else {
    if (meta.datetime_iso) {
      parts.push(`<span class="tag-pill tag-meta" style="font-size: 10px;"><i class="bi bi-clock"></i> 4chan: ${meta.datetime_iso}</span>`);
    } else if (meta.artist) {
      parts.push(`<span class="tag-pill tag-artist" style="font-size: 10px;"><i class="bi bi-person"></i> artist: ${meta.artist}</span>`);
    }
  }

  if (meta.pixiv_id) {
    const pageTag = meta.extracted_tags.find(t => t.startsWith("page:"));
    const pageStr = pageTag ? ` ${pageTag}` : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px;"><i class="bi bi-image"></i> pixiv: <a href="https://www.pixiv.net/en/artworks/${meta.pixiv_id}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'">${meta.pixiv_id}</a>${pageStr}</span>`);
  }
  if (meta.twitter_id) parts.push(`<span class="tag-pill tag-character" style="font-size: 10px;"><i class="bi bi-twitter"></i> twitter: ${meta.twitter_id}</span>`);

  const fieldTags = new Set<string>();
  if (meta.artist) fieldTags.add(`artist:${meta.artist}`);
  if (meta.pixiv_id) fieldTags.add(`pixiv:${meta.pixiv_id}`);
  if (meta.twitter_id) fieldTags.add(`twitter:${meta.twitter_id}`);
  if (meta.datetime_iso) fieldTags.add(`date:${meta.datetime_iso.split(' ')[0]}`);
  if (meta.match_type === "anime_screenshot") {
    const a = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const e = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    if (a) fieldTags.add(a);
    if (e) fieldTags.add(e);
  }

  for (const tag of meta.extracted_tags) {
    if (fieldTags.has(tag)) continue;
    if (tag.startsWith('artist:') || tag.startsWith('pixiv:') || tag.startsWith('twitter:')) continue;
    if (tag.startsWith('page:')) continue;
    const tl = tag.toLowerCase();
    if (tl.startsWith('anime:') || tl.startsWith('episode:')) continue;

    let tagClass = "tag-rank-3";
    if (tag.startsWith("date:")) tagClass = "tag-meta";
    else if (tag.startsWith("source:") || tag.startsWith("site:")) tagClass = "tag-meta";
    else if (tag.startsWith("group:")) tagClass = "tag-character";
    else if (tag.startsWith("resolution:")) tagClass = "tag-meta";
    parts.push(`<span class="tag-pill ${tagClass}" style="font-size: 10px; font-family: monospace;">${tag}</span>`);
  }

  return parts.join(" ");
}

// --- Event Delegation (one listener per grid, not per card) ---

export function setupGridDelegation(grid: HTMLElement) {
  grid.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest(".image-card") as HTMLElement;
    if (!card) return;
    const imageId = parseInt(card.dataset.imageId || "0", 10);
    if (!imageId) return;

    if (target.closest(".star-btn")) {
      handleStarClick(card, imageId);
      return;
    }
    if (target.closest(".copy-btn")) {
      handleCopyClick(card, imageId);
      return;
    }
    if (target.closest(".info-btn")) {
      handleInfoClick(imageId);
      return;
    }
    if (target.closest(".image-open-folder-btn")) {
      const filepath = card.dataset.filepath || "";
      const dir = filepath.replace(/[\\/][^\\/]+$/, "");
      invoke("open_file_externally", { path: dir }).catch(() => {});
      return;
    }

    const actionBtn = target.closest("[data-action]") as HTMLElement;
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const fp = card.dataset.filepath || "";
      if (action === "open-tags") {
        (window as any).openTags(imageId, fp);
      } else if (action === "find-similar") {
        (window as any).findSimilar(fp);
      }
      return;
    }

    if (target.closest(".win-button")) return;
    if (target.closest(".star-btn")) return;

    if (target.closest(".image-path")) {
      const openFolderBtn = card.querySelector(".image-open-folder-btn") as HTMLElement;
      if (openFolderBtn) openFolderBtn.style.display = openFolderBtn.style.display === "none" ? "inline-flex" : "none";
      return;
    }

    if (target.closest(".image-preview")) {
      const filepath = card.dataset.filepath || "";
      if (getImageClickAction() === "external") {
        invoke("open_file_externally", { path: filepath }).catch(() => {});
      } else {
        openImageViewer(filepath, imageId);
      }
      return;
    }

    if (isSelectMode) {
      const checkbox = card.querySelector(".card-select-checkbox") as HTMLInputElement;
      if (selectedImageIds.has(imageId)) {
        selectedImageIds.delete(imageId);
        card.classList.remove("selected");
        if (checkbox) checkbox.checked = false;
      } else {
        selectedImageIds.add(imageId);
        card.classList.add("selected");
        if (checkbox) checkbox.checked = true;
      }
      import("./views/gallery").then(m => m.updateSelectionUI());
    }
  });

  grid.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("card-select-checkbox")) return;
    const card = target.closest(".image-card") as HTMLElement;
    if (!card) return;
    const imageId = parseInt(card.dataset.imageId || "0", 10);
    const checkbox = target as HTMLInputElement;
    if (checkbox.checked) {
      selectedImageIds.add(imageId);
      card.classList.add("selected");
    } else {
      selectedImageIds.delete(imageId);
      card.classList.remove("selected");
    }
    import("./views/gallery").then(m => m.updateSelectionUI());
  });
}

export function attachCardEventHandlers(
  container: HTMLElement,
  imageId: number,
  filepath: string,
  _imageData: any,
  _previewSelector: string,
  _isFeatured: boolean
) {
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".star-btn")) {
      handleStarClick(container, imageId);
      return;
    }
    if (target.closest(".copy-btn")) {
      handleCopyClick(container, imageId);
      return;
    }
    if (target.closest(".info-btn")) {
      handleInfoClick(imageId);
      return;
    }
    if (target.closest(".image-open-folder-btn")) {
      const dir = filepath.replace(/[\\/][^\\/]+$/, "");
      invoke("open_file_externally", { path: dir }).catch(() => {});
      return;
    }
    if (target.closest(".image-path")) {
      const btn = container.querySelector(".image-open-folder-btn") as HTMLElement;
      if (btn) btn.style.display = btn.style.display === "none" ? "inline-flex" : "none";
      return;
    }
    if (target.closest(".image-preview")) {
      if (getImageClickAction() === "external") {
        invoke("open_file_externally", { path: filepath }).catch(() => {});
      } else {
        openImageViewer(filepath, imageId);
      }
      return;
    }
  });
}

function handleStarClick(card: HTMLElement, imageId: number) {
  const starBtn = card.querySelector(".star-btn");
  if (!starBtn) return;
  const newFav = !starBtn.classList.contains("favorite");

  callService({ SetFavorite: { image_id: imageId, favorite: newFav } }).then((resp) => {
    if ("Success" in resp) {
      document.querySelectorAll(`[data-image-id="${imageId}"] .star-btn`).forEach(btn => {
        if (newFav) {
          btn.classList.add("favorite");
          btn.querySelector("i")?.setAttribute("class", "bi bi-star-fill");
        } else {
          btn.classList.remove("favorite");
          btn.querySelector("i")?.setAttribute("class", "bi bi-star");
        }
      });
      const activeNav = document.querySelector(".nav-item.active");
      if (activeNav && activeNav.getAttribute("data-view") === "favorites" && !newFav) {
        import("./views/gallery").then(m => m.refreshFavorites());
      }
    }
  }).catch(() => {});
}

function handleCopyClick(card: HTMLElement, _imageId: number) {
  const copyBtn = card.querySelector(".copy-btn");
  if (!copyBtn) return;
  const filepath = card.dataset.filepath || "";

  invoke("read_image_bytes", { path: filepath }).then((bytes: any) => {
    const uint8 = new Uint8Array(bytes);
    return imageBytesToPngBlob(uint8);
  }).then((blob) => {
    return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }).then(() => {
    copyBtn.classList.add("copied");
    copyBtn.querySelector("i")?.setAttribute("class", "bi bi-check-lg");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.querySelector("i")?.setAttribute("class", "bi bi-clipboard");
    }, 1500);
  }).catch(() => {});
}

function handleInfoClick(imageId: number) {
  callService({ GetImage: { image_id: imageId } }).then((resp) => {
    if ("ImageResult" in resp) {
      openImageInfoModal(resp.ImageResult.image);
    }
  }).catch(() => {});
}

function openImageInfoModal(img: ImageDetails) {
  const modal = document.getElementById("image-info-modal");
  const body = document.getElementById("image-info-modal-body");
  if (!modal || !body) return;

  const sha256Short = img.sha256 ? img.sha256.slice(0, 16) + "..." : "—";
  const sha256Full = img.sha256 || "";
  const mtime = img.mtime ? new Date(img.mtime * 1000).toLocaleString() : "—";
  const createdAt = img.created_at || "—";
  const tagsCount = img.tags?.length ?? 0;
  const tagCategories = img.tags?.reduce((acc: Record<string, number>, t) => {
    acc[t.category] = (acc[t.category] || 0) + 1;
    return acc;
  }, {}) ?? {};

  let parsedHtml = "";
  if (img.parsed_metadata) {
    const pm = img.parsed_metadata;
    const fields: [string, string][] = [];
    fields.push(["Match Type", pm.match_type]);
    if (pm.artist) fields.push(["Artist", pm.artist]);
    if (pm.pixiv_id) fields.push(["Pixiv ID", pm.pixiv_id]);
    if (pm.twitter_id) fields.push(["Twitter ID", pm.twitter_id]);
    if (pm.datetime_iso) fields.push(["DateTime", pm.datetime_iso]);
    if (pm.raw_matched) fields.push(["Raw Matched", pm.raw_matched]);
    if (pm.extracted_tags.length > 0) fields.push(["Extracted Tags", pm.extracted_tags.join(", ")]);
    if (pm.partial !== undefined) fields.push(["Partial", pm.partial ? "Yes" : "No"]);
    const rows = fields.map(([k, v]) => `<tr><td style="font-weight:600;width:120px;">${k}</td><td style="word-break:break-all;">${v}</td></tr>`).join("");
    parsedHtml = '<div class="group-box" style="margin-top:8px;"><div class="group-box-title"><i class="bi bi-file-earmark-code"></i> Parsed Metadata</div><table class="curator-table" style="font-size:11px;"><tbody>' + rows + '</tbody></table></div>';
  }

  const catBreakdown = Object.entries(tagCategories).map(([cat, count]) => `${cat}: ${count}`).join(", ");
  const tagsHtml = img.tags?.length
    ? img.tags.map(t => renderTagPill(t)).join(" ")
    : '<span style="color:#999;font-style:italic;">No tags</span>';

  const detectionsHtml = `<div class="group-box" style="margin-top:8px;" id="detections-section">
    <div class="group-box-title"><i class="bi bi-bounding-box"></i> Character Detections</div>
    <div class="group-box-body" id="detections-body">
      <div id="detections-loading" style="display:none;color:#666;font-size:11px;"><i class="bi bi-hourglass-split"></i> Loading detections...</div>
      <div id="detections-empty" style="display:none;color:#999;font-size:11px;font-style:italic;">No detections yet.</div>
      <div id="detections-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      <div style="display:flex;gap:4px;margin-top:4px;">
        <button class="win-button primary" id="detect-characters-btn" style="font-size:11px;">
          <i class="bi bi-bounding-box"></i> Detect Characters
        </button>
        <button class="win-button" id="refresh-detections-btn" style="font-size:11px;">
          <i class="bi bi-arrow-clockwise"></i> Refresh
        </button>
      </div>
    </div>
  </div>`;

  body.innerHTML =
    '<table class="curator-table" style="font-size:11px;"><tbody>' +
    '<tr><td style="font-weight:600;width:120px;">Image ID</td><td>' + img.id + '</td></tr>' +
    '<tr><td style="font-weight:600;">Filepath</td><td style="word-break:break-all;">' + img.current_filepath + '</td></tr>' +
    '<tr><td style="font-weight:600;">SHA-256</td><td style="font-family:monospace;display:flex;align-items:center;gap:6px;"><span id="info-sha256-text">' + sha256Short + '</span><button class="win-button" id="info-copy-sha256" title="Copy full SHA-256" style="font-size:10px;padding:2px 6px;"><i class="bi bi-clipboard"></i></button></td></tr>' +
    '<tr><td style="font-weight:600;">Modified</td><td>' + mtime + '</td></tr>' +
    '<tr><td style="font-weight:600;">Imported</td><td>' + createdAt + '</td></tr>' +
    '<tr><td style="font-weight:600;">Vector State</td><td>' + img.vector_state + '</td></tr>' +
    '<tr><td style="font-weight:600;">Favorite</td><td>' + (img.favorite ? "Yes" : "No") + '</td></tr>' +
    '<tr><td style="font-weight:600;">Tags (' + tagsCount + ')</td><td>' + (catBreakdown || "—") + '</td></tr>' +
    '</tbody></table>' +
    '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">' + tagsHtml + '</div>' +
    parsedHtml +
    detectionsHtml;

  modal.classList.add("active");

  // --- Copy SHA-256 ---
  const copySha = body.querySelector("#info-copy-sha256");
  if (copySha && sha256Full) {
    copySha.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(sha256Full);
        copySha.innerHTML = '<i class="bi bi-check-lg"></i>';
        setTimeout(() => { copySha.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1200);
      } catch (_) {}
    });
  }

  // --- Character Detections ---
  loadDetectionsForImage(img.id);

  const detectBtn = body.querySelector("#detect-characters-btn") as HTMLButtonElement;
  if (detectBtn) {
    detectBtn.addEventListener("click", async () => {
      detectBtn.disabled = true;
      detectBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Detecting...';
      const loading = body.querySelector("#detections-loading") as HTMLElement;
      if (loading) loading.style.display = "block";
      try {
        await callService({ DetectCharacters: { image_id: img.id } });
        await loadDetectionsForImage(img.id);
        await refreshCharacters();
      } catch (e: any) {
        console.error("Detection failed:", e);
      } finally {
        detectBtn.disabled = false;
        detectBtn.innerHTML = '<i class="bi bi-bounding-box"></i> Detect Characters';
        if (loading) loading.style.display = "none";
      }
    });
  }

  const refreshDetBtn = body.querySelector("#refresh-detections-btn") as HTMLButtonElement;
  if (refreshDetBtn) {
    refreshDetBtn.addEventListener("click", async () => {
      await loadDetectionsForImage(img.id);
    });
  }

  const closeBtn = modal.querySelector(".modal-close");
  const onClose = () => { modal.classList.remove("active"); closeBtn?.removeEventListener("click", onClose); };
  closeBtn?.addEventListener("click", onClose);
  modal.addEventListener("click", (e) => { if (e.target === modal) onClose(); }, { once: true });
}

async function loadDetectionsForImage(imageId: number) {
  const loading = document.getElementById("detections-loading");
  const empty = document.getElementById("detections-empty");
  const list = document.getElementById("detections-list");
  if (!list) return;

  if (loading) loading.style.display = "block";
  if (empty) empty.style.display = "none";
  list.innerHTML = "";

  try {
    const resp = await callService({ GetCharacterDetections: { image_id: imageId } });
    if ("CharacterDetectionsResult" in resp) {
      const detections = resp.CharacterDetectionsResult.detections;
      if (loading) loading.style.display = "none";

      if (detections.length === 0) {
        if (empty) empty.style.display = "block";
        return;
      }

      const idResp = await callService({ ListCharacterIdentities: null });
      const identities: any[] = "CharacterIdentitiesList" in idResp ? idResp.CharacterIdentitiesList.identities : [];

      for (const det of detections) {
        const detEl = renderDetectionRow(det, identities, imageId);
        list.appendChild(detEl);
      }
    }
  } catch (e) {
    console.error("Failed to load detections:", e);
    if (loading) loading.style.display = "none";
    if (empty) {
      empty.style.display = "block";
      empty.textContent = "Failed to load detections.";
    }
  }
}

function renderDetectionRow(det: any, identities: any[], imageId: number): HTMLElement {
  const detEl = document.createElement("div");
  detEl.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;background:var(--sys-window-bg,#fff);font-size:11px;";

  const cropThumb = document.createElement("div");
  cropThumb.className = "skeleton-pulse";
  cropThumb.style.cssText = "width:48px;height:48px;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
  cropThumb.innerHTML = '<i class="bi bi-image" style="color:#999;"></i>';

  const cachedCropUrl = cropCache.get(det.id);
  if (cachedCropUrl) {
    cropThumb.classList.remove("skeleton-pulse");
    cropThumb.innerHTML = `<img src="${cachedCropUrl}" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    callService({ GetDetectionCrop: { detection_id: det.id, max_size: 96 } }).then((cropResp: any) => {
      if ("DetectionCropResult" in cropResp) {
        const bytes = new Uint8Array(cropResp.DetectionCropResult.crop_webp_bytes);
        const blob = new Blob([bytes], { type: "image/webp" });
        const url = URL.createObjectURL(blob);
        cacheCrop(det.id, url);
        cropThumb.classList.remove("skeleton-pulse");
        cropThumb.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;" />`;
      }
    }).catch(() => {
      cropThumb.classList.remove("skeleton-pulse");
    });
  }

  const infoEl = document.createElement("div");
  infoEl.style.cssText = "flex:1;min-width:0;";

  const assignedIdentity = det.identity_id !== null ? identities.find((i: any) => i.id === det.identity_id) : null;
  const dropdownId = `det-ac-${det.id}`;

  if (assignedIdentity) {
    infoEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <div style="position:relative;display:inline-block;">
          <input class="det-name-input" value="${assignedIdentity.name}" style="font-weight:600;font-size:11px;padding:1px 4px;border:1px solid transparent;border-radius:2px;background:transparent;width:140px;" autocomplete="off" />
          <div id="${dropdownId}" class="autocomplete-dropdown" style="display:none;"></div>
        </div>
        <span style="color:#888;">(${(det.confidence * 100).toFixed(1)}%)</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
        <select class="win-select detection-identity-select" data-detection-id="${det.id}" style="font-size:10px;padding:1px 4px;max-width:150px;">
          <option value="">Unassigned</option>
          ${identities.map((i: any) => `<option value="${i.id}" ${det.identity_id === i.id ? "selected" : ""}>${i.name}</option>`).join("")}
        </select>
      </div>
    `;
    const nameInput = infoEl.querySelector(".det-name-input") as HTMLInputElement;
    attachAutocomplete({
      input: nameInput,
      dropdownId,
      onSelect: async (newName) => {
        if (newName !== assignedIdentity.name) {
          await callService({ RenameCharacterIdentity: { identity_id: assignedIdentity.id, name: newName } });
          await loadDetectionsForImage(imageId);
          await refreshCharacters();
        }
      },
      fetchItems: async (query) => {
        const { getSuggestions } = await import("./views/characters");
        const suggestions = await getSuggestions(query);
        return suggestions.map((s) => ({ name: s.name, count: s.count }));
      },
    });
    nameInput.addEventListener("blur", async () => {
      const newName = nameInput.value.trim();
      if (newName && newName !== assignedIdentity.name) {
        await callService({ RenameCharacterIdentity: { identity_id: assignedIdentity.id, name: newName } });
        await loadDetectionsForImage(imageId);
        await refreshCharacters();
      }
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
    });
  } else {
    infoEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-weight:600;color:#888;">Unassigned</span>
        <span style="color:#888;">(${(det.confidence * 100).toFixed(1)}%)</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
        <select class="win-select detection-identity-select" data-detection-id="${det.id}" style="font-size:10px;padding:1px 4px;max-width:150px;">
          <option value="">Unassigned</option>
          ${identities.map((i: any) => `<option value="${i.id}">${i.name}</option>`).join("")}
        </select>
      </div>
    `;
  }

  detEl.appendChild(cropThumb);
  detEl.appendChild(infoEl);

  const actionsEl = document.createElement("div");
  actionsEl.style.cssText = "display:flex;gap:4px;margin-left:auto;align-items:center;";
  actionsEl.innerHTML = `
    <button class="win-button edit-bbox-btn" style="font-size:10px;padding:2px 6px;" title="Edit bounding box">
      <i class="bi bi-bounding-box"></i>
    </button>
    <button class="win-button danger delete-det-btn" style="font-size:10px;padding:2px 6px;" title="Delete detection">
      <i class="bi bi-trash"></i>
    </button>
  `;
  detEl.appendChild(actionsEl);

  actionsEl.querySelector(".edit-bbox-btn")?.addEventListener("click", () => {
    callService({ GetImage: { image_id: imageId } }).then((imgResp: any) => {
      if ("ImageResult" in imgResp) {
        const fp = imgResp.ImageResult.image.current_filepath;
        import("./bbox-editor").then(m => {
          m.openBBoxEditor(det.id, imageId, fp, det.x0, det.y0, det.x1, det.y1, () => {
            invalidateCropCache(det.id);
            loadDetectionsForImage(imageId);
            refreshCharacters();
          });
        });
      }
    });
  });

  actionsEl.querySelector(".delete-det-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete this detection? This will remove it from the system.")) return;
    await callService({ DeleteDetection: { detection_id: det.id } });
    loadDetectionsForImage(imageId);
    refreshCharacters();
  });

  const select = detEl.querySelector(".detection-identity-select") as HTMLSelectElement;
  select?.addEventListener("change", async () => {
    const val = select.value;
    const identityId = val ? parseInt(val, 10) : null;
    await callService({ AssignCharacterIdentity: { detection_id: det.id, identity_id: identityId } });
    await loadDetectionsForImage(imageId);
    await refreshCharacters();
  });

  return detEl;
}

// --- Card Rendering (no per-card event handlers) ---

export function renderCards(cards: CardImageData[], grid: HTMLElement) {
  grid.innerHTML = "";

  const fragment = document.createDocumentFragment();

  cards.forEach((img) => {
    const card = document.createElement("div");
    card.className = `image-card ${selectedImageIds.has(img.id) ? 'selected' : ''}`;
    card.dataset.imageId = img.id.toString();
    card.dataset.filepath = img.filepath;

    const tagHtml = renderTagListHtml(img.tags);
    const parsedHtml = img.parsedMetadata ? renderParsedMetadataHtml(img.parsedMetadata) : "";

    const missingBadge = img.isMissing
      ? '<div class="badge-missing"><i class="bi bi-exclamation-triangle"></i> Missing</div>'
      : "";

        // Pre-populate GIF path in cache to avoid flash/delay
    const isGif = /\.gif$/i.test(img.filepath);
    if (isGif && !thumbCache.has(img.id)) {
      cacheThumbnail(img.id, convertFileSrc(img.filepath));
    }

    const cachedSrc = thumbCache.get(img.id);
    const isCached = cachedSrc !== undefined;
    const isPending = !isCached;
    const imgClass = isCached ? "loaded" : "";
    const previewClass = isCached ? "image-preview" : "image-preview thumb-loading";
    const srcAttr = isCached ? `src="${cachedSrc}"` : "";

    card.innerHTML = `
      <input type="checkbox" class="card-select-checkbox" data-id="${img.id}" ${selectedImageIds.has(img.id) ? 'checked' : ''} />
      <div class="star-btn ${img.favorite ? 'favorite' : ''}" data-id="${img.id}">
        <i class="bi ${img.favorite ? 'bi-star-fill' : 'bi-star'}"></i>
      </div>
      <div class="${previewClass}">
        <img data-thumb-id="${img.id}" data-filepath="${img.filepath}" data-pending="${isPending ? '1' : '0'}" ${srcAttr} alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" class="${imgClass}" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        ${missingBadge}
        ${img.badgeHtml || ""}
        <div class="copy-btn" title="Copy image to clipboard"><i class="bi bi-clipboard"></i></div>
        <div class="info-btn" title="View image details" data-id="${img.id}"><i class="bi bi-info-circle"></i></div>
      </div>
      <div class="image-info">
        <div class="image-path-row">
          <div class="image-path" title="${img.filepath}">${maskPath(img.filepath)}</div>
          <button class="win-button image-open-folder-btn" style="display: none; font-size: 10px; padding: 1px 6px; white-space: nowrap;" title="Open containing folder">
            <i class="bi bi-folder2-open"></i>
          </button>
        </div>
        ${parsedHtml ? `<div class="parsed-metadata-list" style="border-bottom: 1px solid var(--sys-border-light, #d0d0d0); padding-bottom: 6px; margin-bottom: 6px;">${parsedHtml}</div>` : ""}
        <div class="tag-list">
          ${tagHtml}
        </div>
        <div style="display: flex; gap: 4px; margin-top: auto; width: 100%;">
          <button class="win-button" style="font-size: 11px; flex: 1;" data-action="open-tags" data-id="${img.id}" data-filepath="${img.filepath.replace(/\\/g, '\\\\')}">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" data-action="find-similar" data-filepath="${img.filepath.replace(/\\/g, '\\\\')}">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
    `;

    fragment.appendChild(card);
  });

  grid.appendChild(fragment);

  // Clear stale queue, bump generation, reset progress
  generation++;
  queue.length = 0;
  if (thumbHideTimer) { clearTimeout(thumbHideTimer); thumbHideTimer = null; }
  thumbTotal = grid.querySelectorAll<HTMLElement>("img[data-thumb-id]").length;
  thumbLoaded = grid.querySelectorAll<HTMLElement>("img[data-thumb-id][data-pending='0']").length;
  updateThumbProgress();

  grid.querySelectorAll<HTMLElement>("img[data-thumb-id][data-pending='1']").forEach(img => {
    lazyObserver.observe(img);
  });
}

export function renderImages(images: ImageDetails[], gridId: string) {
  const grid = document.getElementById(gridId);
  if (!grid) return;


  if (images.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No images imported yet.</p>";
    return;
  }

  const cards: CardImageData[] = images.map(img => ({
    id: img.id,
    filepath: img.current_filepath,
    tags: img.tags,
    favorite: img.favorite,
    badgeHtml: `<div class="vector-badge ${img.vector_state === "ready" ? "badge-ready" : "badge-pending"}">${img.vector_state}</div>`,
    parsedMetadata: img.parsed_metadata,
    isMissing: img.is_missing,
  }));

  renderCards(cards, grid);
}

export function renderSearchResults(matches: SearchMatch[]) {
  const grid = document.getElementById("search-results-grid");
  if (!grid) return;

  if (matches.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No matching results found.</p>";
    return;
  }

  const cards: CardImageData[] = matches.map(m => {
    const badgeBg = m.match_type === "exact" ? "#dff6dd" : m.match_type === "perceptual" ? "#deecf9" : "#f3f2f1";
    const badgeColor = m.match_type === "exact" ? "#107c41" : m.match_type === "perceptual" ? "#005a9e" : "#323130";
    const badgeBorder = m.match_type === "exact" ? "#107c41" : m.match_type === "perceptual" ? "#005a9e" : "#8a8886";
    const scoreBadgeText = m.match_type === "exact" ? "Exact Match" : m.match_type === "perceptual" ? `Perceptual (d=${m.hamming_distance})` : `Score: ${m.score.toFixed(4)}`;
    return {
      id: m.id,
      filepath: m.filepath,
      tags: m.tags,
      badgeHtml: `<div class="vector-badge" style="background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor};">${scoreBadgeText}</div>`,
      emptyMessage: "No matching results found.",
      parsedMetadata: m.parsed_metadata,
    };
  });

  renderCards(cards, grid);
}

// --- Browse Button Helper ---

export function setupBrowseButton(btnId: string, targetInput: HTMLInputElement, isDirectory: boolean) {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory });
      if (selected) {
        targetInput.value = selected;
        targetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (err) {
      console.error(`${isDirectory ? "Folder" : "File"} dialog error: `, err);
    }
  });
}
