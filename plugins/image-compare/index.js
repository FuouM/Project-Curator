// ─────────────────────────────────────────────────────────────────────────────
// Project Curator — Image Compare plugin (v1.0.0)
//
// Modern WinForms Dark-Mode Desktop Control Aesthetic (Strict AGENTS.md §5 Compliance):
//   • Universal Zoom & Pan Engine across All Modes: Onion Skin mode now seamlessly responds
//     to mouse wheel zooming and click-drag panning regardless of Pin vs Viewport splitter state.
//   • Zero GPU Glitch/Flicker Image Layer Compositing: Image B is wrapped in a plain DOM <div>
//     layer (#cmp-layer-b-pinned / #cmp-layer-b) receiving GPU compositor clip-path and opacity
//     transforms without re-decoding static <img> elements.
//   • Forward/Inverse Matrix Screen-Space Handle Rendering: Splitter handles always reside
//     in top-level Viewport DOM space (.cmp-viewport) to guarantee 100% crisp 1:1 pixel rendering.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";

  var PH = window.PluginHost;
  if (!PH) {
    console.error("image-compare: PluginHost not available; aborting.");
    return;
  }

  var TAB_ID = "image-compare";

  // ── State ─────────────────────────────────────────────────────────────────
  var mode = "side-by-side"; // 'side-by-side' | 'h-slider' | 'v-slider' | 'onion'
  var splitPos = 50;         // 0 .. 100 percentage for sliders
  var onionOpacity = 50;     // 0 .. 100 percentage for onion skin
  var syncLock = true;       // lock zoom & pan across both images
  var pinSplitterToImage = false; // false = Viewport Screen Wipe, true = Pinned to Image Space
  var showInfoOverlay = true;

  // Zoom & Pan state
  var zoomA = 1.0;
  var panA = { x: 0, y: 0 };
  var zoomB = 1.0;
  var panB = { x: 0, y: 0 };

  // Slots
  var slotA = { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" };
  var slotB = { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" };

  // Interaction flags
  var isDraggingPan = false;
  var dragTargetSlot = "both"; // 'A' | 'B' | 'both'
  var panStartX = 0;
  var panStartY = 0;
  var panInitialA = { x: 0, y: 0 };
  var panInitialB = { x: 0, y: 0 };

  var isDraggingSlider = false;
  var rafPending = false;
  var globalEventsBound = false;
  var tauriDropBound = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function el(id) {
    return document.getElementById(id);
  }

  function getAssetSrc(path) {
    if (!path) return "";
    if (path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    return PH.convertFileSrc(path);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function navigateToTab() {
    var navItem = document.querySelector('.nav-item[data-view="extensions-' + TAB_ID + '"]');
    if (navItem) navItem.click();
  }

  function closeInfoModal() {
    var modal = document.getElementById("image-info-modal");
    if (!modal || !modal.classList.contains("active")) return;
    var closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) closeBtn.click();
    else modal.classList.remove("active");
  }

  function loadImageMetadata(slot, callback) {
    if (!slot.url) {
      slot.width = 0;
      slot.height = 0;
      if (callback) callback();
      return;
    }
    var img = new Image();
    img.onload = function () {
      slot.width = img.naturalWidth;
      slot.height = img.naturalHeight;
      if (callback) callback();
    };
    img.onerror = function (err) {
      console.error("Image Compare: failed to load image src:", slot.path, err);
      if (callback) callback();
    };
    img.src = slot.url;
  }

  function loadAssetIntoSlot(targetSlot, assetContext, fileObj) {
    var slotObj = targetSlot === "A" ? slotA : slotB;
    if (fileObj) {
      slotObj.id = null;
      var filePath = fileObj.path || "";
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
      slotObj.name = assetContext.path ? assetContext.path.split(/[\\/]/).pop() : ("Asset #" + assetContext.asset_id);
      slotObj.url = getAssetSrc(slotObj.path);
      slotObj.sizeStr = "";
    }

    loadImageMetadata(slotObj, function () {
      updateSlotHeaders();
      renderCanvasDOM();
    });
  }

  function swapSlots() {
    var temp = Object.assign({}, slotA);
    slotA = Object.assign({}, slotB);
    slotB = temp;
    updateSlotHeaders();
    renderCanvasDOM();
  }

  function resetZoomAndPan() {
    zoomA = 1.0;
    panA = { x: 0, y: 0 };
    zoomB = 1.0;
    panB = { x: 0, y: 0 };
    scheduleTransformUpdate();
  }

  function fitToViewport() {
    zoomA = 1.0;
    panA = { x: 0, y: 0 };
    zoomB = 1.0;
    panB = { x: 0, y: 0 };
    scheduleTransformUpdate();
  }

  // ── High Performance GPU Transform Pipeline ─────────────────────────────
  function scheduleTransformUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      applyTransforms();
    });
  }

  function applyTransforms() {
    var clipVal = 100 - splitPos;
    var container = el("compare-canvas-area");
    var rect = container ? container.getBoundingClientRect() : null;

    if (mode === "side-by-side") {
      var wrapperA = el("cmp-wrapper-a");
      if (wrapperA) {
        wrapperA.style.transform = "translate(" + panA.x + "px, " + panA.y + "px) scale(" + zoomA + ")";
      }
      var wrapperB = el("cmp-wrapper-b");
      if (wrapperB) {
        var activePan = syncLock ? panA : panB;
        var activeZoom = syncLock ? zoomA : zoomB;
        wrapperB.style.transform = "translate(" + activePan.x + "px, " + activePan.y + "px) scale(" + activeZoom + ")";
      }
    } else {
      // For h-slider, v-slider, and onion modes
      var sharedWrapper = el("cmp-wrapper-shared");
      if (sharedWrapper) {
        sharedWrapper.style.transform = "translate(" + panA.x + "px, " + panA.y + "px) scale(" + zoomA + ")";
      }

      var wrapperA = el("cmp-wrapper-a");
      if (wrapperA) {
        wrapperA.style.transform = "translate(" + panA.x + "px, " + panA.y + "px) scale(" + zoomA + ")";
      }

      var wrapperB = el("cmp-wrapper-b");
      if (wrapperB) {
        var activePan = syncLock ? panA : panB;
        var activeZoom = syncLock ? zoomA : zoomB;
        wrapperB.style.transform = "translate(" + activePan.x + "px, " + activePan.y + "px) scale(" + activeZoom + ")";
      }

      var layerB = el("cmp-layer-b-pinned") || el("cmp-layer-b");
      if (layerB) {
        if (mode === "h-slider") {
          layerB.style.clipPath = "inset(0 " + clipVal + "% 0 0)";
          layerB.style.opacity = "1";
        } else if (mode === "v-slider") {
          layerB.style.clipPath = "inset(0 0 " + clipVal + "% 0)";
          layerB.style.opacity = "1";
        } else if (mode === "onion") {
          layerB.style.clipPath = "none";
          layerB.style.opacity = (onionOpacity / 100).toString();
        } else {
          layerB.style.clipPath = "none";
          layerB.style.opacity = "1";
        }
      }

      if (pinSplitterToImage && rect) {
        if (mode === "h-slider") {
          var handleH = el("cmp-handle-h");
          if (handleH) {
            var center = rect.width / 2;
            var localX = rect.width * (splitPos / 100);
            var screenX = (localX - center) * zoomA + center + panA.x;
            handleH.style.left = "calc(" + screenX + "px - 12px)";
          }
        } else if (mode === "v-slider") {
          var handleV = el("cmp-handle-v");
          if (handleV) {
            var center = rect.height / 2;
            var localY = rect.height * (splitPos / 100);
            var screenY = (localY - center) * zoomA + center + panA.y;
            handleV.style.top = "calc(" + screenY + "px - 12px)";
          }
        }
      } else {
        if (mode === "h-slider") {
          var handleH = el("cmp-handle-h");
          if (handleH) handleH.style.left = "calc(" + splitPos + "% - 12px)";
        } else if (mode === "v-slider") {
          var handleV = el("cmp-handle-v");
          if (handleV) handleV.style.top = "calc(" + splitPos + "% - 12px)";
        }
      }
    }

    var valEl = el("cmp-zoom-val");
    if (valEl) valEl.textContent = Math.round(zoomA * 100) + "%";

    var infoA = el("cmp-info-overlay-a");
    if (infoA) infoA.textContent = "A: " + slotA.width + "×" + slotA.height + " | Zoom: " + Math.round(zoomA * 100) + "%";

    var infoB = el("cmp-info-overlay-b");
    if (infoB) infoB.textContent = "B: " + slotB.width + "×" + slotB.height + " | Zoom: " + Math.round((syncLock ? zoomA : zoomB) * 100) + "%";
  }

  // ── Native Tauri v2 Drag & Drop Listener ─────────────────────────────────
  function setupTauriDropZone() {
    if (tauriDropBound) return;
    var api = window.__TAURI__;
    if (!api || !api.webview || !api.webview.getCurrentWebview) return;
    tauriDropBound = true;

    api.webview.getCurrentWebview().onDragDropEvent(function (event) {
      var tabActive = document.getElementById("view-extensions-" + TAB_ID);
      if (!tabActive || !tabActive.classList.contains("active")) return;
      var drop = event.payload;

      var dropZones = document.querySelectorAll(".toolbox-drop-zone");

      var getHitDropZone = function () {
        var pos = drop.position;
        if (!pos || typeof pos.x !== "number") return null;
        var cx = pos.x / window.devicePixelRatio;
        var cy = pos.y / window.devicePixelRatio;
        var hit = document.elementFromPoint(cx, cy);
        return hit ? hit.closest(".toolbox-drop-zone") : null;
      };

      var activeZone = getHitDropZone();

      if (drop.type === "enter" || drop.type === "over") {
        dropZones.forEach(function (dz) {
          if (dz === activeZone) {
            dz.classList.add("toolbox-drop-active");
          } else {
            dz.classList.remove("toolbox-drop-active");
          }
        });
      } else if (drop.type === "leave" || drop.type === "drop") {
        dropZones.forEach(function (dz) {
          dz.classList.remove("toolbox-drop-active");
        });
      }

      if (drop.type === "drop" && drop.paths && drop.paths.length > 0) {
        var paths = drop.paths;
        var targetSlot = "A";
        if (activeZone && activeZone.dataset.slot === "B") {
          targetSlot = "B";
        }
        if (paths.length >= 2) {
          loadAssetIntoSlot("A", { path: paths[0], asset_id: 0 });
          loadAssetIntoSlot("B", { path: paths[1], asset_id: 0 });
        } else if (paths.length === 1) {
          loadAssetIntoSlot(targetSlot, { path: paths[0], asset_id: 0 });
        }
      }
    });
  }

  // ── Selection Mode Handler ────────────────────────────────────────────────
  function loadFromSelection() {
    PH.getSelectionAssetContexts().then(function (selection) {
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

  // ── Render Header & Control Layout ────────────────────────────────────────
  function renderCompareTab() {
    var wrapper = document.createElement("div");
    wrapper.style.cssText = "display: flex; flex-direction: column; height: calc(100vh - 130px); min-height: 500px; gap: 10px; box-sizing: border-box; overflow: hidden;";

    wrapper.innerHTML = `
      <!-- Control Bar Container -->
      <div class="group-box" style="margin-bottom: 0; padding: 8px 12px;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <!-- Left: Mode Selection Controls -->
          <div style="display: flex; align-items: center; gap: 4px;">
            <span style="font-weight: 600; font-size: 11px; margin-right: 6px; color: var(--sys-text-subtle, #555);">Mode:</span>
            <button type="button" class="win-button ${mode === "side-by-side" ? "primary" : ""}" id="cmp-mode-side" title="Side-by-Side Dual Viewports">
              <i class="bi bi-layout-split"></i> Side-by-Side
            </button>
            <button type="button" class="win-button ${mode === "h-slider" ? "primary" : ""}" id="cmp-mode-hslider" title="Horizontal Split Slider">
              <i class="bi bi-sliders"></i> H-Slider
            </button>
            <button type="button" class="win-button ${mode === "v-slider" ? "primary" : ""}" id="cmp-mode-vslider" title="Vertical Split Slider">
              <i class="bi bi-sliders2-vertical"></i> V-Slider
            </button>
            <button type="button" class="win-button ${mode === "onion" ? "primary" : ""}" id="cmp-mode-onion" title="Onion Skin Opacity Overlay">
              <i class="bi bi-layers-half"></i> Onion Skin
            </button>
          </div>

          <!-- Middle: Sync, Pin, & Zoom Controls -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <button type="button" class="win-button ${syncLock ? "primary" : ""}" id="cmp-toggle-sync" title="Toggle Synchronized Zoom & Pan">
              <i class="bi ${syncLock ? "bi-lock-fill" : "bi-unlock"}"></i> ${syncLock ? "Sync Lock" : "Independent"}
            </button>
            <button type="button" class="win-button ${pinSplitterToImage ? "primary" : ""}" id="cmp-toggle-pin-split" title="Toggle Splitter Mode: Viewport Screen Wipe vs Pinned to Image Pixel Space">
              <i class="bi ${pinSplitterToImage ? "bi-pin-angle-fill" : "bi-window"}"></i> ${pinSplitterToImage ? "Splitter: Pinned to Image" : "Splitter: Viewport"}
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
            <button type="button" class="win-button ${showInfoOverlay ? "primary" : ""}" id="cmp-toggle-info" title="Toggle Metadata Overlay">
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

    setTimeout(function () {
      bindEvents(wrapper);
      bindGlobalEventsOnce();
      setupTauriDropZone();
      updateSlotHeaders();
      renderCanvasDOM();
    }, 0);

    return wrapper;
  }

  function updateSlotHeaders() {
    var titleA = el("slot-a-title");
    var metaA = el("slot-a-meta");
    if (titleA) {
      titleA.textContent = slotA.name || "No image loaded";
      titleA.title = slotA.path || slotA.name || "No image loaded";
    }
    if (metaA) {
      metaA.textContent = slotA.width ? (slotA.width + "×" + slotA.height + (slotA.sizeStr ? " (" + slotA.sizeStr + ")" : "")) : "";
    }

    var titleB = el("slot-b-title");
    var metaB = el("slot-b-meta");
    if (titleB) {
      titleB.textContent = slotB.name || "No image loaded";
      titleB.title = slotB.path || slotB.name || "No image loaded";
    }
    if (metaB) {
      metaB.textContent = slotB.width ? (slotB.width + "×" + slotB.height + (slotB.sizeStr ? " (" + slotB.sizeStr + ")" : "")) : "";
    }
  }

  // ── Bind Interactive Events ───────────────────────────────────────────────
  function bindEvents(wrapper) {
    var btnSide = wrapper.querySelector("#cmp-mode-side");
    var btnHSlider = wrapper.querySelector("#cmp-mode-hslider");
    var btnVSlider = wrapper.querySelector("#cmp-mode-vslider");
    var btnOnion = wrapper.querySelector("#cmp-mode-onion");

    function setMode(newMode) {
      mode = newMode;
      [btnSide, btnHSlider, btnVSlider, btnOnion].forEach(function (b) {
        if (b) b.classList.remove("primary");
      });
      if (newMode === "side-by-side" && btnSide) btnSide.classList.add("primary");
      if (newMode === "h-slider" && btnHSlider) btnHSlider.classList.add("primary");
      if (newMode === "v-slider" && btnVSlider) btnVSlider.classList.add("primary");
      if (newMode === "onion" && btnOnion) btnOnion.classList.add("primary");

      var secBar = el("cmp-secondary-bar");
      var sLabel = el("cmp-slider-label");
      var sRange = el("cmp-slider-range");
      var sVal = el("cmp-slider-val");

      if (secBar) {
        if (newMode === "side-by-side") {
          secBar.style.display = "none";
        } else {
          secBar.style.display = "flex";
          if (newMode === "onion") {
            if (sLabel) sLabel.textContent = "Onion Opacity (Image B):";
            if (sRange) sRange.value = onionOpacity;
            if (sVal) sVal.textContent = onionOpacity + "%";
          } else {
            if (sLabel) sLabel.textContent = "Split Position:";
            if (sRange) sRange.value = splitPos;
            if (sVal) sVal.textContent = splitPos + "%";
          }
        }
      }

      renderCanvasDOM();
    }

    if (btnSide) btnSide.addEventListener("click", function () { setMode("side-by-side"); });
    if (btnHSlider) btnHSlider.addEventListener("click", function () { setMode("h-slider"); });
    if (btnVSlider) btnVSlider.addEventListener("click", function () { setMode("v-slider"); });
    if (btnOnion) btnOnion.addEventListener("click", function () { setMode("onion"); });

    var rangeEl = wrapper.querySelector("#cmp-slider-range");
    if (rangeEl) {
      rangeEl.addEventListener("input", function (e) {
        var v = parseInt(e.target.value, 10);
        if (mode === "onion") {
          onionOpacity = v;
          var valEl = el("cmp-slider-val");
          if (valEl) valEl.textContent = v + "%";
        } else {
          splitPos = v;
          var valEl = el("cmp-slider-val");
          if (valEl) valEl.textContent = v + "%";
        }
        scheduleTransformUpdate();
      });
    }

    var syncBtn = wrapper.querySelector("#cmp-toggle-sync");
    if (syncBtn) {
      syncBtn.addEventListener("click", function () {
        syncLock = !syncLock;
        if (syncLock) {
          syncBtn.classList.add("primary");
          syncBtn.innerHTML = '<i class="bi bi-lock-fill"></i> Sync Lock';
          zoomB = zoomA;
          panB = { x: panA.x, y: panA.y };
        } else {
          syncBtn.classList.remove("primary");
          syncBtn.innerHTML = '<i class="bi bi-unlock"></i> Independent';
        }
        scheduleTransformUpdate();
      });
    }

    var pinBtn = wrapper.querySelector("#cmp-toggle-pin-split");
    if (pinBtn) {
      pinBtn.addEventListener("click", function () {
        pinSplitterToImage = !pinSplitterToImage;
        if (pinSplitterToImage) {
          pinBtn.classList.add("primary");
          pinBtn.innerHTML = '<i class="bi bi-pin-angle-fill"></i> Splitter: Pinned to Image';
        } else {
          pinBtn.classList.remove("primary");
          pinBtn.innerHTML = '<i class="bi bi-window"></i> Splitter: Viewport';
        }
        renderCanvasDOM();
      });
    }

    var zoomInBtn = wrapper.querySelector("#cmp-zoom-in");
    var zoomOutBtn = wrapper.querySelector("#cmp-zoom-out");
    var zoomFitBtn = wrapper.querySelector("#cmp-zoom-fit");
    var zoom100Btn = wrapper.querySelector("#cmp-zoom-100");
    var zoomResetBtn = wrapper.querySelector("#cmp-zoom-reset");

    if (zoomInBtn) {
      zoomInBtn.addEventListener("click", function () {
        zoomA = Math.min(zoomA * 1.25, 10.0);
        if (syncLock) zoomB = zoomA;
        scheduleTransformUpdate();
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener("click", function () {
        zoomA = Math.max(zoomA / 1.25, 0.1);
        if (syncLock) zoomB = zoomA;
        scheduleTransformUpdate();
      });
    }

    if (zoomFitBtn) zoomFitBtn.addEventListener("click", fitToViewport);

    if (zoom100Btn) {
      zoom100Btn.addEventListener("click", function () {
        zoomA = 1.0;
        panA = { x: 0, y: 0 };
        if (syncLock) { zoomB = 1.0; panB = { x: 0, y: 0 }; }
        scheduleTransformUpdate();
      });
    }

    if (zoomResetBtn) zoomResetBtn.addEventListener("click", resetZoomAndPan);

    var loadSelBtn = wrapper.querySelector("#cmp-load-sel-btn");
    if (loadSelBtn) loadSelBtn.addEventListener("click", loadFromSelection);

    var swapBtn = wrapper.querySelector("#cmp-swap-btn");
    if (swapBtn) swapBtn.addEventListener("click", swapSlots);

    var infoBtn = wrapper.querySelector("#cmp-toggle-info");
    if (infoBtn) {
      infoBtn.addEventListener("click", function () {
        showInfoOverlay = !showInfoOverlay;
        infoBtn.classList.toggle("primary", showInfoOverlay);
        var oA = el("cmp-info-overlay-a");
        var oB = el("cmp-info-overlay-b");
        if (oA) oA.style.display = showInfoOverlay ? "block" : "none";
        if (oB) oB.style.display = showInfoOverlay ? "block" : "none";
      });
    }

    var clearBtn = wrapper.querySelector("#cmp-clear-all");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        slotA = { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" };
        slotB = { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" };
        resetZoomAndPan();
        updateSlotHeaders();
        renderCanvasDOM();
      });
    }

    var inputA = wrapper.querySelector("#slot-a-file-input");
    if (inputA) {
      inputA.addEventListener("change", function (e) {
        if (e.target.files && e.target.files[0]) {
          loadAssetIntoSlot("A", null, e.target.files[0]);
        }
      });
    }

    var inputB = wrapper.querySelector("#slot-b-file-input");
    if (inputB) {
      inputB.addEventListener("change", function (e) {
        if (e.target.files && e.target.files[0]) {
          loadAssetIntoSlot("B", null, e.target.files[0]);
        }
      });
    }

    var clearABtn = wrapper.querySelector("#slot-a-clear-btn");
    if (clearABtn) {
      clearABtn.addEventListener("click", function () {
        slotA = { id: null, path: "", url: "", name: "Image A", width: 0, height: 0, sizeStr: "" };
        updateSlotHeaders();
        renderCanvasDOM();
      });
    }

    var clearBBtn = wrapper.querySelector("#slot-b-clear-btn");
    if (clearBBtn) {
      clearBBtn.addEventListener("click", function () {
        slotB = { id: null, path: "", url: "", name: "Image B", width: 0, height: 0, sizeStr: "" };
        updateSlotHeaders();
        renderCanvasDOM();
      });
    }
  }

  // ── Render Canvas DOM Structure (Only called on mode switch or image change) ──
  function renderCanvasDOM() {
    var canvasArea = el("compare-canvas-area");
    if (!canvasArea) return;

    canvasArea.innerHTML = "";
    canvasArea.style.background = "var(--sys-window-bg, #ffffff)";

    var overlayA = slotA.url ? `
      <div id="cmp-info-overlay-a" style="position: absolute; bottom: 8px; left: 8px; background: rgba(0,0,0,0.8); color: #ffffff; padding: 4px 8px; border-radius: 2px; font-size: 10px; font-family: monospace; pointer-events: none; z-index: 10; display: ${showInfoOverlay ? "block" : "none"}; border: 1px solid #444;">
        A: ${slotA.width}×${slotA.height} | Zoom: ${Math.round(zoomA * 100)}%
      </div>
    ` : "";

    var overlayB = slotB.url ? `
      <div id="cmp-info-overlay-b" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: #ffffff; padding: 4px 8px; border-radius: 2px; font-size: 10px; font-family: monospace; pointer-events: none; z-index: 10; display: ${showInfoOverlay ? "block" : "none"}; border: 1px solid #444;">
        B: ${slotB.width}×${slotB.height} | Zoom: ${Math.round(zoomB * 100)}%
      </div>
    ` : "";

    if (mode === "side-by-side") {
      renderSideBySideDOM(canvasArea, overlayA, overlayB);
    } else if (mode === "h-slider") {
      renderHSliderDOM(canvasArea, overlayA, overlayB);
    } else if (mode === "v-slider") {
      renderVSliderDOM(canvasArea, overlayA, overlayB);
    } else if (mode === "onion") {
      renderOnionSkinDOM(canvasArea, overlayA, overlayB);
    }

    attachCanvasInteractions(canvasArea);
    scheduleTransformUpdate();
  }

  function placeholderHtml(slotName, targetSlot) {
    return `
      <div style="height: 100%; width: 100%; padding: 12px; box-sizing: border-box; display: flex; flex-direction: column; background: var(--sys-window-bg, #ffffff);">
        <div class="toolbox-drop-zone" data-slot="${targetSlot}" style="flex: 1; margin-top: 0; cursor: pointer;">
          <div class="toolbox-drop-icon"><i class="bi bi-cloud-arrow-up"></i></div>
          <span>Drag & Drop image here to compare</span>
          <span style="font-size: 10px; font-weight: 600; color: var(--sys-border-focus, #0078d7); margin-top: 4px;">Target: ${slotName}</span>
        </div>
      </div>
    `;
  }

  // ── Mode DOM Builders ─────────────────────────────────────────────────────
  function renderSideBySideDOM(container, overlayA, overlayB) {
    container.style.display = "flex";
    container.style.height = "100%";

    var vpA = document.createElement("div");
    vpA.className = "cmp-viewport";
    vpA.dataset.slot = "A";
    vpA.style.cssText = "flex: 1; position: relative; overflow: hidden; border-right: 1px solid var(--sys-border-dark, #b0b0b0); height: 100%; cursor: " + (slotA.url ? "grab" : "default") + "; background: " + (slotA.url ? "#1e1e1e" : "var(--sys-window-bg, #ffffff)") + ";";

    if (slotA.url) {
      vpA.innerHTML = `
        <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
          <img src="${slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
        </div>
        ${overlayA}
      `;
    } else {
      vpA.innerHTML = placeholderHtml("Image A", "A");
    }

    var vpB = document.createElement("div");
    vpB.className = "cmp-viewport";
    vpB.dataset.slot = "B";
    vpB.style.cssText = "flex: 1; position: relative; overflow: hidden; height: 100%; cursor: " + (slotB.url ? "grab" : "default") + "; background: " + (slotB.url ? "#1e1e1e" : "var(--sys-window-bg, #ffffff)") + ";";

    if (slotB.url) {
      vpB.innerHTML = `
        <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
          <img src="${slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
        </div>
        ${overlayB}
      `;
    } else {
      vpB.innerHTML = placeholderHtml("Image B", "B");
    }

    container.appendChild(vpA);
    container.appendChild(vpB);
  }

  function renderHSliderDOM(container, overlayA, overlayB) {
    container.style.display = "block";
    container.style.height = "100%";

    if (!slotA.url && !slotB.url) {
      container.innerHTML = placeholderHtml("Image A & B", "both");
      return;
    }

    var clipVal = 100 - splitPos;

    if (pinSplitterToImage) {
      // Pinned to Image Mode
      var html = `
        <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
          <!-- Shared Image Container (Pan & Zoom Transformed) -->
          <div id="cmp-wrapper-shared" style="position: absolute; inset: 0; transform-origin: center center; will-change: transform;">
            <!-- Base Layer: Image A -->
            <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
              <img src="${slotA.url || ''}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none; display: ${slotA.url ? 'block' : 'none'};" />
            </div>

            <!-- Overlay Layer: Image B inside GPU-composited div wrapper -->
            <div id="cmp-layer-b-pinned" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 ${clipVal}% 0 0); will-change: clip-path; display: ${slotB.url ? 'block' : 'none'};">
              <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
                <img src="${slotB.url || ''}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
              </div>
            </div>
          </div>

          <!-- Top-Level Crisp Screen-Space Handle -->
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
      container.innerHTML = html;
    } else {
      // Viewport-level Screen Wipe
      var html = `
        <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
          <!-- Base Viewport Layer: Image A -->
          <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
            <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
              ${slotA.url ? `<img src="${slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
            </div>
          </div>

          <!-- Overlay Viewport Layer: Image B with Viewport-level Clip Path -->
          <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 ${clipVal}% 0 0); will-change: clip-path;">
            <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
              ${slotB.url ? `<img src="${slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
            </div>
          </div>

          <!-- Handle Divider Line & Knob -->
          <div id="cmp-handle-h" style="position: absolute; top: 0; bottom: 0; left: calc(${splitPos}% - 12px); width: 24px; cursor: col-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: left;">
            <div style="position: absolute; top: 0; bottom: 0; left: 11px; width: 2px; background: #0078d7;"></div>
            <div class="win-button primary" style="width: 24px; height: 32px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
              <i class="bi bi-arrows-collapse"></i>
            </div>
          </div>

          ${overlayA}
          ${overlayB}
        </div>
      `;
      container.innerHTML = html;
    }
  }

  function renderVSliderDOM(container, overlayA, overlayB) {
    container.style.display = "block";
    container.style.height = "100%";

    if (!slotA.url && !slotB.url) {
      container.innerHTML = placeholderHtml("Image A & B", "both");
      return;
    }

    var clipVal = 100 - splitPos;

    if (pinSplitterToImage) {
      // Pinned to Image Mode
      var html = `
        <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
          <!-- Shared Image Container (Pan & Zoom Transformed) -->
          <div id="cmp-wrapper-shared" style="position: absolute; inset: 0; transform-origin: center center; will-change: transform;">
            <!-- Base Layer: Image A -->
            <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
              <img src="${slotA.url || ''}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none; display: ${slotA.url ? 'block' : 'none'};" />
            </div>

            <!-- Overlay Layer: Image B inside GPU-composited div wrapper -->
            <div id="cmp-layer-b-pinned" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 ${clipVal}% 0); will-change: clip-path; display: ${slotB.url ? 'block' : 'none'};">
              <div style="position: absolute; inset: 0; padding: 12px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;">
                <img src="${slotB.url || ''}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />
              </div>
            </div>
          </div>

          <!-- Top-Level Crisp Screen-Space Handle -->
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
      container.innerHTML = html;
    } else {
      // Viewport-level Screen Wipe
      var html = `
        <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
          <!-- Base Viewport Layer: Image A -->
          <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
            <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
              ${slotA.url ? `<img src="${slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
            </div>
          </div>

          <!-- Overlay Viewport Layer: Image B with Viewport-level Clip Path -->
          <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 ${clipVal}% 0); will-change: clip-path;">
            <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
              ${slotB.url ? `<img src="${slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
            </div>
          </div>

          <!-- Handle Divider Line & Knob -->
          <div id="cmp-handle-v" style="position: absolute; left: 0; right: 0; top: calc(${splitPos}% - 12px); height: 24px; cursor: row-resize; display: flex; align-items: center; justify-content: center; z-index: 20; will-change: top;">
            <div style="position: absolute; left: 0; right: 0; top: 11px; height: 2px; background: #0078d7;"></div>
            <div class="win-button primary" style="width: 32px; height: 24px; padding: 0; border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 1;">
              <i class="bi bi-arrows-collapse-vertical"></i>
            </div>
          </div>

          ${overlayA}
          ${overlayB}
        </div>
      `;
      container.innerHTML = html;
    }
  }

  function renderOnionSkinDOM(container, overlayA, overlayB) {
    container.style.display = "block";
    container.style.height = "100%";

    if (!slotA.url && !slotB.url) {
      container.innerHTML = placeholderHtml("Image A & B", "both");
      return;
    }

    var opacityVal = onionOpacity / 100;

    var html = `
      <div class="cmp-viewport" data-slot="both" style="position: absolute; inset: 0; overflow: hidden; cursor: grab; background: #1e1e1e;">
        <!-- Base Viewport Layer: Image A -->
        <div class="cmp-layer-a" style="position: absolute; inset: 0; overflow: hidden;">
          <div id="cmp-wrapper-a" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${slotA.url ? `<img src="${slotA.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
          </div>
        </div>

        <!-- Overlay Viewport Layer: Image B with Opacity -->
        <div id="cmp-layer-b" class="cmp-layer-b" style="position: absolute; inset: 0; overflow: hidden; opacity: ${opacityVal}; will-change: opacity;">
          <div id="cmp-wrapper-b" class="cmp-img-wrapper" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; transform-origin: center center; padding: 12px; box-sizing: border-box; will-change: transform;">
            ${slotB.url ? `<img src="${slotB.url}" style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; pointer-events: none;" />` : ''}
          </div>
        </div>

        ${overlayA}
        ${overlayB}
      </div>
    `;

    container.innerHTML = html;
  }

  // ── Drag, Pan, Zoom Event Handling ────────────────────────────────────────
  function processDroppedItems(dataTransfer, targetSlot) {
    if (!dataTransfer) return;

    if (dataTransfer.files && dataTransfer.files.length > 0) {
      var fileList = Array.from(dataTransfer.files);
      if (fileList.length >= 2) {
        loadAssetIntoSlot("A", null, fileList[0]);
        loadAssetIntoSlot("B", null, fileList[1]);
      } else {
        loadAssetIntoSlot(targetSlot, null, fileList[0]);
      }
      return;
    }

    if (dataTransfer.items && dataTransfer.items.length > 0) {
      var items = Array.from(dataTransfer.items);
      var fileItems = items.filter(function (it) { return it.kind === "file"; });
      if (fileItems.length > 0) {
        var files = fileItems.map(function (it) { return it.getAsFile(); }).filter(Boolean);
        if (files.length >= 2) {
          loadAssetIntoSlot("A", null, files[0]);
          loadAssetIntoSlot("B", null, files[1]);
        } else if (files.length === 1) {
          loadAssetIntoSlot(targetSlot, null, files[0]);
        }
        return;
      }
    }

    var uriList = dataTransfer.getData("text/uri-list");
    var plainText = dataTransfer.getData("text/plain");
    var rawPath = uriList || plainText;

    if (rawPath) {
      var lines = rawPath.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length >= 2) {
        loadAssetIntoSlot("A", { path: lines[0], asset_id: 0 });
        loadAssetIntoSlot("B", { path: lines[1], asset_id: 0 });
      } else if (lines.length === 1) {
        loadAssetIntoSlot(targetSlot, { path: lines[0], asset_id: 0 });
      }
    }
  }

  function attachCanvasInteractions(container) {
    var viewports = container.querySelectorAll(".cmp-viewport");

    viewports.forEach(function (vp) {
      var slotType = vp.dataset.slot || "both";

      vp.addEventListener("click", function (e) {
        var dz = e.target.closest(".toolbox-drop-zone");
        if (dz) {
          var targetSlot = dz.dataset.slot === "B" ? "B" : "A";
          var input = el(targetSlot === "B" ? "slot-b-file-input" : "slot-a-file-input");
          if (input) input.click();
        }
      });

      vp.addEventListener("wheel", function (e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 1.15 : 0.85;

        if (syncLock || slotType === "both" || slotType === "A") {
          zoomA = Math.min(Math.max(zoomA * delta, 0.1), 10.0);
        }
        if (syncLock || slotType === "both" || slotType === "B") {
          zoomB = syncLock ? zoomA : Math.min(Math.max(zoomB * delta, 0.1), 10.0);
        }

        scheduleTransformUpdate();
      }, { passive: false });

      vp.addEventListener("mousedown", function (e) {
        var handleH = el("cmp-handle-h");
        var handleV = el("cmp-handle-v");
        if ((handleH && handleH.contains(e.target)) || (handleV && handleV.contains(e.target))) {
          isDraggingSlider = true;
          return;
        }

        if (e.button !== 0) return;

        isDraggingPan = true;
        dragTargetSlot = slotType;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panInitialA = { x: panA.x, y: panA.y };
        panInitialB = { x: panB.x, y: panB.y };

        vp.style.cursor = "grabbing";
      });

      vp.addEventListener("dragenter", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        var dz = vp.querySelector(".toolbox-drop-zone");
        if (dz) dz.classList.add("toolbox-drop-active");
      });

      vp.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        var dz = vp.querySelector(".toolbox-drop-zone");
        if (dz) dz.classList.add("toolbox-drop-active");
      });

      vp.addEventListener("dragleave", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var dz = vp.querySelector(".toolbox-drop-zone");
        if (dz) dz.classList.remove("toolbox-drop-active");
      });

      vp.addEventListener("drop", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var dz = vp.querySelector(".toolbox-drop-zone");
        if (dz) dz.classList.remove("toolbox-drop-active");

        var targetSlot = slotType === "B" ? "B" : "A";
        processDroppedItems(e.dataTransfer, targetSlot);
      });
    });
  }

  function bindGlobalEventsOnce() {
    if (globalEventsBound) return;
    globalEventsBound = true;

    window.addEventListener("mousemove", function (e) {
      var container = el("compare-canvas-area");
      if (!container) return;

      if (isDraggingSlider) {
        var rect = container.getBoundingClientRect();
        if (mode === "h-slider") {
          var pct = 50;
          if (pinSplitterToImage) {
            var center = rect.width / 2;
            var screenRelToCenter = (e.clientX - rect.left) - center;
            var unpanned = screenRelToCenter - panA.x;
            var unscaled = unpanned / zoomA;
            var localX = unscaled + center;
            pct = (localX / rect.width) * 100;
          } else {
            var relX = e.clientX - rect.left;
            pct = (relX / rect.width) * 100;
          }
          splitPos = Math.min(Math.max(Math.round(pct), 0), 100);
          var sRange = el("cmp-slider-range");
          var sVal = el("cmp-slider-val");
          if (sRange) sRange.value = splitPos;
          if (sVal) sVal.textContent = splitPos + "%";
          scheduleTransformUpdate();
        } else if (mode === "v-slider") {
          var pct = 50;
          if (pinSplitterToImage) {
            var center = rect.height / 2;
            var screenRelToCenter = (e.clientY - rect.top) - center;
            var unpanned = screenRelToCenter - panA.y;
            var unscaled = unpanned / zoomA;
            var localY = unscaled + center;
            pct = (localY / rect.height) * 100;
          } else {
            var relY = e.clientY - rect.top;
            pct = (relY / rect.height) * 100;
          }
          splitPos = Math.min(Math.max(Math.round(pct), 0), 100);
          var sRange = el("cmp-slider-range");
          var sVal = el("cmp-slider-val");
          if (sRange) sRange.value = splitPos;
          if (sVal) sVal.textContent = splitPos + "%";
          scheduleTransformUpdate();
        }
        return;
      }

      if (isDraggingPan) {
        var dx = e.clientX - panStartX;
        var dy = e.clientY - panStartY;

        if (syncLock || dragTargetSlot === "both" || dragTargetSlot === "A") {
          panA.x = panInitialA.x + dx;
          panA.y = panInitialA.y + dy;
        }
        if (syncLock || dragTargetSlot === "both" || dragTargetSlot === "B") {
          panB.x = syncLock ? panA.x : (panInitialB.x + dx);
          panB.y = syncLock ? panA.y : (panInitialB.y + dy);
        }

        scheduleTransformUpdate();
      }
    });

    window.addEventListener("mouseup", function () {
      if (isDraggingPan || isDraggingSlider) {
        isDraggingPan = false;
        isDraggingSlider = false;
        var viewports = document.querySelectorAll(".cmp-viewport");
        viewports.forEach(function (vp) { vp.style.cursor = "grab"; });
      }
    });
  }

  // ── Register Plugin Tab & Capabilities ────────────────────────────────────
  PH.registerTab(TAB_ID, "Image Compare", "bi bi-layout-split", renderCompareTab);

  // Metadata Section Buttons (rendered inside Image Info Modal)
  PH.registerMetadataRenderer("image-compare-modal-section", function (asset) {
    if (!asset || !asset.path) return null;
    var box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-layout-split"></i> Image Compare</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Send image to Image Compare tool.</span>' +
      '  <button type="button" class="win-button" id="cmp-send-slot-a">' +
      '    <i class="bi bi-arrow-left-square"></i> Set as Image A' +
      '  </button>' +
      '  <button type="button" class="win-button" id="cmp-send-slot-b">' +
      '    <i class="bi bi-arrow-right-square"></i> Set as Image B' +
      '  </button>' +
      '</div>';

    var btnA = box.querySelector("#cmp-send-slot-a");
    if (btnA) {
      btnA.addEventListener("click", function () {
        loadAssetIntoSlot("A", asset);
        closeInfoModal();
        navigateToTab();
      });
    }

    var btnB = box.querySelector("#cmp-send-slot-b");
    if (btnB) {
      btnB.addEventListener("click", function () {
        loadAssetIntoSlot("B", asset);
        closeInfoModal();
        navigateToTab();
      });
    }

    return box;
  });

  // Toolbar Button ("Compare Selected") for grid toolbars
  PH.registerToolbarButton("compare-selected", "Compare Selected", "bi bi-layout-split", function (selection) {
    if (!selection || selection.length === 0) {
      alert("No images selected.");
      return;
    }
    if (selection.length >= 2) {
      loadAssetIntoSlot("A", selection[0]);
      loadAssetIntoSlot("B", selection[1]);
    } else {
      loadAssetIntoSlot("A", selection[0]);
    }
    closeInfoModal();
    navigateToTab();
  });

  // Context Menu Items
  PH.registerContextMenuItem("send-to-compare-a", "Compare: Set as Image A", function (asset) {
    if (!asset) return;
    loadAssetIntoSlot("A", asset);
    closeInfoModal();
    navigateToTab();
  });

  PH.registerContextMenuItem("send-to-compare-b", "Compare: Set as Image B", function (asset) {
    if (!asset) return;
    loadAssetIntoSlot("B", asset);
    closeInfoModal();
    navigateToTab();
  });

  console.log("Image Compare plugin initialized successfully.");
})();
