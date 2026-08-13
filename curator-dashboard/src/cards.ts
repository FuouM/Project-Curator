import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { renderGalleryCardHtml, renderOcrBlockHtml } from "./components/gallery-card";
import type { GalleryCardViewData } from "./components/gallery-card";
import { openImageInfoModal } from "./components/image-info-modal";
import { CardImageData, ImageDetails, SearchMatch } from "./types";
import { imageBytesToPngBlob } from "./utils";
import { getImageClickAction, isSelectMode, selectedImageIds, luckyHighlightId, formatCopiedTags, getGalleryFullImages } from "./state";
import { openImageViewer } from "./image-viewer";
import { typedCall } from "./ipc";
import { openTagModal } from "./components/tag-editor-modal";
import { findSimilar } from "./views/concepts";
import { LruCache } from "./lru-cache";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  GetImageRequestSchema,
  ImageResultSchema,
  SetFavoriteRequestSchema,
} from "./gen/gallery_pb";
import { imageDetailsFromProto } from "./proto-adapters";
import { applyNsfwToCard, loadNsfwPrefs } from "./nsfw";

// --- Thumbnail Queue ---
const MAX_CONCURRENT = 2;
let generation = 0;
let activeCount = 0;
let thumbTotal = 0;
let thumbLoaded = 0;
let thumbHideTimer: number | null = null;

// --- Thumbnail Cache (LRU, limited to 5000 entries) ---
const thumbCache = new LruCache<string>(5000);

function cacheThumbnail(imageId: number, url: string) {
  thumbCache.set(imageId, url);
}

export function invalidateThumbnailCache() {
  thumbCache.clear();
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
  if (!job.img.isConnected) {
    activeCount--;
    if (thumbTotal > 0) {
      thumbLoaded++;
      updateThumbProgress();
    }
    processQueue();
    return;
  }

  const cachedUrl = thumbCache.get(job.imageId);
  if (cachedUrl) {
    job.img.src = cachedUrl;
    job.img.classList.add("loaded");
    if (job.preview) job.preview.classList.remove("thumb-loading");
    maybeSwapFullImage();
    if (thumbTotal > 0) {
      thumbLoaded++;
      updateThumbProgress();
    }
    activeCount--;
    processQueue();
    return;
  }

  invoke("get_thumbnail", { imageId: job.imageId }).then((data: any) => {
    if (!data) return;
    const bytes = new Uint8Array(data);
    const blob = new Blob([bytes], { type: "image/webp" });
    const url = URL.createObjectURL(blob);
    cacheThumbnail(job.imageId, url);
    if (job.img.isConnected) {
      job.img.src = url;
      job.img.classList.add("loaded");
      maybeSwapFullImage();
    }
  }).catch(() => {}).finally(() => {
    if (job.preview) job.preview.classList.remove("thumb-loading");
    if (thumbTotal > 0) {
      thumbLoaded++;
      updateThumbProgress();
    }
    activeCount--;
    processQueue();
  });
}

const fullImageCache = new LruCache<string>(1000);
let scrollDebounceTimer: number | null = null;
let isScrolling = false;

// Attach passive scroll listener to .main-panel to detect scrolling activity
if (typeof window !== "undefined") {
  const handleScroll = () => {
    isScrolling = true;
    revertOffscreenFullImagesToThumbnails();
    if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = window.setTimeout(() => {
      isScrolling = false;
      if (window.requestIdleCallback) {
        window.requestIdleCallback(() => processVisibleFullImages());
      } else {
        setTimeout(processVisibleFullImages, 50);
      }
    }, 200);
  };

  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
}

let fullTotal = 0;
let fullLoaded = 0;
let fullHideTimer: number | null = null;

function updateFullImageProgress() {
  const cell = document.getElementById("full-progress-cell");
  const text = document.getElementById("full-progress-text");
  const fill = document.getElementById("full-progress-fill");
  if (!cell || !text || !fill) return;

  if (!getGalleryFullImages() || fullTotal === 0) {
    cell.style.display = "none";
    return;
  }

  cell.style.display = "flex";
  text.textContent = `${fullLoaded}/${fullTotal}`;
  fill.style.width = `${Math.round((fullLoaded / fullTotal) * 100)}%`;

  if (fullLoaded >= fullTotal) {
    if (fullHideTimer) clearTimeout(fullHideTimer);
    fullHideTimer = window.setTimeout(() => { cell.style.display = "none"; }, 1000);
  }
}

export function processVisibleFullImages() {
  if (!getGalleryFullImages() || isScrolling) return;

  const visibleImgs = Array.from(document.querySelectorAll<HTMLImageElement>(".image-grid img[data-thumb-id]"));
  const vh = window.innerHeight;

  // Filter to visible candidates
  const candidates = visibleImgs.filter((img) => {
    const imageId = parseInt(img.dataset.thumbId || "0", 10);
    const fp = img.dataset.filepath || "";
    const isVideo = img.dataset.isVideo === "1";
    if (imageId === 0 || !fp || isVideo) return false;
    if (img.dataset.fullLoaded === "1" || img.dataset.fullLoading === "1") return false;

    const rect = img.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= vh;
  });

  if (candidates.length === 0) {
    updateFullImageProgress();
    return;
  }

  fullTotal = candidates.length;
  fullLoaded = 0;
  if (fullHideTimer) { clearTimeout(fullHideTimer); fullHideTimer = null; }
  updateFullImageProgress();

  // Load sequentially one image at a time to prevent GPU frame drops
  let idx = 0;
  function loadNext() {
    if (isScrolling || idx >= candidates.length) return;
    const img = candidates[idx++];
    const imageId = parseInt(img.dataset.thumbId || "0", 10);
    const fp = img.dataset.filepath || "";

    img.dataset.fullLoading = "1";
    const fullUrl = fullImageCache.get(imageId) || convertFileSrc(fp);
    fullImageCache.set(imageId, fullUrl);

    const preloader = new Image();
    preloader.onload = () => {
      if (img.isConnected && !isScrolling) {
        img.src = fullUrl;
        img.dataset.fullLoaded = "1";
      }
      img.dataset.fullLoading = "0";
      fullLoaded++;
      updateFullImageProgress();
      if (!isScrolling) setTimeout(loadNext, 30);
    };
    preloader.onerror = () => {
      img.dataset.fullLoading = "0";
      fullLoaded++;
      updateFullImageProgress();
      if (!isScrolling) setTimeout(loadNext, 30);
    };
    preloader.src = fullUrl;
  }

  loadNext();
}

// Revert off-screen full images back to light thumbnails when user starts scrolling
function revertOffscreenFullImagesToThumbnails() {
  const allImgs = document.querySelectorAll<HTMLImageElement>(".image-grid img[data-full-loaded='1']");
  const vh = window.innerHeight;

  allImgs.forEach((img) => {
    const rect = img.getBoundingClientRect();
    if (rect.bottom < -200 || rect.top > vh + 200) {
      const imageId = parseInt(img.dataset.thumbId || "0", 10);
      const thumbUrl = thumbCache.get(imageId);
      if (thumbUrl) {
        img.src = thumbUrl;
        img.dataset.fullLoaded = "0";
      }
    }
  });
}

function maybeSwapFullImage() {
  if (!getGalleryFullImages() || isScrolling) return;

  // If scroll is stationary right now, schedule a check
  if (scrollDebounceTimer === null) {
    scrollDebounceTimer = window.setTimeout(() => {
      scrollDebounceTimer = null;
      processVisibleFullImages();
    }, 150);
  }
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
const observedThumbs = new Set<HTMLImageElement>();

const lazyObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const img = entry.target as HTMLImageElement;
    const imageId = parseInt(img.dataset.thumbId || "0", 10);
    if (imageId === 0) continue;
    const preview = img.closest(".image-preview") as HTMLElement;
    const fp = img.dataset.filepath || "";

    if (entry.isIntersecting) {
      if (img.dataset.pending === "1" || !img.getAttribute("src")) {
        const cachedUrl = thumbCache.get(imageId);
        if (cachedUrl) {
          img.src = cachedUrl;
          img.classList.add("loaded");
          img.dataset.pending = "0";
          if (preview) preview.classList.remove("thumb-loading");
          maybeSwapFullImage();
          if (thumbTotal > 0) {
            thumbLoaded++;
            updateThumbProgress();
          }
        } else {
          img.dataset.pending = "0";
          if (/\.gif$/i.test(fp)) {
            img.src = convertFileSrc(fp);
            img.classList.add("loaded");
            if (preview) preview.classList.remove("thumb-loading");
            if (thumbTotal > 0) {
              thumbLoaded++;
              updateThumbProgress();
            }
          } else {
            if (preview) preview.classList.add("thumb-loading");
            queue.push({ imageId, img, preview, gen: generation });
            processQueue();
          }
        }
      }
    } else {
      // Unload if scrolled out of view and has a loaded src that is a blob URL
      const src = img.getAttribute("src");
      if (src && src.startsWith("blob:")) {
        img.removeAttribute("src");
        img.classList.remove("loaded");
        img.dataset.pending = "1";
        img.dataset.fullLoaded = "0";
        if (preview) preview.classList.remove("thumb-loading");
      }
    }
  }
}, { rootMargin: "600px" });

export function reobserveUnloadedThumbnails(container: HTMLElement) {
  const imgs = container.querySelectorAll<HTMLImageElement>("img[data-thumb-id]");
  imgs.forEach(img => {
    const imageId = parseInt(img.dataset.thumbId || "0", 10);
    if (imageId <= 0) return;

    const cachedUrl = thumbCache.get(imageId);
    if (cachedUrl) {
      if (img.src !== cachedUrl) {
        img.src = cachedUrl;
        img.classList.add("loaded");
        img.dataset.pending = "0";
        const preview = img.closest(".image-preview") as HTMLElement;
        if (preview) preview.classList.remove("thumb-loading");
      }
      return;
    }

    if (!img.classList.contains("loaded")) {
      img.dataset.pending = "1";
      observedThumbs.add(img);
      lazyObserver.observe(img);
    }
  });
}

function clearObservedThumbs() {
  if (observedThumbs.size === 0) return;
  for (const el of observedThumbs) {
    lazyObserver.unobserve(el);
  }
  observedThumbs.clear();
}

// --- Tag / Metadata renders moved to ./components/card-tags (see implementation_plan_cards.md) ---


// --- Event Delegation (one listener per grid, not per card) ---

// ---------------------------------------------------------------------------
// Plugin Right-Click Context Menu (D2) — global delegator covering all grids
// ---------------------------------------------------------------------------

let globalContextMenuSetup = false;

export function setupGlobalContextMenu() {
  if (globalContextMenuSetup) return;
  globalContextMenuSetup = true;

  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest(".image-card") as HTMLElement | null;
    if (!card) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, card);
  });

  document.addEventListener("mousedown", (e) => {
    const menu = document.getElementById("plugin-context-menu");
    if (!menu) return;
    const target = e.target as HTMLElement;
    if (!menu.contains(target)) hideContextMenu();
  });
}

function ensureContextMenuEl(): HTMLElement {
  let menu = document.getElementById("plugin-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "plugin-context-menu";
    menu.className = "plugin-context-menu";
    menu.style.display = "none";
    document.body.appendChild(menu);
  }
  return menu;
}

function hideContextMenu() {
  const menu = document.getElementById("plugin-context-menu");
  if (menu) menu.style.display = "none";
}

function positionContextMenu(menu: HTMLElement, x: number, y: number) {
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.min(x, maxX)}px`;
  menu.style.top = `${Math.min(y, maxY)}px`;
}

function showContextMenu(x: number, y: number, card: HTMLElement) {
  const imageId = parseInt(card.dataset.imageId || "0", 10);
  const filepath = card.dataset.filepath || "";
  if (!imageId) return;

  const menu = ensureContextMenuEl();
  menu.innerHTML = "";

  const coreItems: Array<{ label: string; icon: string; onClick: () => void }> = [
    { label: "Open Image", icon: "bi bi-eye", onClick: () => openImageViewer(filepath, imageId) },
    { label: "Copy Image", icon: "bi bi-clipboard", onClick: () => handleCopyClick(card, imageId) },
    { label: "Image Details", icon: "bi bi-info-circle", onClick: () => handleInfoClick(imageId) },
  ];

  for (const item of coreItems) {
    const el = document.createElement("div");
    el.className = "plugin-context-item";
    el.innerHTML = `<i class="${item.icon}"></i> ${item.label}`;
    el.addEventListener("click", () => {
      hideContextMenu();
      item.onClick();
    });
    menu.appendChild(el);
  }

  const pluginItems = window.PluginHost?.getContextMenuItems() || [];
  if (pluginItems.length > 0) {
    const sep = document.createElement("div");
    sep.className = "plugin-context-separator";
    menu.appendChild(sep);

    for (const item of pluginItems) {
      const el = document.createElement("div");
      el.className = "plugin-context-item";
      el.textContent = item.label;
      el.addEventListener("click", async () => {
        hideContextMenu();
        try {
          const asset = await window.PluginHost.fetchAssetContext(imageId);
          item.fn(asset);
        } catch (e) {
          console.error("Plugin context-menu action failed:", e);
        }
      });
      menu.appendChild(el);
    }
  }

  menu.style.display = "block";
  positionContextMenu(menu, x, y);
}

export function setupGridDelegation(grid: HTMLElement) {
  grid.addEventListener("mousedown", trackOcrMouseDown);
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
      invoke("reveal_in_folder", { path: filepath }).catch(() => {});
      return;
    }

    const actionBtn = target.closest("[data-action]") as HTMLElement;
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const fp = card.dataset.filepath || "";
      if (action === "copy-ocr") {
        handleOcrCopy(actionBtn);
        return;
      }
      if (action === "copy-tags") {
        handleCardTagsCopy(actionBtn);
        return;
      }
      if (action === "open-tags") {
        openTagModal(imageId, fp);
      } else if (action === "find-similar") {
        findSimilar(fp);
      } else if (action === "toggle-ocr") {
        toggleOcrIfClick(actionBtn, e);
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
): () => void {
  const handler = (e: Event) => {
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
      invoke("reveal_in_folder", { path: filepath }).catch(() => {});
      return;
    }
    if (target.closest(".image-path")) {
      const btn = container.querySelector(".image-open-folder-btn") as HTMLElement;
      if (btn) btn.style.display = btn.style.display === "none" ? "inline-flex" : "none";
      return;
    }
    if (target.closest("[data-action='copy-ocr']")) {
      handleOcrCopy(target.closest("[data-action='copy-ocr']") as HTMLElement);
      return;
    }
    if (target.closest("[data-action='copy-tags']")) {
      handleCardTagsCopy(target.closest("[data-action='copy-tags']") as HTMLElement);
      return;
    }
    if (target.closest("[data-action='toggle-ocr']")) {
      const block = target.closest("[data-action='toggle-ocr']") as HTMLElement;
      toggleOcrIfClick(block, e as MouseEvent);
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
  };
  container.addEventListener("mousedown", trackOcrMouseDown);
  container.addEventListener("click", handler);
  return () => {
    container.removeEventListener("click", handler);
    container.removeEventListener("mousedown", trackOcrMouseDown);
  };
}

// OCR-block expand/collapse guard: a drag (text selection) must not collapse an
// expanded block; only a stationary single click toggles it.
const OCR_DRAG_PX = 5;
const ocrDownPos = new WeakMap<HTMLElement, { x: number; y: number }>();

function trackOcrMouseDown(e: globalThis.MouseEvent) {
  const block = (e.target as HTMLElement).closest("[data-action='toggle-ocr']") as HTMLElement | null;
  if (block) ocrDownPos.set(block, { x: e.clientX, y: e.clientY });
}

function toggleOcrIfClick(block: HTMLElement, e: globalThis.MouseEvent) {
  const start = ocrDownPos.get(block);
  if (start) {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx * dx + dy * dy >= OCR_DRAG_PX * OCR_DRAG_PX) return; // dragged -> selection, keep expanded
  }
  block.classList.toggle("expanded");
}

function handleOcrCopy(icon: HTMLElement) {
  const text = icon.dataset.ocrCopy || "";
  if (!text) return;
  const originalHtml = icon.innerHTML;
  navigator.clipboard.writeText(text)
    .then(() => {
      icon.innerHTML = '<i class="bi bi-check-lg"></i>';
      icon.classList.add("copied");
      setTimeout(() => {
        icon.innerHTML = originalHtml;
        icon.classList.remove("copied");
      }, 1500);
    })
    .catch(() => {});
}

function handleCardTagsCopy(btn: HTMLElement) {
  const text = formatCopiedTags(btn.dataset.copyTags || "");
  if (!text) return;
  const originalHtml = btn.innerHTML;
  navigator.clipboard.writeText(text)
    .then(() => {
      btn.innerHTML = '<i class="bi bi-check-lg"></i>';
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.classList.remove("copied");
      }, 1500);
    })
    .catch(() => {});
}

function handleStarClick(card: HTMLElement, imageId: number) {
  const starBtn = card.querySelector(".star-btn");
  if (!starBtn) return;
  const newFav = !starBtn.classList.contains("favorite");

  typedCall("GalleryService.SetFavorite", SetFavoriteRequestSchema, { imageId: BigInt(imageId), favorite: newFav }, EmptySchema).then(() => {
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
  typedCall("GalleryService.GetImage", GetImageRequestSchema, { imageId: BigInt(imageId) }, ImageResultSchema).then((resp) => {
    if (resp.image) {
      openImageInfoModal(imageDetailsFromProto(resp.image));
    }
  }).catch(() => {});
}

// --- Card Rendering (no per-card event handlers) ---

export function renderCards(cards: CardImageData[], grid: HTMLElement, append = false) {
  if (!append) {
    clearObservedThumbs();
    grid.innerHTML = "";
  } else {
    // If the grid was displaying a "no images" placeholder, clear it
    if (grid.children.length === 1 && grid.firstElementChild?.tagName === "P") {
      grid.innerHTML = "";
    }
  }

  const fragment = document.createDocumentFragment();

  cards.forEach((img) => {
    const cachedSrc = thumbCache.get(img.id);
    const isGif = /\.gif$/i.test(img.filepath);

    // Pre-populate GIF path in cache to avoid flash/delay
    if (isGif && !cachedSrc) {
      cacheThumbnail(img.id, convertFileSrc(img.filepath));
    }

    const viewData: GalleryCardViewData = {
      id: img.id,
      filepath: img.filepath,
      tags: img.tags,
      isSelected: selectedImageIds.has(img.id),
      isFavorite: img.favorite ?? false,
      isMissing: img.isMissing ?? false,
      isLucky: luckyHighlightId === img.id,
      cachedThumbSrc: thumbCache.get(img.id),
      ocrText: img.ocrText,
      parsedMetadata: img.parsedMetadata,
      characterIdentities: img.characterIdentities,
      video: img.video ? {
        format: img.video.format,
        durationMs: img.video.duration_ms,
        codec: img.video.video_codec,
      } : undefined,
      badgeHtml: img.badgeHtml,
      width: img.width ?? undefined,
      height: img.height ?? undefined,
      safety: img.safety,
    };

    // Render pure element string, convert to HTML, and append
    const host = document.createElement("div");
    host.innerHTML = renderGalleryCardHtml(viewData).trim();
    const cardNode = host.firstElementChild as HTMLElement;

    if (img.safety) {
      cardNode.dataset.nsfw = JSON.stringify(img.safety);
      applyNsfwToCard(cardNode, img.safety, loadNsfwPrefs());
    }

    // Observe new image elements before appending (appending empties the fragment)
    cardNode.querySelectorAll<HTMLImageElement>("img[data-thumb-id]").forEach(imgEl => {
      observedThumbs.add(imgEl);
      lazyObserver.observe(imgEl);
    });

    fragment.appendChild(cardNode);
  });

  grid.appendChild(fragment);

  // Prune disconnected jobs from queue to free unmounted DOM references
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!queue[i].img.isConnected) {
      queue.splice(i, 1);
    }
  }
  if (thumbHideTimer) { clearTimeout(thumbHideTimer); thumbHideTimer = null; }
  const pendingCount = cards.filter(c => !thumbCache.has(c.id) && !/\.gif$/i.test(c.filepath)).length;
  thumbTotal = pendingCount;
  thumbLoaded = 0;
  updateThumbProgress();
}

export function renderImages(images: ImageDetails[], gridId: string, append = false) {
  const grid = document.getElementById(gridId);
  if (!grid) return;


  if (images.length === 0) {
    if (!append) {
      grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No images imported yet.</p>";
    }
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
    characterIdentities: img.character_identities,
    ocrText: img.ocr_text,
    animation: img.animation,
    video: img.video,
    width: img.width ?? undefined,
    height: img.height ?? undefined,
    safety: {
      safe_score: img.safe_score,
      hentai_score: img.hentai_score,
      porn_score: img.porn_score,
      sexy_score: img.sexy_score,
      drawing_score: img.drawing_score,
    },
  }));

  renderCards(cards, grid, append);
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
      favorite: m.favorite,
      badgeHtml: `<div class="vector-badge" style="background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor};">${scoreBadgeText}</div>`,
      emptyMessage: "No matching results found.",
      parsedMetadata: m.parsed_metadata,
      isMissing: m.is_missing,
      ocrText: m.ocr_text,
      characterIdentities: m.character_identities,
      animation: m.animation,
      video: m.video,
      width: m.width ?? undefined,
      height: m.height ?? undefined,
      safety: {
        safe_score: m.safe_score,
        hentai_score: m.hentai_score,
        porn_score: m.porn_score,
        sexy_score: m.sexy_score,
        drawing_score: m.drawing_score,
      },
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

export function refreshCardOcr(imageId: number, ocrText: string) {
  const cards = document.querySelectorAll(`[data-image-id="${imageId}"]`);
  cards.forEach(card => {
    const info = card.querySelector<HTMLElement>(".image-info, .featured-details");
    if (!info) return;

    const existing = info.querySelector(".ocr-block");
    if (ocrText) {
      const html = renderOcrBlockHtml(ocrText);
      if (existing) {
        existing.outerHTML = html;
      } else {
        const anchor = info.querySelector(".identity-list") ?? info.querySelector(".card-tags-container");
        if (anchor) {
          anchor.insertAdjacentHTML("beforebegin", html);
        } else {
          info.insertAdjacentHTML("beforeend", html);
        }
      }
    } else if (existing) {
      existing.remove();
    }
  });
}
