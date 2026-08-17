/**
 * UI rendering, canvas compositing, and event handling for image-compare.
 */

import { state, TAB_ID } from "./state";
import {
  navigateToTab as _navigateToTab,
  closeInfoModal,
  setupDropZone as _setupDropZone,
  formatBytes,
} from "../../lib";

const PH = window.PluginHost;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export const navigateToTab = (): void => _navigateToTab(TAB_ID);
export { closeInfoModal };

function getAssetSrc(path: string): string {
  if (!path) return "";
  if (
    path.startsWith("blob:") ||
    path.startsWith("data:") ||
    path.startsWith("http://") ||
    path.startsWith("https://")
  ) {
    return path;
  }
  return PH.convertFileSrc(path);
}

function loadImageMetadata(slot: typeof state.slotA, callback?: () => void): void {
  if (!slot.url) {
    slot.width = 0;
    slot.height = 0;
    if (callback) callback();
    return;
  }
  const img = new Image();
  img.onload = () => {
    slot.width = img.naturalWidth;
    slot.height = img.naturalHeight;
    if (callback) callback();
  };
  img.onerror = (err) => {
    console.error("Image Compare: failed to load image src:", slot.path, err);
    if (callback) callback();
  };
  img.src = slot.url;
}

export function loadAssetIntoSlot(
  targetSlot: "A" | "B",
  assetContext: { path: string; asset_id?: number } | null,
  fileObj?: File
): void {
  ensureCompareMounted();
  const slotObj = targetSlot === "A" ? state.slotA : state.slotB;
  if (fileObj) {
    slotObj.id = null;
    const filePath = (fileObj as any).path || "";
    slotObj.path = filePath || fileObj.name;
    if (filePath) {
      slotObj.url = getAssetSrc(filePath);
    } else {
      slotObj.url = URL.createObjectURL(fileObj);
    }
    slotObj.name = fileObj.name;
    slotObj.sizeStr = formatBytes(fileObj.size);
  } else if (assetContext) {
    slotObj.id = assetContext.asset_id || null;
    slotObj.path = assetContext.path || "";
    slotObj.name = assetContext.path
      ? assetContext.path.split(/[\\/]/).pop()!
      : "Asset #" + assetContext.asset_id;
    slotObj.url = getAssetSrc(slotObj.path);
    slotObj.sizeStr = "";
  }

  loadImageMetadata(slotObj, () => {
    updateSlotHeaders();
    renderCanvasDOM();
  });
}

function swapSlots(): void {
  const temp = Object.assign({}, state.slotA);
  Object.assign(state.slotA, state.slotB);
  Object.assign(state.slotB, temp);
  updateSlotHeaders();
  renderCanvasDOM();
}

function resetZoomAndPan(): void {
  state.zoomA = 1.0;
  state.panA = { x: 0, y: 0 };
  state.zoomB = 1.0;
  state.panB = { x: 0, y: 0 };
  scheduleTransformUpdate();
}

function fitToViewport(): void {
  state.zoomA = 1.0;
  state.panA = { x: 0, y: 0 };
  state.zoomB = 1.0;
  state.panB = { x: 0, y: 0 };
  scheduleTransformUpdate();
}

// ── High Performance GPU Transform Pipeline ─────────────────────────────
export function scheduleTransformUpdate(): void {
  if (state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(() => {
    state.rafPending = false;
    applyTransforms();
  });
}

function applyTransforms(): void {
  const clipVal = 100 - state.splitPos;
  const container = el("compare-canvas-area");
  const rect = container ? container.getBoundingClientRect() : null;

  if (state.mode === "side-by-side") {
    const wrapperA = el("cmp-wrapper-a");
    if (wrapperA) {
      wrapperA.style.transform = `translate(${state.panA.x}px, ${state.panA.y}px) scale(${state.zoomA})`;
    }
    const wrapperB = el("cmp-wrapper-b");
    if (wrapperB) {
      const activePan = state.syncLock ? state.panA : state.panB;
      const activeZoom = state.syncLock ? state.zoomA : state.zoomB;
      wrapperB.style.transform = `translate(${activePan.x}px, ${activePan.y}px) scale(${activeZoom})`;
    }
  } else {
    const sharedWrapper = el("cmp-wrapper-shared");
    if (sharedWrapper) {
      sharedWrapper.style.transform = `translate(${state.panA.x}px, ${state.panA.y}px) scale(${state.zoomA})`;
    }

    const wrapperA = el("cmp-wrapper-a");
    if (wrapperA) {
      wrapperA.style.transform = `translate(${state.panA.x}px, ${state.panA.y}px) scale(${state.zoomA})`;
    }

    const wrapperB = el("cmp-wrapper-b");
    if (wrapperB) {
      const activePan = state.syncLock ? state.panA : state.panB;
      const activeZoom = state.syncLock ? state.zoomA : state.zoomB;
      wrapperB.style.transform = `translate(${activePan.x}px, ${activePan.y}px) scale(${activeZoom})`;
    }

    const layerB = el("cmp-layer-b-pinned") || el("cmp-layer-b");
    if (layerB) {
      if (state.mode === "h-slider") {
        layerB.style.clipPath = `inset(0 ${clipVal}% 0 0)`;
        layerB.style.opacity = "1";
      } else if (state.mode === "v-slider") {
        layerB.style.clipPath = `inset(0 0 ${clipVal}% 0)`;
        layerB.style.opacity = "1";
      } else if (state.mode === "onion") {
        layerB.style.clipPath = "none";
        layerB.style.opacity = (state.onionOpacity / 100).toString();
      } else {
        layerB.style.clipPath = "none";
        layerB.style.opacity = "1";
      }
    }

    if (state.pinSplitterToImage && rect) {
      if (state.mode === "h-slider") {
        const handleH = el("cmp-handle-h");
        if (handleH) {
          const center = rect.width / 2;
          const localX = rect.width * (state.splitPos / 100);
          const screenX = (localX - center) * state.zoomA + center + state.panA.x;
          handleH.style.left = `calc(${screenX}px - 12px)`;
        }
      } else if (state.mode === "v-slider") {
        const handleV = el("cmp-handle-v");
        if (handleV) {
          const center = rect.height / 2;
          const localY = rect.height * (state.splitPos / 100);
          const screenY = (localY - center) * state.zoomA + center + state.panA.y;
          handleV.style.top = `calc(${screenY}px - 12px)`;
        }
      }
    } else {
      if (state.mode === "h-slider") {
        const handleH = el("cmp-handle-h");
        if (handleH) handleH.style.left = `calc(${state.splitPos}% - 12px)`;
      } else if (state.mode === "v-slider") {
        const handleV = el("cmp-handle-v");
        if (handleV) handleV.style.top = `calc(${state.splitPos}% - 12px)`;
      }
    }
  }

  const valEl = el("cmp-zoom-val");
  if (valEl) valEl.textContent = Math.round(state.zoomA * 100) + "%";

  const infoA = el("cmp-info-overlay-a");
  if (infoA) {
    infoA.textContent = `A: ${state.slotA.width}×${state.slotA.height} | Zoom: ${Math.round(state.zoomA * 100)}%`;
  }

  const infoB = el("cmp-info-overlay-b");
  if (infoB) {
    infoB.textContent = `B: ${state.slotB.width}×${state.slotB.height} | Zoom: ${Math.round(
      (state.syncLock ? state.zoomA : state.zoomB) * 100
    )}%`;
  }
}

// ── Native Tauri v2 Drag & Drop Listener ─────────────────────────────────
export function setupDropZones(): void {
  // Leverage the shared setupDropZone function in plugins/lib/drop-zone.ts.
  // It handles dragging over our container element and detects which zone gets hit.
  _setupDropZone(
    TAB_ID,
    ["cmp-drop-zone-a", "cmp-drop-zone-b", "cmp-drop-zone-both"],
    (paths, hitId) => {
      let targetSlot: "A" | "B" = "A";
      if (hitId === "cmp-drop-zone-b") {
        targetSlot = "B";
      }

      if (paths.length >= 2) {
        loadAssetIntoSlot("A", { path: paths[0], asset_id: 0 });
        loadAssetIntoSlot("B", { path: paths[1], asset_id: 0 });
      } else if (paths.length === 1) {
        loadAssetIntoSlot(targetSlot, { path: paths[0], asset_id: 0 });
      }
    }
  );
}

export function loadFromSelection(): void {
  PH.getSelectionAssetContexts().then((selection) => {
    if (!selection || selection.length === 0) {
      alert("No images selected in library grid. Select 1 or 2 images first.");
      return;
    }
    if (selection.length >= 2) {
      loadAssetIntoSlot("A", selection[0]);
      loadAssetIntoSlot("B", selection[1]);
    } else {
      loadAssetIntoSlot("A", selection[0]);
    }
    navigateToTab();
  });
}

export function updateSlotHeaders(): void {
  const titleA = el("slot-a-title");
  const metaA = el("slot-a-meta");
  if (titleA) {
    titleA.textContent = state.slotA.name || "No image loaded";
    titleA.title = state.slotA.path || state.slotA.name || "No image loaded";
  }
  if (metaA) {
    metaA.textContent = state.slotA.width
      ? `${state.slotA.width}×${state.slotA.height}${
          state.slotA.sizeStr ? ` (${state.slotA.sizeStr})` : ""
        }`
      : "";
  }

  const titleB = el("slot-b-title");
  const metaB = el("slot-b-meta");
  if (titleB) {
    titleB.textContent = state.slotB.name || "No image loaded";
    titleB.title = state.slotB.path || state.slotB.name || "No image loaded";
  }
  if (metaB) {
    metaB.textContent = state.slotB.width
      ? `${state.slotB.width}×${state.slotB.height}${
          state.slotB.sizeStr ? ` (${state.slotB.sizeStr})` : ""
        }`
      : "";
  }
}

export function bindEvents(wrapper: HTMLElement): void {
  const btnSide = wrapper.querySelector("#cmp-mode-side");
  const btnHSlider = wrapper.querySelector("#cmp-mode-hslider");
  const btnVSlider = wrapper.querySelector("#cmp-mode-vslider");
  const btnOnion = wrapper.querySelector("#cmp-mode-onion");

  function setMode(newMode: typeof state.mode): void {
    state.mode = newMode;
    [btnSide, btnHSlider, btnVSlider, btnOnion].forEach((b) => {
      b?.classList.remove("primary");
    });
    if (newMode === "side-by-side" && btnSide) btnSide.classList.add("primary");
    if (newMode === "h-slider" && btnHSlider) btnHSlider.classList.add("primary");
    if (newMode === "v-slider" && btnVSlider) btnVSlider.classList.add("primary");
    if (newMode === "onion" && btnOnion) btnOnion.classList.add("primary");

    const secBar = el("cmp-secondary-bar");
    const sLabel = el("cmp-slider-label");
    const sRange = el<HTMLInputElement>("cmp-slider-range");
    const sVal = el("cmp-slider-val");

    if (secBar) {
      if (newMode === "side-by-side") {
        secBar.style.display = "none";
      } else {
        secBar.style.display = "flex";
        if (newMode === "onion") {
          if (sLabel) sLabel.textContent = "Onion Opacity (Image B):";
          if (sRange) sRange.value = String(state.onionOpacity);
          if (sVal) sVal.textContent = state.onionOpacity + "%";
        } else {
          if (sLabel) sLabel.textContent = "Split Position:";
          if (sRange) sRange.value = String(state.splitPos);
          if (sVal) sVal.textContent = state.splitPos + "%";
        }
      }
    }

    renderCanvasDOM();
  }

  if (btnSide) btnSide.addEventListener("click", () => setMode("side-by-side"));
  if (btnHSlider) btnHSlider.addEventListener("click", () => setMode("h-slider"));
  if (btnVSlider) btnVSlider.addEventListener("click", () => setMode("v-slider"));
  if (btnOnion) btnOnion.addEventListener("click", () => setMode("onion"));

  const rangeEl = wrapper.querySelector<HTMLInputElement>("#cmp-slider-range");
  if (rangeEl) {
    rangeEl.addEventListener("input", (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (state.mode === "onion") {
        state.onionOpacity = v;
      } else {
        state.splitPos = v;
      }
      const valEl = el("cmp-slider-val");
      if (valEl) valEl.textContent = v + "%";
      scheduleTransformUpdate();
    });
  }

  const syncBtn = wrapper.querySelector("#cmp-toggle-sync");
  if (syncBtn) {
    syncBtn.addEventListener("click", () => {
      state.syncLock = !state.syncLock;
      if (state.syncLock) {
        syncBtn.classList.add("primary");
        syncBtn.innerHTML = '<i class="bi bi-lock-fill"></i> Sync Lock';
        state.zoomB = state.zoomA;
        state.panB = { x: state.panA.x, y: state.panA.y };
      } else {
        syncBtn.classList.remove("primary");
        syncBtn.innerHTML = '<i class="bi bi-unlock"></i> Independent';
      }
      scheduleTransformUpdate();
    });
  }

  const pinBtn = wrapper.querySelector("#cmp-toggle-pin-split");
  if (pinBtn) {
    pinBtn.addEventListener("click", () => {
      state.pinSplitterToImage = !state.pinSplitterToImage;
      if (state.pinSplitterToImage) {
        pinBtn.classList.add("primary");
        pinBtn.innerHTML = '<i class="bi bi-pin-angle-fill"></i> Splitter: Pinned to Image';
      } else {
        pinBtn.classList.remove("primary");
        pinBtn.innerHTML = '<i class="bi bi-window"></i> Splitter: Viewport';
      }
      renderCanvasDOM();
    });
  }

  const zoomInBtn = wrapper.querySelector("#cmp-zoom-in");
  const zoomOutBtn = wrapper.querySelector("#cmp-zoom-out");
  const zoomFitBtn = wrapper.querySelector("#cmp-zoom-fit");
  const zoom100Btn = wrapper.querySelector("#cmp-zoom-100");
  const zoomResetBtn = wrapper.querySelector("#cmp-zoom-reset");

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      state.zoomA = Math.min(state.zoomA * 1.25, 10.0);
      if (state.syncLock) state.zoomB = state.zoomA;
      scheduleTransformUpdate();
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      state.zoomA = Math.max(state.zoomA / 1.25, 0.1);
      if (state.syncLock) state.zoomB = state.zoomA;
      scheduleTransformUpdate();
    });
  }

  if (zoomFitBtn) zoomFitBtn.addEventListener("click", fitToViewport);

  if (zoom100Btn) {
    zoom100Btn.addEventListener("click", () => {
      state.zoomA = 1.0;
      state.panA = { x: 0, y: 0 };
      if (state.syncLock) {
        state.zoomB = 1.0;
        state.panB = { x: 0, y: 0 };
      }
      scheduleTransformUpdate();
    });
  }

  if (zoomResetBtn) zoomResetBtn.addEventListener("click", resetZoomAndPan);

  const loadSelBtn = wrapper.querySelector("#cmp-load-sel-btn");
  if (loadSelBtn) loadSelBtn.addEventListener("click", loadFromSelection);

  const swapBtn = wrapper.querySelector("#cmp-swap-btn");
  if (swapBtn) swapBtn.addEventListener("click", swapSlots);

  const infoBtn = wrapper.querySelector("#cmp-toggle-info");
  if (infoBtn) {
    infoBtn.addEventListener("click", () => {
      state.showInfoOverlay = !state.showInfoOverlay;
      infoBtn.classList.toggle("primary", state.showInfoOverlay);
      const oA = el("cmp-info-overlay-a");
      const oB = el("cmp-info-overlay-b");
      if (oA) oA.style.display = state.showInfoOverlay ? "block" : "none";
      if (oB) oB.style.display = state.showInfoOverlay ? "block" : "none";
    });
  }

  const clearBtn = wrapper.querySelector("#cmp-clear-all");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.slotA = { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" };
      state.slotB = { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" };
      resetZoomAndPan();
      updateSlotHeaders();
      renderCanvasDOM();
    });
  }

  const inputA = wrapper.querySelector<HTMLInputElement>("#slot-a-file-input");
  if (inputA) {
    inputA.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files[0]) {
        loadAssetIntoSlot("A", null, files[0]);
      }
    });
  }

  const inputB = wrapper.querySelector<HTMLInputElement>("#slot-b-file-input");
  if (inputB) {
    inputB.addEventListener("change", (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files[0]) {
        loadAssetIntoSlot("B", null, files[0]);
      }
    });
  }

  const clearABtn = wrapper.querySelector("#slot-a-clear-btn");
  if (clearABtn) {
    clearABtn.addEventListener("click", () => {
      state.slotA = { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" };
      updateSlotHeaders();
      renderCanvasDOM();
    });
  }

  const clearBBtn = wrapper.querySelector("#slot-b-clear-btn");
  if (clearBBtn) {
    clearBBtn.addEventListener("click", () => {
      state.slotB = { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" };
      updateSlotHeaders();
      renderCanvasDOM();
    });
  }
}

export function renderCanvasDOM(): void {
  const canvasArea = el("compare-canvas-area");
  if (!canvasArea) return;

  canvasArea.innerHTML = "";
  canvasArea.style.background = "var(--sys-window-bg, #ffffff)";

  const overlayA = state.slotA.url
    ? `<div id="cmp-info-overlay-a" style="position: absolute; bottom: 8px; left: 8px; background: rgba(0,0,0,0.8); color: #ffffff; padding: 4px 8px; border-radius: 2px; font-size: 10px; font-family: monospace; pointer-events: none; z-index: 10; display: ${
        state.showInfoOverlay ? "block" : "none"
      }; border: 1px solid #444;">
        A: ${state.slotA.width}×${state.slotA.height} | Zoom: ${Math.round(state.zoomA * 100)}%
      </div>`
    : "";

  const overlayB = state.slotB.url
    ? `<div id="cmp-info-overlay-b" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: #ffffff; padding: 4px 8px; border-radius: 2px; font-size: 10px; font-family: monospace; pointer-events: none; z-index: 10; display: ${
        state.showInfoOverlay ? "block" : "none"
      }; border: 1px solid #444;">
        B: ${state.slotB.width}×${state.slotB.height} | Zoom: ${Math.round(state.zoomB * 100)}%
      </div>`
    : "";

  if (state.mode === "side-by-side") {
    renderSideBySideDOM(canvasArea, overlayA, overlayB);
  } else if (state.mode === "h-slider") {
    renderHSliderDOM(canvasArea, overlayA, overlayB);
  } else if (state.mode === "v-slider") {
    renderVSliderDOM(canvasArea, overlayA, overlayB);
  } else if (state.mode === "onion") {
    renderOnionSkinDOM(canvasArea, overlayA, overlayB);
  }

  attachCanvasInteractions(canvasArea);
  scheduleTransformUpdate();
}

function placeholderHtml(slotName: string, targetSlot: string, zoneId: string): string {
  return `
    <div style="height: 100%; width: 100%; padding: 12px; box-sizing: border-box; display: flex; flex-direction: column; background: var(--sys-window-bg, #ffffff);">
      <div class="toolbox-drop-zone" id="${zoneId}" data-slot="${targetSlot}" style="flex: 1; margin-top: 0; cursor: pointer;">
        <div class="toolbox-drop-icon"><i class="bi bi-images"></i></div>
        <span>Drag & Drop image here to compare</span>
        <span style="font-size: 10px; font-weight: 600; color: var(--sys-border-focus, #0078d7); margin-top: 4px;">Target: ${slotName}</span>
      </div>
    </div>
  `;
}

function renderSideBySideDOM(container: HTMLElement, overlayA: string, overlayB: string): void {
  container.style.display = "flex";
  container.style.height = "100%";

  const vpA = document.createElement("div");
  vpA.className = "cmp-viewport";
  vpA.dataset.slot = "A";
  vpA.style.cssText =
    "flex: 1; position: relative; overflow: hidden; border-right: 1px solid var(--sys-border-dark, #b0b0b0); height: 100%; cursor: " +
    (state.slotA.url ? "grab" : "default") +
    "; background: " +
    (state.slotA.url ? "#1e1e1e" : "var(--sys-window-bg, #ffffff)") +
    ";";

  if (state.slotA.url) {
    vpA.innerHTML = `
      <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
        <img src="${state.slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
      </div>
      ${overlayA}
    `;
  } else {
    vpA.innerHTML = placeholderHtml("Image A", "A", "cmp-drop-zone-a");
  }

  const vpB = document.createElement("div");
  vpB.className = "cmp-viewport";
  vpB.dataset.slot = "B";
  vpB.style.cssText =
    "flex: 1; position: relative; overflow: hidden; height: 100%; cursor: " +
    (state.slotB.url ? "grab" : "default") +
    "; background: " +
    (state.slotB.url ? "#1e1e1e" : "var(--sys-window-bg, #ffffff)") +
    ";";

  if (state.slotB.url) {
    vpB.innerHTML = `
      <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
        <img src="${state.slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
      </div>
      ${overlayB}
    `;
  } else {
    vpB.innerHTML = placeholderHtml("Image B", "B", "cmp-drop-zone-b");
  }

  container.appendChild(vpA);
  container.appendChild(vpB);
}

function renderHSliderDOM(container: HTMLElement, overlayA: string, overlayB: string): void {
  container.style.display = "block";
  container.style.height = "100%";

  if (!state.slotA.url && !state.slotB.url) {
    container.innerHTML = placeholderHtml("Image A & B", "both", "cmp-drop-zone-both");
    return;
  }

  const clipVal = 100 - state.splitPos;

  if (state.pinSplitterToImage) {
    container.innerHTML = `
      <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
        <div id="cmp-wrapper-shared" style="position: absolute; inset: 0; transform-origin: center center; will-change: transform;">
          <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
            <img src="${state.slotA.url || ""}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none; display: ${
      state.slotA.url ? "block" : "none"
    };" />
          </div>
          <div id="cmp-layer-b-pinned" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 ${clipVal}% 0 0); will-change: clip-path; display: ${
      state.slotB.url ? "block" : "none"
    };">
            <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
              <img src="${state.slotB.url || ""}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
            </div>
          </div>
        </div>
        <div id="cmp-handle-h" style="position: absolute; top: 0; bottom: 0; left: calc(50% - 12px); width: 24px; cursor: col-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: left;">
          <div style="position: absolute; top: 0; bottom: 0; left: 11px; width: 2px; background: #0078d7;"></div>
          <div class="win-button primary" style="width: 24px; height: 32px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
            <i class="bi bi-arrows-collapse"></i>
          </div>
        </div>
        ${overlayA}
        ${overlayB}
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
        <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
          <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${state.slotA.url ? `<img src="${state.slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
          </div>
        </div>
        <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 ${clipVal}% 0 0); will-change: clip-path;">
          <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${state.slotB.url ? `<img src="${state.slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
          </div>
        </div>
        <div id="cmp-handle-h" style="position: absolute; top: 0; bottom: 0; left: calc(${state.splitPos}% - 12px); width: 24px; cursor: col-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: left;">
          <div style="position: absolute; top: 0; bottom: 0; left: 11px; width: 2px; background: #0078d7;"></div>
          <div class="win-button primary" style="width: 24px; height: 32px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
            <i class="bi bi-arrows-collapse"></i>
          </div>
        </div>
        ${overlayA}
        ${overlayB}
      </div>
    `;
  }
}

function renderVSliderDOM(container: HTMLElement, overlayA: string, overlayB: string): void {
  container.style.display = "block";
  container.style.height = "100%";

  if (!state.slotA.url && !state.slotB.url) {
    container.innerHTML = placeholderHtml("Image A & B", "both", "cmp-drop-zone-both");
    return;
  }

  const clipVal = 100 - state.splitPos;

  if (state.pinSplitterToImage) {
    container.innerHTML = `
      <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
        <div id="cmp-wrapper-shared" style="position: absolute; inset: 0; transform-origin: center center; will-change: transform;">
          <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
            <img src="${state.slotA.url || ""}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none; display: ${
      state.slotA.url ? "block" : "none"
    };" />
          </div>
          <div id="cmp-layer-b-pinned" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 ${clipVal}% 0); will-change: clip-path; display: ${
      state.slotB.url ? "block" : "none"
    };">
            <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
              <img src="${state.slotB.url || ""}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
            </div>
          </div>
        </div>
        <div id="cmp-handle-v" style="position: absolute; left: 0; right: 0; top: calc(50% - 12px); height: 24px; cursor: row-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: top;">
          <div style="position: absolute; left: 0; right: 0; top: 11px; height: 2px; background: #0078d7;"></div>
          <div class="win-button primary" style="width: 32px; height: 24px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
            <i class="bi bi-arrows-collapse-vertical"></i>
          </div>
        </div>
        ${overlayA}
        ${overlayB}
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
        <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
          <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${state.slotA.url ? `<img src="${state.slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
          </div>
        </div>
        <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 ${clipVal}% 0); will-change: clip-path;">
          <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${state.slotB.url ? `<img src="${state.slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
          </div>
        </div>
        <div id="cmp-handle-v" style="position: absolute; left: 0; right: 0; top: calc(${state.splitPos}% - 12px); height: 24px; cursor: row-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: top;">
          <div style="position: absolute; left: 0; right: 0; top: 11px; height: 2px; background: #0078d7;"></div>
          <div class="win-button primary" style="width: 32px; height: 24px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
            <i class="bi bi-arrows-collapse-vertical"></i>
          </div>
        </div>
        ${overlayA}
        ${overlayB}
      </div>
    `;
  }
}

function renderOnionSkinDOM(container: HTMLElement, overlayA: string, overlayB: string): void {
  container.style.display = "block";
  container.style.height = "100%";

  if (!state.slotA.url && !state.slotB.url) {
    container.innerHTML = placeholderHtml("Image A & B", "both", "cmp-drop-zone-both");
    return;
  }

  const opacityVal = state.onionOpacity / 100;

  container.innerHTML = `
    <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
      <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
        <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
          ${state.slotA.url ? `<img src="${state.slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
        </div>
      </div>
      <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; opacity: ${opacityVal}; will-change: opacity;">
        <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
          ${state.slotB.url ? `<img src="${state.slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ""}
        </div>
      </div>
      ${overlayA}
      ${overlayB}
    </div>
  `;
}

function processDroppedItems(dataTransfer: DataTransfer | null, targetSlot: "A" | "B"): void {
  if (!dataTransfer) return;

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    const fileList = Array.from(dataTransfer.files);
    if (fileList.length >= 2) {
      loadAssetIntoSlot("A", null, fileList[0]);
      loadAssetIntoSlot("B", null, fileList[1]);
    } else {
      loadAssetIntoSlot(targetSlot, null, fileList[0]);
    }
    return;
  }

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const items = Array.from(dataTransfer.items);
    const fileItems = items.filter((it) => it.kind === "file");
    if (fileItems.length > 0) {
      const files = fileItems.map((it) => it.getAsFile()).filter(Boolean) as File[];
      if (files.length >= 2) {
        loadAssetIntoSlot("A", null, files[0]);
        loadAssetIntoSlot("B", null, files[1]);
      } else if (files.length === 1) {
        loadAssetIntoSlot(targetSlot, null, files[0]);
      }
      return;
    }
  }

  const uriList = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  const rawPath = uriList || plainText;

  if (rawPath) {
    const lines = rawPath
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length >= 2) {
      loadAssetIntoSlot("A", { path: lines[0], asset_id: 0 });
      loadAssetIntoSlot("B", { path: lines[1], asset_id: 0 });
    } else if (lines.length === 1) {
      loadAssetIntoSlot(targetSlot, { path: lines[0], asset_id: 0 });
    }
  }
}

function attachCanvasInteractions(container: HTMLElement): void {
  const viewports = container.querySelectorAll<HTMLElement>(".cmp-viewport");

  viewports.forEach((vp) => {
    const slotType = (vp.dataset.slot || "both") as "A" | "B" | "both";

    vp.addEventListener("click", (e) => {
      const dz = (e.target as HTMLElement).closest(".toolbox-drop-zone") as HTMLElement | null;
      if (dz) {
        const targetSlot = dz.dataset.slot === "B" ? "B" : "A";
        const input = el(targetSlot === "B" ? "slot-b-file-input" : "slot-a-file-input");
        if (input) input.click();
      }
    });

    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.15 : 0.85;

        if (state.syncLock || slotType === "both" || slotType === "A") {
          state.zoomA = Math.min(Math.max(state.zoomA * delta, 0.1), 10.0);
        }
        if (state.syncLock || slotType === "both" || slotType === "B") {
          state.zoomB = state.syncLock ? state.zoomA : Math.min(Math.max(state.zoomB * delta, 0.1), 10.0);
        }

        scheduleTransformUpdate();
      },
      { passive: false }
    );

    vp.addEventListener("mousedown", (e) => {
      const handleH = el("cmp-handle-h");
      const handleV = el("cmp-handle-v");
      if (
        (handleH && handleH.contains(e.target as Node)) ||
        (handleV && handleV.contains(e.target as Node))
      ) {
        state.isDraggingSlider = true;
        return;
      }

      if (e.button !== 0) return;

      state.isDraggingPan = true;
      state.dragTargetSlot = slotType;
      state.panStartX = e.clientX;
      state.panStartY = e.clientY;
      state.panInitialA = { x: state.panA.x, y: state.panA.y };
      state.panInitialB = { x: state.panB.x, y: state.panB.y };

      vp.style.cursor = "grabbing";
    });

    vp.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      const dz = vp.querySelector(".toolbox-drop-zone");
      dz?.classList.add("toolbox-drop-active");
    });

    vp.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      const dz = vp.querySelector(".toolbox-drop-zone");
      dz?.classList.add("toolbox-drop-active");
    });

    vp.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dz = vp.querySelector(".toolbox-drop-zone");
      dz?.classList.remove("toolbox-drop-active");
    });

    vp.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dz = vp.querySelector(".toolbox-drop-zone");
      dz?.classList.remove("toolbox-drop-active");

      const targetSlot = slotType === "B" ? "B" : "A";
      processDroppedItems(e.dataTransfer, targetSlot);
    });
  });
}

export function bindGlobalEventsOnce(): void {
  if (state.globalEventsBound) return;
  state.globalEventsBound = true;

  window.addEventListener("mousemove", (e) => {
    const container = el("compare-canvas-area");
    if (!container) return;

    if (state.isDraggingSlider) {
      const rect = container.getBoundingClientRect();
      if (state.mode === "h-slider") {
        let pct = 50;
        if (state.pinSplitterToImage) {
          const center = rect.width / 2;
          const screenRelToCenter = e.clientX - rect.left - center;
          const unpanned = screenRelToCenter - state.panA.x;
          const unscaled = unpanned / state.zoomA;
          const localX = unscaled + center;
          pct = (localX / rect.width) * 100;
        } else {
          const relX = e.clientX - rect.left;
          pct = (relX / rect.width) * 100;
        }
        state.splitPos = Math.min(Math.max(Math.round(pct), 0), 100);
        const sRange = el<HTMLInputElement>("cmp-slider-range");
        const sVal = el("cmp-slider-val");
        if (sRange) sRange.value = String(state.splitPos);
        if (sVal) sVal.textContent = state.splitPos + "%";
        scheduleTransformUpdate();
      } else if (state.mode === "v-slider") {
        let pct = 50;
        if (state.pinSplitterToImage) {
          const center = rect.height / 2;
          const screenRelToCenter = e.clientY - rect.top - center;
          const unpanned = screenRelToCenter - state.panA.y;
          const unscaled = unpanned / state.zoomA;
          const localY = unscaled + center;
          pct = (localY / rect.height) * 100;
        } else {
          const relY = e.clientY - rect.top;
          pct = (relY / rect.height) * 100;
        }
        state.splitPos = Math.min(Math.max(Math.round(pct), 0), 100);
        const sRange = el<HTMLInputElement>("cmp-slider-range");
        const sVal = el("cmp-slider-val");
        if (sRange) sRange.value = String(state.splitPos);
        if (sVal) sVal.textContent = state.splitPos + "%";
        scheduleTransformUpdate();
      }
      return;
    }

    if (state.isDraggingPan) {
      const dx = e.clientX - state.panStartX;
      const dy = e.clientY - state.panStartY;

      if (state.syncLock || state.dragTargetSlot === "both" || state.dragTargetSlot === "A") {
        state.panA.x = state.panInitialA.x + dx;
        state.panA.y = state.panInitialA.y + dy;
      }
      if (state.syncLock || state.dragTargetSlot === "both" || state.dragTargetSlot === "B") {
        state.panB.x = state.syncLock ? state.panA.x : state.panInitialB.x + dx;
        state.panB.y = state.syncLock ? state.panA.y : state.panInitialB.y + dy;
      }

      scheduleTransformUpdate();
    }
  });

  window.addEventListener("mouseup", () => {
    if (state.isDraggingPan || state.isDraggingSlider) {
      state.isDraggingPan = false;
      state.isDraggingSlider = false;
      const viewports = document.querySelectorAll<HTMLElement>(".cmp-viewport");
      viewports.forEach((vp) => {
        vp.style.cursor = "grab";
      });
    }
  });
}

export function ensureCompareMounted(): void {
  if (PH && PH.loadTab) {
    PH.loadTab(TAB_ID);
  }
}

export function renderCompareTab(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.cssText =
    "display: flex; flex-direction: column; height: calc(100vh - 130px); min-height: 500px; gap: 10px; box-sizing: border-box; overflow: hidden;";

  wrapper.innerHTML = `
    <!-- Control Bar Container -->
    <div class="group-box" style="margin-bottom: 0; padding: 8px 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <!-- Left: Mode Selection Controls -->
        <div style="display: flex; align-items: center; gap: 4px;">
          <span style="font-weight: 600; font-size: 11px; margin-right: 6px; color: var(--sys-text-subtle, #555);">Mode:</span>
          <button type="button" class="win-button ${
            state.mode === "side-by-side" ? "primary" : ""
          }" id="cmp-mode-side" title="Side-by-Side Dual Viewports">
            <i class="bi bi-layout-split"></i> Side-by-Side
          </button>
          <button type="button" class="win-button ${
            state.mode === "h-slider" ? "primary" : ""
          }" id="cmp-mode-hslider" title="Horizontal Split Slider">
            <i class="bi bi-sliders"></i> H-Slider
          </button>
          <button type="button" class="win-button ${
            state.mode === "v-slider" ? "primary" : ""
          }" id="cmp-mode-vslider" title="Vertical Split Slider">
            <i class="bi bi-sliders2-vertical"></i> V-Slider
          </button>
          <button type="button" class="win-button ${
            state.mode === "onion" ? "primary" : ""
          }" id="cmp-mode-onion" title="Onion Skin Opacity Overlay">
            <i class="bi bi-layers-half"></i> Onion Skin
          </button>
        </div>

        <!-- Middle: Sync, Pin, & Zoom Controls -->
        <div style="display: flex; align-items: center; gap: 6px;">
          <button type="button" class="win-button ${
            state.syncLock ? "primary" : ""
          }" id="cmp-toggle-sync" title="Toggle Synchronized Zoom & Pan">
            <i class="bi ${state.syncLock ? "bi-lock-fill" : "bi-unlock"}"></i> ${
    state.syncLock ? "Sync Lock" : "Independent"
  }
          </button>
          <button type="button" class="win-button ${
            state.pinSplitterToImage ? "primary" : ""
          }" id="cmp-toggle-pin-split" title="Toggle Splitter Mode: Viewport Screen Wipe vs Pinned to Image Pixel Space">
            <i class="bi ${state.pinSplitterToImage ? "bi-pin-angle-fill" : "bi-window"}"></i> ${
    state.pinSplitterToImage ? "Splitter: Pinned to Image" : "Splitter: Viewport"
  }
          </button>

          <div style="height: 16px; width: 1px; background: var(--sys-border-dark, #b0b0b0); margin: 0 4px;"></div>
          <button type="button" class="win-button" id="cmp-zoom-out" title="Zoom Out"><i class="bi bi-zoom-out"></i></button>
          <span id="cmp-zoom-val" style="font-size: 11px; font-family: monospace; min-width: 45px; text-align: center;">100%</span>
          <button type="button" class="win-button" id="cmp-zoom-in" title="Zoom In"><i class="bi bi-zoom-in"></i></button>
          <button type="button" class="win-button" id="cmp-zoom-fit" title="Fit to Viewport">Fit</button>
          <button type="button" class="win-button" id="cmp-zoom-100" title="100% Zoom">100%</button>
          <button type="button" class="win-button" id="cmp-zoom-reset" title="Reset View"><i class="bi bi-arrow-counterclockwise"></i> Reset</button>
        </div>

        <!-- Right: Actions & Selection -->
        <div style="display: flex; align-items: center; gap: 6px;">
          <button type="button" class="win-button" id="cmp-load-sel-btn" title="Load selected images from active selection (up to 2)">
            <i class="bi bi-check2-square"></i> Compare Selected
          </button>
          <button type="button" class="win-button" id="cmp-swap-btn" title="Swap Image A and Image B">
            <i class="bi bi-arrow-left-right"></i> Swap A/B
          </button>
          <button type="button" class="win-button ${
            state.showInfoOverlay ? "primary" : ""
          }" id="cmp-toggle-info" title="Toggle Metadata Overlay">
            <i class="bi bi-info-circle"></i> Info Overlay
          </button>
          <button type="button" class="win-button danger" id="cmp-clear-all" title="Clear Loaded Images">
            <i class="bi bi-trash"></i> Clear
          </button>
        </div>
      </div>

      <!-- Secondary Controls Bar (for Slider & Onion modes) -->
      <div id="cmp-secondary-bar" style="display: none; align-items: center; gap: 12px; margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--sys-border-dark, #b0b0b0);">
        <div id="cmp-slider-ctrl" style="display: flex; align-items: center; gap: 8px; flex: 1;">
          <span style="font-size: 11px; font-weight: 500;" id="cmp-slider-label">Split Position:</span>
          <input type="range" id="cmp-slider-range" min="0" max="100" value="50" style="flex: 1; height: 4px; cursor: pointer;" />
          <span id="cmp-slider-val" style="font-size: 11px; font-family: monospace; width: 35px;">50%</span>
        </div>
      </div>
    </div>

    <!-- Slots Header Bar -->
    <div style="display: flex; gap: 10px; flex-shrink: 0;">
      <!-- Slot A Header Group Box -->
      <div class="group-box" style="flex: 1; margin-bottom: 0; padding: 6px 10px;" id="slot-a-header">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;">
            <span class="tag-pill custom-concept" style="font-size: 10px; font-weight: 600;"><i class="bi bi-stars"></i> Image A</span>
            <span id="slot-a-title" style="font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; color: var(--sys-control-text, #000);" title="No image loaded">
              No image loaded
            </span>
            <span id="slot-a-meta" style="font-size: 10px; color: var(--sys-text-subtle, #555); font-family: monospace;"></span>
          </div>
          <div style="display: flex; align-items: center; gap: 4px; margin-left: 8px;">
            <label class="win-button" style="font-size: 10px; padding: 1px 6px; cursor: pointer; margin: 0;">
              <i class="bi bi-folder2-open"></i> Browse
              <input type="file" id="slot-a-file-input" accept="image/*" style="display: none;" />
            </label>
            <button type="button" class="win-button" id="slot-a-clear-btn" style="font-size: 10px; padding: 1px 6px;" title="Clear Image A">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- Slot B Header Group Box -->
      <div class="group-box" style="flex: 1; margin-bottom: 0; padding: 6px 10px;" id="slot-b-header">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;">
              <span class="tag-pill tag-character" style="font-size: 10px; font-weight: 600;">Image B</span>
              <span id="slot-b-title" style="font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; color: var(--sys-control-text, #000);" title="No image loaded">
                No image loaded
              </span>
              <span id="slot-b-meta" style="font-size: 10px; color: var(--sys-text-subtle, #555); font-family: monospace;"></span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px; margin-left: 8px;">
              <label class="win-button" style="font-size: 10px; padding: 1px 6px; cursor: pointer; margin: 0;">
                <i class="bi bi-folder2-open"></i> Browse
                <input type="file" id="slot-b-file-input" accept="image/*" style="display: none;" />
              </label>
              <button type="button" class="win-button" id="slot-b-clear-btn" style="font-size: 10px; padding: 1px 6px;" title="Clear Image B">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Canvas Container -->
    <div id="compare-canvas-area" style="flex: 1; min-height: 400px; position: relative; background: var(--sys-window-bg, #ffffff); border: 1px solid var(--sys-border-dark, #b0b0b0); border-radius: 2px; overflow: hidden; user-select: none;">
      <!-- Canvas Content rendered dynamically -->
    </div>
  `;

  setTimeout(() => {
    bindEvents(wrapper);
    bindGlobalEventsOnce();
    setupDropZones();
    updateSlotHeaders();
    renderCanvasDOM();
  }, 0);

  return wrapper;
}
