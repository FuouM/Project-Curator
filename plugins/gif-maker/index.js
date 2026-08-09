// Project Curator - GIF Maker & Editor Plugin (v1.0.0)
// Fully featured ezgif port with toolbar layout, real-time WYSIWYG, and undo/redo history.
(function () {
  "use strict";

  var PH = window.PluginHost;
  if (!PH) {
    console.error("gif-maker: PluginHost not available; aborting.");
    return;
  }

  var TAB_ID = "gif-maker";

  // State Variables
  var history = [];
  var historyIndex = -1;
  var currentMedia = null; // { path, type: 'image'|'video', width, height }
  var systemFonts = []; // unused now, but we keep an empty array for backward safety or we can remove
  var customFontName = "Roboto Condensed Bold";
  var currentTool = "maker"; // maker, trim, crop, caption, effects, optimize, split
  var sequencePattern = ""; // e.g. D:\renders\frame_%05d.png
  var activeJobId = null;
  var pollTimer = null;

  // CSS injection for our WinForms visual workspace
  var style = document.createElement("style");
  style.textContent = `
    #view-extensions-gif-maker.active {
      display: flex !important;
      flex-direction: column;
      height: calc(100vh - 140px);
      max-height: calc(100vh - 140px);
      overflow: hidden !important;
    }
    .gm-workspace {
      display: flex;
      flex-direction: row;
      gap: 12px;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
      padding: 8px;
      box-sizing: border-box;
      font-family: var(--sys-font-family, "Segoe UI", sans-serif);
      color: var(--sys-window-text, #000);
      background: var(--sys-window-bg, #f0f0f0);
    }
    .gm-left-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .gm-preview-container {
      flex: 1;
      border: 1px solid var(--sys-border, #a0a0a0);
      background: #202020;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .gm-preview-media {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    #gm-preview-video {
      pointer-events: auto;
    }
    #gm-preview-video::-webkit-media-controls-panel {
      display: flex !important;
      opacity: 1 !important;
    }
    .gm-preview-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
    }
    .gm-crop-box {
      position: absolute;
      border: 2px dashed #0078d7;
      background: rgba(0, 120, 215, 0.15);
      cursor: move;
      display: none;
    }
    .gm-crop-handle {
      position: absolute;
      width: 8px;
      height: 8px;
      background: #0078d7;
      border: 1px solid #fff;
    }
    .gm-crop-handle.se {
      bottom: -4px;
      right: -4px;
      cursor: se-resize;
    }
    .gm-right-panel {
      width: 360px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;
      min-height: 0;
      overflow: hidden;
    }
    .gm-toolbar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .gm-toolbar .win-button {
      font-size: 10px;
      padding: 4px 2px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      height: 36px;
      box-sizing: border-box;
    }
    .gm-toolbar .win-button.active {
      background: var(--sys-accent-light, #cce5ff);
      border-color: var(--sys-accent, #0078d7);
      font-weight: bold;
    }
    .gm-control-box {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .gm-history-box {
      height: 140px;
      display: flex;
      flex-direction: column;
    }
    .gm-history-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--sys-border-light, #d0d0d0);
      background: var(--sys-window-bg, #fff);
      font-size: 11px;
    }
    .gm-history-item {
      padding: 3px 6px;
      cursor: pointer;
      border-bottom: 1px solid #f0f0f0;
      display: flex;
      justify-content: space-between;
    }
    .gm-history-item:hover {
      background: #f5f5f5;
    }
    .gm-history-item.active {
      background: #e0eef9;
      font-weight: bold;
    }
    .gm-frame-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px;
      border: 1px solid #d0d0d0;
      background: #fff;
      margin-bottom: 4px;
      font-size: 10px;
    }
    .gm-frame-img {
      width: 40px;
      height: 40px;
      object-fit: cover;
      border: 1px solid #a0a0a0;
    }
    .gm-log-box {
      height: 140px;
      overflow-y: auto;
      background-color: #1e1e1e;
      color: #cccccc;
      border: 1px solid #7a7a7a;
      padding: 8px;
      font-family: 'Consolas', monospace;
      font-size: 11px;
      white-space: pre-wrap;
    }
    .gm-canvas-overlay {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  // Load Roboto Condensed Bold via font face if present
  var robotoFace = new FontFace(
    "Roboto Condensed Bold",
    "url(" + PH.convertFileSrc("plugins/gif-maker/Roboto_Condensed_Bold.otf") + ")"
  );
  robotoFace.load().then(function (loaded) {
    document.fonts.add(loaded);
    renderWysiwygCanvas();
  }).catch(function (err) {
    console.warn("gif-maker: Failed to load local Roboto font", err);
  });

  // Dynamic loading of user chosen font files
  function loadCustomFontFile(fontPath) {
    if (!fontPath) {
      customFontName = "Roboto Condensed Bold";
      renderWysiwygCanvas();
      return;
    }
    // Extract file name without extension to use as font-family name
    var baseName = fontPath.split(/[\\/]/).pop().split(".")[0] || "CustomFont";
    var convertedUrl = PH.convertFileSrc(fontPath);
    var newFace = new FontFace(baseName, "url(" + convertedUrl + ")");
    newFace.load().then(function (loaded) {
      document.fonts.add(loaded);
      customFontName = baseName;
      logConsole("Loaded custom font: " + baseName, "success");
      renderWysiwygCanvas();
    }).catch(function (err) {
      logConsole("Failed to load font file: " + fontPath, "error");
    });
  }
  // Register Toolbar Button in main Gallery
  PH.registerToolbarButton("gif-maker-create", "Create GIF", "bi bi-film", function (selection) {
    if (!selection || selection.length === 0) return;
    var tab = document.getElementById("tab-view-extensions-" + TAB_ID);
    if (tab) tab.click();
    if (currentTool === "maker") {
      droppedFrames = selection.map(function (asset) { return asset.path; });
      logConsole("Loaded " + droppedFrames.length + " frames from selection.", "success");
      renderDroppedFrames();
    } else {
      pushHistoryState(selection[0].path, "Imported selected file");
    }
  });

  // Register full view extension tab
  PH.registerTab(TAB_ID, "GIF Maker", "bi bi-film", function render() {
    var container = document.createElement("div");
    container.className = "gm-workspace";

    // HTML Structure matching desktop WinForms aesthetic
    container.innerHTML = `
      <div class="gm-left-panel">
        <div class="gm-preview-container" id="gm-drop-zone" style="background: var(--sys-window-bg, #f0f0f0); padding: 12px; display: flex; align-items: center; justify-content: center; position: relative;">
          <div class="toolbox-drop-zone" id="gm-empty-state" style="flex: 1; margin-top: 0; align-self: stretch; width: 100%; height: 100%; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;">
            <div class="toolbox-drop-icon"><i class="bi bi-images"></i></div>
            <span>Drag & Drop images or videos here to begin</span>
          </div>

          <div id="gm-composition-wrapper" style="display: none; flex-direction: column; align-items: center; max-width: 100%; max-height: 100%; box-sizing: border-box; overflow: hidden;">
            <!-- iFunny Top Concatenated Bar -->
            <div id="gm-ifunny-bar" style="display: none; background: #ffffff; color: #000000; font-family: 'Roboto Condensed Bold', Arial, sans-serif; font-weight: bold; text-align: center; box-sizing: border-box; flex: none; line-height: 1.05; padding: 0; white-space: pre-wrap; word-break: break-word; overflow: hidden;"></div>

            <!-- Media Content Box (also crop overlay anchor) -->
            <div id="gm-media-box" style="position: relative; display: block; flex: none;">
              <img class="gm-preview-media" id="gm-preview-img" style="display:none; object-fit: fill; flex: none; display: block;" />
              <video class="gm-preview-media" id="gm-preview-video" style="display:none; object-fit: fill; flex: none; display: block;" controls autoplay loop muted></video>

              <!-- Bottom Text Overlay -->
              <div id="gm-bottom-overlay" style="display: none; position: absolute; bottom: 20px; left: 5%; width: 90%; text-align: center; color: #ffffff; font-family: 'Roboto Condensed Bold', Arial, sans-serif; font-weight: bold; -webkit-text-stroke: var(--stroke-w, 4px) #000000; paint-order: stroke fill; pointer-events: none; line-height: 1.05; white-space: pre-wrap; word-break: break-word;"></div>

              <!-- Interactive Crop Overlay (positioned relative to gm-media-box) -->
              <div class="gm-preview-overlay" id="gm-overlay-interactive" style="display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; user-select: none; -webkit-user-select: none;">
                <div class="gm-crop-box" id="gm-crop-rect" style="display: none;">
                  <div class="gm-crop-handle se" id="gm-crop-resize-handle"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="group-box gm-history-box">
          <div class="group-box-title">Editing Steps History</div>
          <div style="display:flex; gap:6px; padding:3px 6px; border-bottom:1px solid var(--sys-border-light,#d0d0d0);">
            <button type="button" class="win-button" id="gm-btn-undo" disabled>
              <i class="bi bi-arrow-counterclockwise"></i> Undo
            </button>
            <button type="button" class="win-button" id="gm-btn-redo" disabled>
              <i class="bi bi-arrow-clockwise"></i> Redo
            </button>
            <span style="flex:1;"></span>
            <button type="button" class="win-button primary" id="gm-btn-save-final" disabled>
              <i class="bi bi-save2"></i> Save Final...
            </button>
          </div>
          <div class="gm-history-list" id="gm-hist-list">
            <div style="color:#808080; padding:6px; font-style:italic;">No files loaded.</div>
          </div>
        </div>
      </div>

      <div class="gm-right-panel">
        <div class="group-box" style="flex: none;">
          <div class="group-box-title">Source Media</div>
          <div style="padding: 6px; display: flex; gap: 6px;">
            <button type="button" class="win-button" id="gm-btn-browse-file" style="flex: 1; font-size: 11px;">
              <i class="bi bi-folder2-open"></i> Browse File...
            </button>
            <button type="button" class="win-button" id="gm-btn-load-selection" style="flex: 1; font-size: 11px;">
              <i class="bi bi-images"></i> Load Selection
            </button>
          </div>
        </div>

        <div class="group-box" style="flex: none;">
          <div class="group-box-title">Toolbox Menu</div>
          <div class="gm-toolbar">
            <button class="win-button active" id="gm-tool-maker" data-tool="maker"><i class="bi bi-images"></i>Maker</button>
            <button class="win-button" id="gm-tool-trim" data-tool="trim"><i class="bi bi-scissors"></i>Trim</button>
            <button class="win-button" id="gm-tool-crop" data-tool="crop"><i class="bi bi-crop"></i>Crop</button>
            <button class="win-button" id="gm-tool-caption" data-tool="caption"><i class="bi bi-chat-text"></i>Caption</button>
            <button class="win-button" id="gm-tool-effects" data-tool="effects"><i class="bi bi-magic"></i>Effects</button>
            <button class="win-button" id="gm-tool-optimize" data-tool="optimize"><i class="bi bi-speedometer2"></i>Optimize</button>
            <button class="win-button" id="gm-tool-split" data-tool="split"><i class="bi bi-grid-3x3-gap"></i>Split</button>
            <button class="win-button" id="gm-tool-export" data-tool="export"><i class="bi bi-arrow-left-right"></i>Resize</button>
          </div>
        </div>

        <div class="group-box gm-control-box">
          <div class="group-box-title" id="gm-control-title">GIF Maker Settings</div>
          <div id="gm-panel-content" style="padding:6px; display:flex; flex-direction:column; gap:8px; flex:1; overflow-y:auto; min-height:0;">
            <!-- Content dynamically generated by setupToolboxPane -->
          </div>
        </div>

        <div class="group-box" style="height:190px; display:flex; flex-direction:column; flex: none;">
          <div class="group-box-title"><i class="bi bi-terminal"></i> Output Log</div>
          <div style="display:flex; align-items:center; gap:8px; padding:4px 8px; border-bottom:1px solid var(--sys-border-light,#d0d0d0); background:#f5f5f5; flex:none;">
            <div class="progress-bar" style="height: 10px; border-radius: 2px;">
              <div id="gm-progress-bar" class="progress-fill" style="width:0%; border-radius: 2px; background: var(--sys-primary, #0078d4);"></div>
            </div>
            <span id="gm-progress-text" class="progress-text" style="font-size:10px; min-width:30px;">0%</span>
          </div>
          <div class="gm-log-box" id="gm-console" style="flex:1;"></div>
        </div>
      </div>
    `;

    // Hook events after inserting HTML
    setTimeout(function () {
      setupEvents(container);
      setupToolboxPane();
      setupInteractiveCrop();
    }, 50);

    return container;
  });

  // UI Event Bindings
  function setupEvents(root) {
    // Toolbar buttons
    var tools = root.querySelectorAll(".gm-toolbar .win-button");
    tools.forEach(function (btn) {
      btn.addEventListener("click", function () {
        tools.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        currentTool = btn.getAttribute("data-tool");
        var content = document.getElementById("gm-panel-content");
        if (content) content.removeAttribute("data-mounted-tool");
        setupToolboxPane();
      });
    });

    // Undo / Redo
    root.querySelector("#gm-btn-undo").addEventListener("click", function () {
      if (historyIndex > 0) {
        historyIndex--;
        restoreHistoryState();
      }
    });

    root.querySelector("#gm-btn-redo").addEventListener("click", function () {
      if (historyIndex < history.length - 1) {
        historyIndex++;
        restoreHistoryState();
      }
    });

    // Save Final
    root.querySelector("#gm-btn-save-final").addEventListener("click", handleSaveFinal);

    // Gallery load selection
    root.querySelector("#gm-btn-load-selection").addEventListener("click", handleLoadSelection);

    // Browse File Selection
    root.querySelector("#gm-btn-browse-file").addEventListener("click", handleBrowseFile);

    // Setup native Tauri dropzone hit-testing
    setupNativeDropZone(root.querySelector("#gm-drop-zone"));
  }

  // Visual Interactive Crop Controls
  var cropState = { x: 0, y: 0, w: 200, h: 200, dragging: false, resizing: false, needsReset: true };
  function setupInteractiveCrop() {
    var rect = document.getElementById("gm-crop-rect");
    var handle = document.getElementById("gm-crop-resize-handle");
    var container = document.getElementById("gm-overlay-interactive");
    if (!rect || !handle || !container) return;

    var updateVisuals = function () {
      rect.style.left = cropState.x + "px";
      rect.style.top = cropState.y + "px";
      rect.style.width = cropState.w + "px";
      rect.style.height = cropState.h + "px";
      // Update values in crop inputs if current tool is crop
      var inX = document.getElementById("gm-inp-crop-x");
      var inY = document.getElementById("gm-inp-crop-y");
      var inW = document.getElementById("gm-inp-crop-w");
      var inH = document.getElementById("gm-inp-crop-h");
      if (inX) inX.value = Math.round(cropState.x);
      if (inY) inY.value = Math.round(cropState.y);
      if (inW) inW.value = Math.round(cropState.w);
      if (inH) inH.value = Math.round(cropState.h);
    };

    rect.addEventListener("pointerdown", function (e) {
      if (e.target === handle) return;
      e.preventDefault();
      rect.setPointerCapture(e.pointerId);
      cropState.dragging = true;
      cropState.startX = e.clientX - cropState.x;
      cropState.startY = e.clientY - cropState.y;
    });

    handle.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      cropState.resizing = true;
      cropState.startW = cropState.w;
      cropState.startH = cropState.h;
      cropState.startX = e.clientX;
      cropState.startY = e.clientY;
    });

    window.addEventListener("pointermove", function (e) {
      var box = container.getBoundingClientRect();
      if (cropState.dragging) {
        cropState.x = Math.max(0, Math.min(box.width - cropState.w, e.clientX - cropState.startX));
        cropState.y = Math.max(0, Math.min(box.height - cropState.h, e.clientY - cropState.startY));
        updateVisuals();
      }
      if (cropState.resizing) {
        cropState.w = Math.max(20, Math.min(box.width - cropState.x, cropState.startW + (e.clientX - cropState.startX)));
        cropState.h = Math.max(20, Math.min(box.height - cropState.y, cropState.startH + (e.clientY - cropState.startY)));
        updateVisuals();
      }
    });

    window.addEventListener("pointerup", function () {
      cropState.dragging = false;
      cropState.resizing = false;
    });

    updateVisuals();
  }

  // ── Shared caption canvas builder ─────────────────────────────────────
  // Used by both the live preview and the compile path.
  // Returns { canvas, captionH, lines } at original video resolution.
  function buildCaptionCanvas(txt, originalW, style, customSize) {
    style = style || "ifunny";
    var isOverlay = style.startsWith("overlay");

    // Use custom font size or derive default (10% of width)
    var fontSize = customSize ? Math.round(customSize) : Math.round(originalW / 10);
    var lineH = fontSize * 1.2;
    var padY = lineH * 0.45;
    var padX = fontSize * 0.6;
    var textMaxW = originalW - padX * 2;
    var fontStr = "bold " + fontSize + "px '" + customFontName + "', 'Roboto Condensed Bold', Arial, sans-serif";

    // Pixel-accurate word wrap using measureText
    var measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = fontStr;

    var lines = [];
    txt.split("\n").forEach(function(para) {
      var words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(""); return; }
      var cur = "";
      words.forEach(function(word) {
        // Single word too wide — split character by character
        if (measureCtx.measureText(word).width > textMaxW) {
          if (cur) { lines.push(cur); cur = ""; }
          var partial = "";
          for (var c = 0; c < word.length; c++) {
            var ch = word[c];
            if (measureCtx.measureText(partial + ch).width > textMaxW) {
              if (partial) lines.push(partial);
              partial = ch;
            } else {
              partial += ch;
            }
          }
          if (partial) cur = partial;
          return;
        }
        var test = cur ? cur + " " + word : word;
        if (measureCtx.measureText(test).width > textMaxW && cur) {
          lines.push(cur);
          cur = word;
        } else {
          cur = test;
        }
      });
      if (cur) lines.push(cur);
    });
    if (!lines.length) lines.push(" ");

    var captionH = lines.length * lineH + padY * 2;

    var canvas = document.createElement("canvas");
    canvas.width = originalW;
    canvas.height = Math.ceil(captionH);
    var ctx = canvas.getContext("2d");

    if (isOverlay) {
      // Overlay style: transparent background, white text with a thick black stroke
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = fontStr;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      lines.forEach(function(line, i) {
        var x = originalW / 2;
        var y = padY + i * lineH + lineH / 2;
        
        // Draw black border outline
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = Math.max(3, Math.round(fontSize / 6));
        ctx.lineJoin = "round";
        ctx.strokeText(line, x, y, textMaxW);
        
        // Fill white text
        ctx.fillStyle = "#ffffff";
        ctx.fillText(line, x, y, textMaxW);
      });
    } else {
      // iFunny style: solid white background, black text
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000000";
      ctx.font = fontStr;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      lines.forEach(function(line, i) {
        ctx.fillText(line, originalW / 2, padY + i * lineH + lineH / 2, textMaxW);
      });
    }

    return { canvas: canvas, captionH: captionH, lines: lines };
  }
  // ──────────────────────────────────────────────────────────────────────

  // Position crop overlay and calculate stable proportional scaling
  function updateOverlayPosition() {
    var mediaEl = currentMedia && currentMedia.type === "video"
      ? document.getElementById("gm-preview-video")
      : document.getElementById("gm-preview-img");
    var container = document.getElementById("gm-overlay-interactive");
    var wrapper = document.getElementById("gm-composition-wrapper");
    var ifunnyBar = document.getElementById("gm-ifunny-bar");
    var bottomOverlay = document.getElementById("gm-bottom-overlay");
    var parent = document.getElementById("gm-drop-zone");
    var txt = document.getElementById("gm-inp-caption-text")?.value || "";
    var style = document.getElementById("gm-inp-caption-style")?.value || "ifunny";

    if (!mediaEl || !container || !currentMedia || !parent || !wrapper || !ifunnyBar || !bottomOverlay) return;

    if (mediaEl.style.display === "none") {
      container.style.display = "none";
      return;
    }

    var parentRect = parent.getBoundingClientRect();
    var maxW = parentRect.width - 24;
    var maxH = parentRect.height - 24;

    var originalW = currentMedia.width || 400;
    var originalH = currentMedia.height || 400;

    var txt = document.getElementById("gm-inp-caption-text")?.value || "";
    var captionStyle = document.getElementById("gm-inp-caption-style")?.value || "ifunny";

    // ── Step 1: Build caption canvas via shared function ─────────────────
    var captionH = 0;
    var captionDataUrl = null;

    if (txt.trim() && captionStyle === "ifunny") {
      var built = buildCaptionCanvas(txt, originalW);
      captionH = built.captionH;
      captionDataUrl = built.canvas.toDataURL("image/png");
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Step 2: Scale the whole composition to fit the viewport ──────────
    var totalOriginalH = originalH + captionH;
    var scale = Math.min(maxW / originalW, maxH / totalOriginalH);

    var displayW = Math.round(originalW * scale);
    var displayH = Math.round(displayW * originalH / originalW);
    var displayCaptionH = Math.round(captionH * scale);
    // ─────────────────────────────────────────────────────────────────────

    // ── Step 3: Set wrapper and elements ─────────────────────────────────
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.width = displayW + "px";
    wrapper.style.height = (displayH + displayCaptionH) + "px";
    wrapper.style.maxWidth = "";
    wrapper.style.maxHeight = "";
    wrapper.style.transform = "";

    // Caption bar: shown as scaled image — no font rendering surprises
    if (captionDataUrl && captionStyle === "ifunny") {
      bottomOverlay.style.display = "none";
      ifunnyBar.style.display = "block";
      ifunnyBar.style.width = displayW + "px";
      ifunnyBar.style.height = displayCaptionH + "px";
      ifunnyBar.style.padding = "0";
      ifunnyBar.style.fontSize = "";
      ifunnyBar.style.backgroundImage = "url('" + captionDataUrl + "')";
      ifunnyBar.style.backgroundSize = "100% 100%";
      ifunnyBar.style.backgroundRepeat = "no-repeat";
      ifunnyBar.textContent = "";
    } else if (txt.trim() && captionStyle !== "ifunny") {
      ifunnyBar.style.display = "none";
      bottomOverlay.style.display = "block";
      var sizeNum = document.getElementById("gm-inp-caption-size-num");
      var overlaySize = sizeNum ? parseInt(sizeNum.value) : Math.round(displayW / 10);
      bottomOverlay.textContent = txt;
      bottomOverlay.style.fontSize = overlaySize + "px";
      bottomOverlay.style.setProperty("--stroke-w", Math.max(2, Math.round(overlaySize / 6)) + "px");
      bottomOverlay.style.padding = "0px";
      
      if (captionStyle === "overlay_top") {
        bottomOverlay.style.top = "15px";
        bottomOverlay.style.bottom = "auto";
        bottomOverlay.style.transform = "none";
      } else if (captionStyle === "overlay_center") {
        bottomOverlay.style.top = "50%";
        bottomOverlay.style.bottom = "auto";
        bottomOverlay.style.transform = "translateY(-50%)";
      } else {
        bottomOverlay.style.bottom = "15px";
        bottomOverlay.style.top = "auto";
        bottomOverlay.style.transform = "none";
      }
    } else {
      ifunnyBar.style.display = "none";
      bottomOverlay.style.display = "none";
    }

    // Media element: exact pixel dimensions
    mediaEl.style.width = displayW + "px";
    mediaEl.style.height = displayH + "px";
    mediaEl.style.maxWidth = "";
    mediaEl.style.maxHeight = "";

    // Crop overlay is inside gm-media-box which is sized to displayW×displayH;
    // the HTML position:absolute top:0 left:0 width:100% height:100% covers it exactly.
    container.style.display = "block";

    var displayWForCrop = displayW;
    var displayHForCrop = displayH;

    if (cropState.needsReset) {
      cropState.x = 0;
      cropState.y = 0;
      cropState.w = displayWForCrop;
      cropState.h = displayHForCrop;
      cropState.needsReset = false;

      var r = document.getElementById("gm-crop-rect");
      if (r) {
        r.style.left = "0px";
        r.style.top = "0px";
        r.style.width = displayWForCrop + "px";
        r.style.height = displayHForCrop + "px";
      }

      var inX = document.getElementById("gm-inp-crop-x");
      var inY = document.getElementById("gm-inp-crop-y");
      var inW = document.getElementById("gm-inp-crop-w");
      var inH = document.getElementById("gm-inp-crop-h");
      if (inX) inX.value = 0;
      if (inY) inY.value = 0;
      if (inW) inW.value = Math.round(displayWForCrop);
      if (inH) inH.value = Math.round(displayHForCrop);
    }
  }

  window.addEventListener("resize", updateOverlayPosition);

  // Dynamic Toolbox Settings Panes
  function setupToolboxPane() {
    var title = document.getElementById("gm-control-title");
    var content = document.getElementById("gm-panel-content");
    var rect = document.getElementById("gm-crop-rect");
    var container = document.getElementById("gm-overlay-interactive");
    if (!title || !content) return;

    var prevVid = document.getElementById("gm-preview-video");
    if (prevVid && window.__gm_timeupdate_listener) {
      prevVid.removeEventListener("timeupdate", window.__gm_timeupdate_listener);
      window.__gm_timeupdate_listener = null;
    }

    if (rect) rect.style.display = currentTool === "crop" ? "block" : "none";
    if (container) {
      container.style.pointerEvents = currentTool === "crop" ? "auto" : "none";
      setTimeout(updateOverlayPosition, 50); // Small delay to let DOM layout settle
    }

    // Disable the Optimize button for non-GIF formats (dithering/color reduction only applies to GIF)
    var optimizeBtn = document.getElementById("gm-tool-optimize");
    var isGif = currentMedia && /\.gif$/i.test(currentMedia.path);
    if (optimizeBtn) {
      optimizeBtn.disabled = !isGif;
      optimizeBtn.title = isGif ? "" : "Optimize is only available for GIF files";
    }
    // If the active tool is Optimize but current file is not a GIF, switch to Maker
    if (currentTool === "optimize" && !isGif) {
      currentTool = "maker";
      var tools = document.querySelectorAll(".gm-toolbar .win-button");
      tools.forEach(function(b) { b.classList.remove("active"); });
      var makerBtn = document.getElementById("gm-tool-maker");
      if (makerBtn) makerBtn.classList.add("active");
      var panelContent = document.getElementById("gm-panel-content");
      if (panelContent) panelContent.removeAttribute("data-mounted-tool");
    }

    // Clear canvas when not in Caption tool
    var canvas = document.getElementById("gm-preview-canvas");
    if (canvas && currentTool !== "caption") {
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Keep track of the active mounted panel to avoid destructive redraws
    var mountedTool = content.getAttribute("data-mounted-tool");
    if (mountedTool === currentTool) {
      // Panel is already mounted; just update the "Before" size stat dynamically
      (async function() {
        var beforeEl = content.querySelector("#gm-opt-size-before");
        if (currentTool === "optimize" && currentMedia && beforeEl) {
          try {
            var size = await window.__TAURI__.core.invoke("get_file_size", { path: currentMedia.path });
            if (size !== null && size !== undefined) {
              beforeEl.textContent = formatBytes(size);
            }
          } catch(e) {}
        }
      })();
      return;
    }
    content.setAttribute("data-mounted-tool", currentTool);

    switch (currentTool) {
      case "maker":
        if (currentMedia && currentMedia.type === "video") {
          // --- Video mode ---
          title.textContent = "GIF / Video Maker";
          content.innerHTML = `
            <div style="flex: none; display: flex; flex-direction: column; gap: 6px;">
              <div style="font-size:11px; color:#888; padding:4px 0; border-bottom:1px solid var(--sys-border-light,#d0d0d0); margin-bottom:2px;">
                <i class="bi bi-film"></i> Video loaded &mdash; converting to animation
              </div>

              <label style="font-size:11px; font-weight:bold;">Frame Rate (FPS)</label>
              <div style="display:flex; align-items:center; gap:6px;">
                <input type="number" class="win-input" id="gm-inp-fps" value="15" min="1" max="60" style="width:70px;" />
                <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer;">
                <input type="checkbox" id="gm-chk-native-fps" checked /> Keep original
              </label>
            </div>

            <label style="font-size:11px; font-weight:bold;">Loop Count</label>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="win-input" id="gm-inp-loop" value="0" style="width:70px;" />
              <span style="font-size:10px; color:#666;">(0 = Infinite, -1 = Once)</span>
            </div>

            <label style="font-size:11px; font-weight:bold;">Target Output Format</label>
            <select class="win-input" id="gm-inp-maker-format" style="width:100%;">
              <option value="gif">Animated GIF (.gif)</option>
              <option value="webp">Animated WebP (.webp) — Lossless</option>
              <option value="mp4">H.264 Video (.mp4)</option>
              <option value="webm">VP9 Video (.webm)</option>
            </select>

            <button type="button" class="win-button primary" id="gm-btn-compile-gif" style="width:100%; margin-top:4px; padding:4px 0;">
              <i class="bi bi-gear-wide-connected"></i> Compile to Animation
            </button>
          </div>
        `;
        content.querySelector("#gm-btn-compile-gif").addEventListener("click", compileMakerVideo);
        var nativeFpsChk = content.querySelector("#gm-chk-native-fps");
        var fpsInp = content.querySelector("#gm-inp-fps");
        
        // Disable by default since checked by default
        fpsInp.disabled = true;
        fpsInp.style.opacity = "0.4";

        nativeFpsChk.addEventListener("change", function () {
          fpsInp.disabled = this.checked;
          fpsInp.style.opacity = this.checked ? "0.4" : "1";
        });
        } else {
          // --- Image sequence mode ---
          title.textContent = "GIF / Video Maker";
          content.innerHTML = `
            <div style="flex: none; display: flex; flex-direction: column; gap: 6px;">
              <div style="font-size:11px; color:#888; padding:4px 0; border-bottom:1px solid var(--sys-border-light,#d0d0d0); margin-bottom:2px;">
                <i class="bi bi-images"></i> Drop a video to convert it, or enter an image sequence pattern below.
              </div>

              <label style="font-size:11px; font-weight:bold;">Image Sequence Pattern</label>
              <input type="text" class="win-input" id="gm-inp-seq-pattern"
                placeholder="e.g. D:\renders\frame_%05d.png"
                value="${sequencePattern}"
                style="width:100%; font-size:10px; font-family:monospace;" />
              <div style="font-size:10px; color:#888;">Use printf-style numbering: <code>%04d</code>, <code>%05d</code>, etc.</div>

              <label style="font-size:11px; font-weight:bold; margin-top:4px;">Frame Rate (FPS)</label>
              <div style="display:flex; align-items:center; gap:6px;">
                <input type="number" class="win-input" id="gm-inp-fps" value="24" min="1" max="120" style="width:70px;" />
                <span style="font-size:11px;">frames per second</span>
              </div>

              <label style="font-size:11px; font-weight:bold;">Loop Count</label>
              <div style="display:flex; align-items:center; gap:6px;">
                <input type="number" class="win-input" id="gm-inp-loop" value="0" style="width:70px;" />
                <span style="font-size:10px; color:#666;">(0 = Infinite, -1 = Once)</span>
              </div>

              <label style="font-size:11px; font-weight:bold;">Target Output Format</label>
              <select class="win-input" id="gm-inp-maker-format" style="width:100%;">
                <option value="gif">Animated GIF (.gif)</option>
                <option value="webp">Animated WebP (.webp) — Lossless</option>
                <option value="mp4">H.264 Video (.mp4)</option>
                <option value="webm">VP9 Video (.webm)</option>
              </select>

              <button type="button" class="win-button primary" id="gm-btn-compile-gif" style="width:100%; margin-top:4px; padding:4px 0;">
                <i class="bi bi-gear-wide-connected"></i> Compile Sequence
              </button>
            </div>
          `;
          content.querySelector("#gm-inp-seq-pattern").addEventListener("input", function () {
            sequencePattern = this.value.trim();
          });
          content.querySelector("#gm-btn-compile-gif").addEventListener("click", compileImagesToAnimation);
        }
        break;

      case "trim":
        title.textContent = "Video Trimming & FPS";
        (function() {
          var fps = (currentMedia && currentMedia.fps) ? currentMedia.fps : 30.0;
          var dur = (currentMedia && currentMedia.durationMs) ? currentMedia.durationMs / 1000 : 10.0;
          var totalF = (currentMedia && currentMedia.totalFrames) ? currentMedia.totalFrames : Math.round(dur * fps);
          
          var activeExt = (currentMedia && currentMedia.path) ? currentMedia.path.split('.').pop().toLowerCase() : "gif";
          if (activeExt === "mov" || activeExt === "avi" || activeExt === "mkv") activeExt = "mp4";

          content.innerHTML = `
            <div style="font-size:11px; color:#555; background:var(--sys-window-bg,#f5f5f5); border:1px solid var(--sys-border-light,#d0d0d0); padding:6px; border-radius:2px; margin-bottom:10px;">
              <div style="display:flex; justify-content:space-between; border-bottom:1px dashed #d0d0d0; padding-bottom:3px; margin-bottom:3px;">
                <strong>Playhead:</strong> <span id="gm-trim-info-playhead" style="font-family:monospace; font-weight:bold; color:#dc3545;">0.00s (Frame 0)</span>
              </div>
              <div style="display:flex; justify-content:space-between;"><strong>Duration:</strong> <span>${(currentMedia && currentMedia.durationMs) ? (currentMedia.durationMs / 1000).toFixed(2) + "s" : "Unknown"}</span></div>
              <div style="display:flex; justify-content:space-between;"><strong>Total Frames:</strong> <span>${(currentMedia && currentMedia.totalFrames) ? currentMedia.totalFrames : "Unknown"}</span></div>
              <div style="display:flex; justify-content:space-between;"><strong>Probed FPS:</strong> <span>${(currentMedia && currentMedia.fps) ? currentMedia.fps.toFixed(2) : "Unknown"}</span></div>
            </div>

            <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:6px;">Timeline Range Selection</label>
            <div id="gm-trim-timeline" style="position:relative; height:20px; background:#e5e7eb; border:1px solid #ccc; border-radius:2px; margin-bottom:14px; user-select:none; -webkit-user-select:none;">
              <div id="gm-timeline-range" style="position:absolute; top:0; bottom:0; left:0%; right:0%; background:rgba(0, 120, 212, 0.25); border-left:2px solid #0078d4; border-right:2px solid #0078d4;"></div>
              <div id="gm-timeline-playhead" style="position:absolute; top:0; bottom:0; left:0%; width:2px; background:#dc3545; z-index:9; pointer-events:none;">
                <div style="position:absolute; top:-4px; left:-4px; width:10px; height:6px; background:#dc3545; clip-path:polygon(0% 0%, 100% 0%, 50% 100%);"></div>
              </div>
              <div id="gm-timeline-thumb-l" style="position:absolute; top:-3px; left:0%; width:10px; height:24px; background:#0078d4; border:1px solid #005a9e; border-radius:2px; cursor:ew-resize; box-shadow:0 1px 3px rgba(0,0,0,0.3); z-index:10;"></div>
              <div id="gm-timeline-thumb-r" style="position:absolute; top:-3px; left:100%; width:10px; height:24px; background:#0078d4; border:1px solid #005a9e; border-radius:2px; cursor:ew-resize; box-shadow:0 1px 3px rgba(0,0,0,0.3); z-index:10;"></div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Start Time (s)</label>
                <input type="number" class="win-input" id="gm-inp-trim-start" value="0" step="0.1" style="width:100%;" />
              </div>
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Start Frame</label>
                <input type="number" class="win-input" id="gm-inp-trim-start-frame" value="0" step="1" style="width:100%;" />
              </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">End Time (s)</label>
                <input type="number" class="win-input" id="gm-inp-trim-end" value="${dur.toFixed(2)}" step="0.1" style="width:100%;" />
              </div>
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">End Frame</label>
                <input type="number" class="win-input" id="gm-inp-trim-end-frame" value="${totalF}" step="1" style="width:100%;" />
              </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Frame Rate (FPS)</label>
                <select class="win-input" id="gm-inp-trim-fps" style="width:100%;">
                  <option value="5" ${Math.round(fps) === 5 ? 'selected' : ''}>5 FPS</option>
                  <option value="10" ${Math.round(fps) === 10 ? 'selected' : ''}>10 FPS</option>
                  <option value="12" ${Math.round(fps) === 12 ? 'selected' : ''}>12 FPS</option>
                  <option value="15" ${Math.round(fps) === 15 ? 'selected' : ''}>15 FPS</option>
                  <option value="20" ${Math.round(fps) === 20 ? 'selected' : ''}>20 FPS</option>
                  <option value="25" ${Math.round(fps) === 25 ? 'selected' : ''}>25 FPS</option>
                  <option value="30" ${Math.round(fps) >= 30 || Math.round(fps) < 5 ? 'selected' : ''}>30 FPS</option>
                </select>
              </div>
              <div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:2px;">Output Format</label>
                <select class="win-input" id="gm-inp-trim-format" style="width:100%;">
                  <option value="gif" ${activeExt === 'gif' ? 'selected' : ''}>GIF (.gif)</option>
                  <option value="webp" ${activeExt === 'webp' ? 'selected' : ''}>WebP (.webp)</option>
                  <option value="mp4" ${activeExt === 'mp4' ? 'selected' : ''}>MP4 (.mp4)</option>
                  <option value="webm" ${activeExt === 'webm' ? 'selected' : ''}>WebM (.webm)</option>
                </select>
              </div>
            </div>
            <button type="button" class="win-button primary" id="gm-btn-apply-trim" style="width:100%; margin-top:4px;">
              <i class="bi bi-scissors"></i> Convert &amp; Trim Video
            </button>
          `;

          var tStart = content.querySelector("#gm-inp-trim-start");
          var fStart = content.querySelector("#gm-inp-trim-start-frame");
          var tEnd = content.querySelector("#gm-inp-trim-end");
          var fEnd = content.querySelector("#gm-inp-trim-end-frame");

          var timeline = content.querySelector("#gm-trim-timeline");
          var range = content.querySelector("#gm-timeline-range");
          var thumbL = content.querySelector("#gm-timeline-thumb-l");
          var thumbR = content.querySelector("#gm-timeline-thumb-r");

          var pctL = 0;
          var pctR = 100;

          function updateTimelineUI() {
            range.style.left = pctL + "%";
            range.style.width = (pctR - pctL) + "%";
            thumbL.style.left = "calc(" + pctL + "% - 5px)";
            thumbR.style.left = "calc(" + pctR + "% - 5px)";
          }

          function syncInputsFromTimeline() {
            var startS = (pctL / 100) * dur;
            var endS = (pctR / 100) * dur;
            
            tStart.value = startS.toFixed(2);
            fStart.value = Math.round(startS * fps);
            
            tEnd.value = endS.toFixed(2);
            fEnd.value = Math.round(endS * fps);
          }

          function syncTimelineFromInputs() {
            var startVal = parseFloat(tStart.value) || 0;
            var endVal = parseFloat(tEnd.value) || 0;
            
            pctL = Math.max(0, Math.min(100, (startVal / dur) * 100));
            pctR = Math.max(0, Math.min(100, (endVal / dur) * 100));
            
            if (pctL > pctR) pctL = pctR;
            
            updateTimelineUI();
          }

          // Handle Left Thumb Drag
          thumbL.addEventListener("pointerdown", function(e) {
            e.preventDefault();
            thumbL.setPointerCapture(e.pointerId);
            var onPointerMove = function(ev) {
              var rect = timeline.getBoundingClientRect();
              var clientX = ev.clientX;
              var relativeX = clientX - rect.left;
              var pct = (relativeX / rect.width) * 100;
              pctL = Math.max(0, Math.min(pctR - 1, pct));
              updateTimelineUI();
              syncInputsFromTimeline();
            };
            var onPointerUp = function(ev) {
              thumbL.releasePointerCapture(ev.pointerId);
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
          });

          // Handle Right Thumb Drag
          thumbR.addEventListener("pointerdown", function(e) {
            e.preventDefault();
            thumbR.setPointerCapture(e.pointerId);
            var onPointerMove = function(ev) {
              var rect = timeline.getBoundingClientRect();
              var clientX = ev.clientX;
              var relativeX = clientX - rect.left;
              var pct = (relativeX / rect.width) * 100;
              pctR = Math.max(pctL + 1, Math.min(100, pct));
              updateTimelineUI();
              syncInputsFromTimeline();
            };
            var onPointerUp = function(ev) {
              thumbR.releasePointerCapture(ev.pointerId);
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
          });

          // Time Input events
          tStart.addEventListener("input", function() {
            var val = parseFloat(this.value) || 0;
            fStart.value = Math.round(val * fps);
            syncTimelineFromInputs();
          });
          fStart.addEventListener("input", function() {
            var val = parseInt(this.value) || 0;
            tStart.value = (val / fps).toFixed(3);
            syncTimelineFromInputs();
          });

          tEnd.addEventListener("input", function() {
            var val = parseFloat(this.value) || 0;
            fEnd.value = Math.round(val * fps);
            syncTimelineFromInputs();
          });
          fEnd.addEventListener("input", function() {
            var val = parseInt(this.value) || 0;
            tEnd.value = (val / fps).toFixed(3);
            syncTimelineFromInputs();
          });

          var playhead = content.querySelector("#gm-timeline-playhead");
          var vid = document.getElementById("gm-preview-video");

          var playheadText = content.querySelector("#gm-trim-info-playhead");
          var updatePlayheadText = function(timeSecs) {
            if (playheadText) {
              var frameIdx = Math.round(timeSecs * fps);
              playheadText.textContent = timeSecs.toFixed(2) + "s (Frame " + frameIdx + ")";
            }
          };

          var evSeeking = false;
          var syncPlayheadWithVideo = function() {
            if (vid && !evSeeking && dur > 0) {
              var startVal = parseFloat(tStart.value) || 0;
              var endVal = parseFloat(tEnd.value) || dur;
              
              if (vid.currentTime > endVal || vid.currentTime < startVal) {
                vid.currentTime = startVal;
              }

              var pct = (vid.currentTime / dur) * 100;
              playhead.style.left = Math.max(0, Math.min(100, pct)) + "%";
              updatePlayheadText(vid.currentTime);
            }
          };

          if (vid) {
            window.__gm_timeupdate_listener = syncPlayheadWithVideo;
            vid.addEventListener("timeupdate", syncPlayheadWithVideo);
          }

          var seekTimeline = function(ev) {
            var rect = timeline.getBoundingClientRect();
            if (rect.width <= 0) return;
            var pct = ((ev.clientX - rect.left) / rect.width) * 100;
            pct = Math.max(0, Math.min(100, pct));
            playhead.style.left = pct + "%";
            var targetTime = (pct / 100) * dur;
            if (vid && dur > 0) {
              vid.currentTime = targetTime;
            }
            updatePlayheadText(targetTime);
          };

          timeline.addEventListener("pointerdown", function(e) {
            if (e.target === thumbL || e.target === thumbR) return;
            e.preventDefault();
            timeline.setPointerCapture(e.pointerId);
            evSeeking = true;
            seekTimeline(e);
            var onPointerMove = function(ev) {
              seekTimeline(ev);
            };
            var onPointerUp = function(ev) {
              timeline.releasePointerCapture(ev.pointerId);
              evSeeking = false;
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
          });

          // Initial UI setup
          syncTimelineFromInputs();

          content.querySelector("#gm-btn-apply-trim").addEventListener("click", handleTrimVideo);
        })();
        break;

      case "crop":
        title.textContent = "Crop Canvas Coordinates";
        content.innerHTML = `
          <div style="font-size:10px; color:#666; margin-bottom:6px;">Drag/resize the overlay box in the preview or set exact pixel dimensions.</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
            <div>
              <label style="font-size:11px; font-weight:bold;">Left (X)</label>
              <input type="number" class="win-input" id="gm-inp-crop-x" value="50" style="width:100%;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold;">Top (Y)</label>
              <input type="number" class="win-input" id="gm-inp-crop-y" value="50" style="width:100%;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold;">Width</label>
              <input type="number" class="win-input" id="gm-inp-crop-w" value="200" style="width:100%;" />
            </div>
            <div>
              <label style="font-size:11px; font-weight:bold;">Height</label>
              <input type="number" class="win-input" id="gm-inp-crop-h" value="200" style="width:100%;" />
            </div>
          </div>
          <button type="button" class="win-button primary" id="gm-btn-apply-crop" style="width:100%;">
            <i class="bi bi-crop"></i> Apply Crop Boundary
          </button>
        `;
        // Wire visual crop synchronizers
        var inX = content.querySelector("#gm-inp-crop-x");
        var inY = content.querySelector("#gm-inp-crop-y");
        var inW = content.querySelector("#gm-inp-crop-w");
        var inH = content.querySelector("#gm-inp-crop-h");
        [inX, inY, inW, inH].forEach(function (input) {
          input.addEventListener("input", function () {
            cropState.x = parseFloat(inX.value) || 0;
            cropState.y = parseFloat(inY.value) || 0;
            cropState.w = parseFloat(inW.value) || 100;
            cropState.h = parseFloat(inH.value) || 100;
            var rect = document.getElementById("gm-crop-rect");
            if (rect) {
              rect.style.left = cropState.x + "px";
              rect.style.top = cropState.y + "px";
              rect.style.width = cropState.w + "px";
              rect.style.height = cropState.h + "px";
            }
          });
        });
        content.querySelector("#gm-btn-apply-crop").addEventListener("click", handleApplyCrop);
        break;

      case "caption":
        title.textContent = "Caption & Text Overlays";
        (function() {
          var displayW = document.getElementById("gm-composition-wrapper")?.clientWidth || 400;
          var defaultSize = Math.max(8, Math.min(120, Math.round(displayW / 12)));

          content.innerHTML = `
            <label style="font-size:11px; font-weight:bold;">Caption Text</label>
            <textarea class="win-input" id="gm-inp-caption-text" rows="3" style="width:100%; margin-bottom:8px; font-size:12px;" placeholder="Caption goes here..."></textarea>
            
            <label style="font-size:11px; font-weight:bold;">Caption Layout Style</label>
            <select class="win-input" id="gm-inp-caption-style" style="width:100%; margin-bottom:8px;">
              <option value="ifunny" selected>iFunny Style (White top border)</option>
              <option value="overlay_top">Overlay Style - Top</option>
              <option value="overlay_center">Overlay Style - Center</option>
              <option value="overlay_bottom">Overlay Style - Bottom</option>
            </select>

            <!-- Overlay Options (shown only if layout is overlay_*) -->
            <div id="gm-caption-overlay-opts" style="display:none; margin-bottom:8px;">
              <div class="group-box" style="margin-bottom:8px; padding:6px;">
                <div class="group-box-title">Overlay Customizations</div>
                <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">Font Size</label>
                <div style="display:flex; align-items:center; gap:6px;">
                  <input type="range" id="gm-inp-caption-size-range" min="8" max="120" value="${defaultSize}" style="flex:1;" />
                  <input type="number" class="win-input" id="gm-inp-caption-size-num" value="${defaultSize}" min="8" style="width:50px; text-align:center;" />
                  <span style="font-size:11px;">px</span>
                </div>
              </div>
            </div>
            
            <label style="font-size:11px; font-weight:bold;">Font Selection</label>
            <div style="display:flex; gap:6px; margin-bottom:8px;">
              <input type="text" class="win-input" id="gm-inp-caption-font" style="flex:1; font-size:11px;" placeholder="Roboto Condensed Bold (Default)" readonly />
              <button type="button" class="win-button" id="gm-btn-browse-font" style="font-size:11px;">Browse...</button>
            </div>

            <button type="button" class="win-button primary" id="gm-btn-apply-caption" style="width:100%;">
              <i class="bi bi-chat-square-text"></i> Render Caption Overlay
            </button>
          `;
          populateFontsDropdown();
          var txtArea = content.querySelector("#gm-inp-caption-text");
          var styleSel = content.querySelector("#gm-inp-caption-style");
          var fontInp = content.querySelector("#gm-inp-caption-font");
          var browseFontBtn = content.querySelector("#gm-btn-browse-font");
          
          var overlayOpts = content.querySelector("#gm-caption-overlay-opts");
          var sizeRange = content.querySelector("#gm-inp-caption-size-range");
          var sizeNum = content.querySelector("#gm-inp-caption-size-num");

          function syncOverlayOptsVisibility() {
            if (styleSel.value.startsWith("overlay")) {
              overlayOpts.style.display = "block";
            } else {
              overlayOpts.style.display = "none";
            }
          }
          
          styleSel.addEventListener("change", function() {
            syncOverlayOptsVisibility();
            renderWysiwygCanvas();
          });
          
          sizeRange.addEventListener("input", function() {
            sizeNum.value = this.value;
            renderWysiwygCanvas();
          });
          
          sizeNum.addEventListener("input", function() {
            var val = Math.max(8, Math.min(120, parseInt(this.value) || 28));
            sizeRange.value = val;
            renderWysiwygCanvas();
          });

          [txtArea, styleSel].forEach(function (el) {
            el.addEventListener("input", renderWysiwygCanvas);
          });

          browseFontBtn.addEventListener("click", function () {
            if (window.__TAURI__ && window.__TAURI__.core) {
              window.__TAURI__.core.invoke("select_path", { isDirectory: false }).then(function (path) {
                if (path) {
                  var ext = path.split('.').pop().toLowerCase();
                  if (ext === "ttf" || ext === "otf") {
                    var fileName = path.split(/[\\/]/).pop();
                    fontInp.value = fileName;
                    loadCustomFontFile(path);
                  } else {
                    logConsole("Warning: Please select a valid .ttf or .otf file.", "error");
                  }
                }
              }).catch(function (err) {
                logConsole("Error selecting path: " + err, "error");
              });
            } else {
              logConsole("Tauri core invoke API not available.", "error");
            }
          });
          content.querySelector("#gm-btn-apply-caption").addEventListener("click", handleApplyCaption);
        })();
        break;

      case "effects":
        title.textContent = "Speed, Bounce, Filters";
        content.innerHTML = `
          <label style="font-size:11px; font-weight:bold;">Playback Speed</label>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <input type="range" id="gm-inp-speed" min="0.25" max="3" step="0.25" value="1.0" style="flex:1;" />
            <span id="gm-txt-speed" style="font-size:11px; width:40px;">1.0x</span>
          </div>

          <label style="font-weight:bold; font-size:11px;">Transpose / Rotation</label>
          <select class="win-input" id="gm-inp-rotate" style="width:100%; margin-bottom:8px;">
            <option value="">No rotation</option>
            <option value="90_cw">90° Clockwise</option>
            <option value="90_ccw">90° Counter-Clockwise</option>
            <option value="180">180° Flip</option>
            <option value="hflip">Flip Horizontally</option>
            <option value="vflip">Flip Vertically</option>
          </select>

          <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px;">
            <label style="font-size:11px;"><input type="checkbox" id="gm-inp-reverse" /> Reverse Direction</label>
            <label style="font-size:11px;"><input type="checkbox" id="gm-inp-bounce" /> Bounce Loop (Forward + Reverse)</label>
          </div>

          <div style="border-top:1px solid #d0d0d0; padding-top:6px; display:flex; flex-direction:column; gap:4px;">
            <label style="font-size:11px;"><input type="checkbox" id="gm-inp-grayscale" /> Grayscale</label>
            <label style="font-size:11px;"><input type="checkbox" id="gm-inp-invert" /> Negate (Invert Colors)</label>
          </div>

          <button type="button" class="win-button primary" id="gm-btn-apply-effects" style="width:100%; margin-top:8px;">
            <i class="bi bi-sliders"></i> Apply Speed & Filter Effects
          </button>
        `;
        var slider = content.querySelector("#gm-inp-speed");
        var valTxt = content.querySelector("#gm-txt-speed");
        slider.addEventListener("input", function () {
          valTxt.textContent = slider.value + "x";
        });
        content.querySelector("#gm-btn-apply-effects").addEventListener("click", handleApplyEffects);
        break;

      case "optimize":
        title.textContent = "Optimize & Reduce Size";
        var sizeBefore = "Scanning...";
        var sizeAfter = "&mdash;";

        var compressionLine = "";
        if (historyIndex >= 0 && historyIndex < history.length) {
          var aState = history[historyIndex];
          if (aState.description.indexOf("Optimized") !== -1) {
            var pState = history[historyIndex - 1];
            sizeBefore = pState && pState.fileSize ? formatBytes(pState.fileSize) : "Unknown";
            sizeAfter = aState.fileSize ? formatBytes(aState.fileSize) : "Unknown";
            if (pState && pState.fileSize && aState.fileSize && pState.fileSize > 0) {
              var savedPct = (100 - (aState.fileSize / pState.fileSize) * 100).toFixed(1);
              var factor = (pState.fileSize / aState.fileSize).toFixed(2);
              compressionLine = savedPct > 0
                ? `<span style="color:#10b981;">&#8595; saved ${savedPct}% &mdash; ${factor}x smaller</span>`
                : `<span style="color:#f87171;">&#8593; grew ${Math.abs(savedPct)}% &mdash; ${factor}x larger</span>`;
            }
          } else {
            sizeBefore = aState.fileSize ? formatBytes(aState.fileSize) : "Scanning...";
          }
        }

        content.innerHTML = `
          <div class="group-box" style="margin-bottom:8px;">
            <div class="group-box-title">Compression Statistics</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:4px 0; text-align:center;">
              <div style="font-size:10px; color:var(--sys-text-subtle,#666);">Before</div>
              <div style="font-size:10px; color:var(--sys-text-subtle,#666);">After</div>
              <div id="gm-opt-size-before" style="font-size:12px; font-weight:bold; padding:4px; background:var(--sys-control-bg,#fff); border:1px solid var(--sys-border-dark,#999);">${sizeBefore}</div>
              <div id="gm-opt-size-after" style="font-size:12px; font-weight:bold; padding:4px; background:var(--sys-control-bg,#fff); border:1px solid var(--sys-border-dark,#999); color:#555;">${sizeAfter}</div>
            </div>
            <div style="text-align:center; font-size:11px; padding:4px 0 2px; min-height:18px;" id="gm-opt-compression-factor">
              ${compressionLine || "<span style=\"color:var(--sys-text-subtle,#666);\">&mdash;</span>"}
            </div>
          </div>

          <label style="font-size:11px; font-weight:bold;">Color Reduction</label>
          <select class="win-input" id="gm-inp-colors" style="width:100%; margin-bottom:8px;">
            <option value="256" selected>256 Colors (No reduction)</option>
            <option value="128">128 Colors</option>
            <option value="64">64 Colors</option>
            <option value="32">32 Colors</option>
            <option value="16">16 Colors</option>
          </select>

          <label style="font-size:11px; font-weight:bold;">Dithering Algorithm</label>
          <select class="win-input" id="gm-inp-dither" style="width:100%; margin-bottom:8px;">
            <option value="floyd_steinberg" selected>Floyd Steinberg (Default Quality)</option>
            <option value="bayer">Bayer Ordered Dither (Retro look)</option>
            <option value="none">No Dither (Smallest file size)</option>
          </select>

          <label style="font-size:11px; font-weight:bold;">Frame Dropping</label>
          <select class="win-input" id="gm-inp-drop-frames" style="width:100%; margin-bottom:12px;">
            <option value="1" selected>Keep all frames</option>
            <option value="2">Drop every 2nd frame (50% smaller)</option>
            <option value="3">Drop every 3rd frame (33% smaller)</option>
          </select>

          <button type="button" class="win-button primary" id="gm-btn-apply-optimize" style="width:100%;">
            <i class="bi bi-speedometer2"></i> Optimize Size
          </button>
        `;
        // Fallback dynamic async fetch if history push hasn't resolved it yet
        if (sizeBefore === "Scanning...") {
          (async function() {
            var beforeEl = content.querySelector("#gm-opt-size-before");
            if (currentMedia && beforeEl) {
              try {
                var size = await window.__TAURI__.core.invoke("get_file_size", { path: currentMedia.path });
                if (size !== null && size !== undefined) {
                  beforeEl.textContent = formatBytes(size);
                  if (historyIndex >= 0 && historyIndex < history.length) {
                    history[historyIndex].fileSize = size;
                  }
                }
              } catch(e) {}
            }
          })();
        }
        content.querySelector("#gm-btn-apply-optimize").addEventListener("click", handleApplyOptimize);
        break;

      case "split":
        title.textContent = "Split GIF to Frames";
        (function() {
          var defaultDir = currentMedia ? currentMedia.path.replace(/[\/\\][^\/\\]+$/, "") : "";
          content.innerHTML = `
            <div style="font-size:11px; color:#666; margin-bottom:8px;">Extracts every frame from the active GIF/video and saves them as individual PNG files to a destination folder.</div>
            <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">Output Folder</label>
            <div style="display:flex; gap:4px; margin-bottom:10px;">
              <input type="text" class="win-input" id="gm-inp-split-dir" placeholder="Choose output folder..." style="flex:1; min-width:0;" />
              <button type="button" class="win-button" id="gm-btn-split-browse"><i class="bi bi-folder2-open"></i> Browse</button>
            </div>
            <button type="button" class="win-button primary" id="gm-btn-split" style="width:100%;">
              <i class="bi bi-grid-3x3-gap"></i> Extract &amp; Split Frames
            </button>
          `;
          content.querySelector("#gm-inp-split-dir").value = defaultDir;
          content.querySelector("#gm-btn-split-browse").addEventListener("click", async function() {
            try {
              var selected = await window.__TAURI__.core.invoke("select_path", { isDirectory: true });
              if (selected) content.querySelector("#gm-inp-split-dir").value = selected;
            } catch(e) {
              logConsole("Folder browse error: " + e, "error");
            }
          });
          content.querySelector("#gm-btn-split").addEventListener("click", handleSplitGif);
        })();
        break;

      case "export":
        title.textContent = "Resize Dimensions & Export";
        var origW = (currentMedia && currentMedia.width)  || 0;
        var origH = (currentMedia && currentMedia.height) || 0;
        (function() {
          var activeExt = (currentMedia && currentMedia.path) ? currentMedia.path.split('.').pop().toLowerCase() : "gif";
          if (activeExt === "mov" || activeExt === "avi" || activeExt === "mkv") activeExt = "mp4";

          content.innerHTML = `
            <div class="group-box" style="margin-bottom:8px;">
              <div class="group-box-title">Dimensions</div>
              <div style="display:flex; flex-direction:column; gap:6px; padding:4px 0;">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-size:11px; font-weight:bold; width:42px;">Width</span>
                  <span style="font-size:11px; color:var(--sys-text-subtle,#666); min-width:40px; text-align:right;">${origW}</span>
                  <span style="font-size:11px; color:var(--sys-text-subtle,#666);">&#8594;</span>
                  <input type="number" class="win-input" id="gm-inp-resize-w" value="${origW}" min="1" style="width:70px; text-align:center;" />
                  <span style="font-size:10px; color:var(--sys-text-subtle,#666);">px</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-size:11px; font-weight:bold; width:42px;">Height</span>
                  <span style="font-size:11px; color:var(--sys-text-subtle,#666); min-width:40px; text-align:right;">${origH}</span>
                  <span style="font-size:11px; color:var(--sys-text-subtle,#666);">&#8594;</span>
                  <input type="number" class="win-input" id="gm-inp-resize-h" value="${origH}" min="1" style="width:70px; text-align:center;" />
                  <span style="font-size:10px; color:var(--sys-text-subtle,#666);">px</span>
                </div>
              </div>
            </div>

            <div class="group-box" style="margin-bottom:8px;">
              <div class="group-box-title">Resize by Percent</div>
              <div style="display:flex; align-items:center; gap:6px; padding:4px 0;">
                <input type="range" id="gm-inp-resize-pct" min="10" max="1000" value="100" step="5" style="flex:1;" />
                <input type="number" class="win-input" id="gm-inp-resize-pct-num" value="100" min="10" style="width:60px; text-align:center;" />
                <span style="font-size:11px;">%</span>
              </div>
            </div>

            <label style="font-size:11px; font-weight:bold;">Export Format</label>
            <select class="win-input" id="gm-inp-export-format" style="width:100%; margin-bottom:12px;">
              <option value="gif" ${activeExt === 'gif' ? 'selected' : ''}>Animated GIF (.gif)</option>
              <option value="webp" ${activeExt === 'webp' ? 'selected' : ''}>Animated WebP (.webp) &mdash; Lossless</option>
              <option value="mp4" ${activeExt === 'mp4' ? 'selected' : ''}>MP4 Video (.mp4)</option>
              <option value="webm" ${activeExt === 'webm' ? 'selected' : ''}>WebM Video (.webm)</option>
            </select>

            <button type="button" class="win-button primary" id="gm-btn-export" style="width:100%;">
              <i class="bi bi-download"></i> Apply &amp; Save Export
            </button>
          `;
        })();
        (function() {
          var oW = origW, oH = origH;
          var wInp  = content.querySelector("#gm-inp-resize-w");
          var hInp  = content.querySelector("#gm-inp-resize-h");
          var pctRange = content.querySelector("#gm-inp-resize-pct");
          var pctNum   = content.querySelector("#gm-inp-resize-pct-num");

          function applyPct(pct) {
            if (!oW || !oH) return;
            wInp.value = Math.max(1, Math.round(oW * pct / 100));
            hInp.value = Math.max(1, Math.round(oH * pct / 100));
          }

          function syncPctFromDims() {
            var w = parseInt(wInp.value);
            if (!oW || !w) return;
            var pct = Math.round(w / oW * 100);
            pctRange.value = Math.max(10, pct);
            pctNum.value   = pct;
          }

          pctRange.addEventListener("input", function() {
            pctNum.value = this.value;
            applyPct(parseInt(this.value));
          });
          pctNum.addEventListener("input", function() {
            var v = Math.max(10, parseInt(this.value) || 100);
            pctRange.value = v;
            applyPct(v);
          });
          wInp.addEventListener("input", function() {
            if (oW && oH) {
              hInp.value = Math.max(1, Math.round(parseInt(this.value || oW) * oH / oW));
            }
            syncPctFromDims();
          });
          hInp.addEventListener("input", function() {
            if (oW && oH) {
              wInp.value = Math.max(1, Math.round(parseInt(this.value || oH) * oW / oH));
            }
            syncPctFromDims();
          });
        })();
        content.querySelector("#gm-btn-export").addEventListener("click", handleExportResize);
        break;
    }
  }

  // Populates the Dynamic Font Selection dropdown (Unused / stubbed)
  function populateFontsDropdown() {}

  // Calculate stable media display width based on parent container and media aspect ratio
  function getStableMediaWidth() {
    var parent = document.getElementById("gm-drop-zone");
    if (!parent || !currentMedia || !currentMedia.width) return 400;

    var parentRect = parent.getBoundingClientRect();
    var maxW = parentRect.width - 24; // 12px padding on each side
    var maxH = parentRect.height - 24;

    var mediaAspect = currentMedia.width / currentMedia.height;
    var containerAspect = maxW / maxH;

    if (mediaAspect > containerAspect) {
      return maxW;
    } else {
      return maxH * mediaAspect;
    }
  }

  // Real-Time WYSIWYG HTML Text Renderer
  function renderWysiwygCanvas() {
    updateOverlayPosition();
  }

  // Load and Preview Media State
  function previewMediaFile(filePath) {
    if (!filePath) return;
    logConsole("Detecting media file: " + filePath, "info");

    var isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(filePath);
    cropState.needsReset = true;
    currentMedia = {
      path: filePath,
      type: isVideo ? "video" : "image",
      width: 0,
      height: 0
    };

    var contentPanel = document.getElementById("gm-panel-content");
    if (contentPanel) contentPanel.removeAttribute("data-mounted-tool");

    var img = document.getElementById("gm-preview-img");
    var vid = document.getElementById("gm-preview-video");
    var empty = document.getElementById("gm-empty-state");

    var container = document.getElementById("gm-drop-zone");
    if (container) {
      container.style.background = "#202020";
      container.style.padding = "0px";
      container.style.alignItems = "center";
      container.style.justifyContent = "center";
    }

    empty.style.display = "none";
    var wrapper = document.getElementById("gm-composition-wrapper");
    if (wrapper) wrapper.style.display = "flex";

    var safeUrl = PH.convertFileSrc(filePath);

    if (isVideo) {
      img.style.display = "none";
      vid.style.display = "block";
      vid.src = safeUrl;
      vid.onloadedmetadata = function () {
        currentMedia.width = vid.videoWidth;
        currentMedia.height = vid.videoHeight;
        logConsole("Loaded video metadata: " + vid.videoWidth + "x" + vid.videoHeight, "success");
        
        PH.callService("GetMediaMetadata", { path: filePath }).then(function(resp) {
          if (resp && resp.MediaMetadataResult) {
            currentMedia.durationMs = resp.MediaMetadataResult.duration_ms;
            currentMedia.fps = resp.MediaMetadataResult.fps;
            currentMedia.totalFrames = resp.MediaMetadataResult.total_frames;
            logConsole("Probed media: " + (currentMedia.durationMs/1000).toFixed(2) + "s, " + currentMedia.fps.toFixed(2) + " fps, " + currentMedia.totalFrames + " frames", "success");
            if (currentTool === "trim") {
              var cp = document.getElementById("gm-panel-content");
              if (cp) cp.removeAttribute("data-mounted-tool");
              setupToolboxPane();
            }
          } else if (resp && resp.Error) {
            logConsole("Failed to probe video details: " + resp.Error.message, "error");
          }
        }).catch(function(e) {
          logConsole("Failed to probe video details: " + e, "error");
        });

        setupToolboxPane();
        setTimeout(updateOverlayPosition, 80);
      };
    } else {
      // Also probe if it's an animated GIF/WebP (handled via same ffprobe path)
      var isAnimated = /\.(gif|webp)$/i.test(filePath);
      if (isAnimated) {
        PH.callService("GetMediaMetadata", { path: filePath }).then(function(resp) {
          if (resp && resp.MediaMetadataResult) {
            currentMedia.durationMs = resp.MediaMetadataResult.duration_ms;
            currentMedia.fps = resp.MediaMetadataResult.fps;
            currentMedia.totalFrames = resp.MediaMetadataResult.total_frames;
            logConsole("Probed animated image: " + (currentMedia.durationMs/1000).toFixed(2) + "s, " + currentMedia.fps.toFixed(2) + " fps, " + currentMedia.totalFrames + " frames", "success");
            if (currentTool === "trim") {
              var cp = document.getElementById("gm-panel-content");
              if (cp) cp.removeAttribute("data-mounted-tool");
              setupToolboxPane();
            }
          } else if (resp && resp.Error) {
            logConsole("Failed to probe animated image: " + resp.Error.message, "error");
          }
        }).catch(function(e) {
          // ignore or log silently for normal static images
        });
      }

      vid.style.display = "none";
      img.style.display = "block";
      img.src = safeUrl;
      img.onload = function () {
        currentMedia.width = img.naturalWidth;
        currentMedia.height = img.naturalHeight;
        logConsole("Loaded image metadata: " + img.naturalWidth + "x" + img.naturalHeight, "success");
        setupToolboxPane();
        setTimeout(updateOverlayPosition, 80);
      };
    }

    // Trigger canvas visual resize match
    setTimeout(renderWysiwygCanvas, 100);
  }

  // Renders arranged frame lists for the GIF Maker tool
  function renderDroppedFrames() {
    var container = document.getElementById("gm-maker-frame-list");
    if (!container) return;

    if (droppedFrames.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:12px; color:#808080;">No frames loaded. Drop files to begin.</div>`;
      return;
    }

    container.innerHTML = "";
    droppedFrames.forEach(function (path, idx) {
      var card = document.createElement("div");
      card.className = "gm-frame-item";
      card.innerHTML = `
        <img class="gm-frame-img" src="${PH.convertFileSrc(path)}" />
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${path}">Frame ${idx + 1}: ${path.split(/[\\/]/).pop()}</span>
        <div style="display:flex; gap:2px;">
          <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, -1)"><i class="bi bi-arrow-up"></i></button>
          <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, 1)"><i class="bi bi-arrow-down"></i></button>
          <button type="button" class="win-button danger" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_removeFrame(${idx})"><i class="bi bi-trash"></i></button>
        </div>
      `;
      container.appendChild(card);
    });
  }

  // Compile image sequence into GIF or Video
  async function compileImagesToAnimation() {
    var pattern = document.getElementById("gm-inp-seq-pattern")?.value.trim() || sequencePattern;
    if (!pattern) {
      logConsole("Error: No sequence pattern entered. Example: D:\\renders\\frame_%05d.png", "error");
      return;
    }
    sequencePattern = pattern;

    var fps = parseFloat(document.getElementById("gm-inp-fps")?.value) || 24;
    var loop = parseInt(document.getElementById("gm-inp-loop")?.value) || 0;
    var format = document.getElementById("gm-inp-maker-format")?.value || "gif";

    var jobId = "make_" + Date.now();
    var tempPath = await getTempOutputPath(format);

    logConsole("Compiling sequence: " + pattern, "info");
    var resp = await PH.callService("CreateGifFromImages", {
      job_id: jobId,
      image_pattern: pattern,
      frame_rate: fps,
      output_path: tempPath,
      width: null,
      height: null,
      loop_count: loop,
      target_format: format
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Compiled sequence", tempPath);
    }
  }

  // Compile loaded video to animation (used in Maker video mode)
  async function compileMakerVideo() {
    if (!currentMedia) {
      logConsole("Error: No video loaded.", "error");
      return;
    }

    var start = null;
    var end = null;
    var keepNativeFps = document.getElementById("gm-chk-native-fps")?.checked || false;
    var fps = keepNativeFps ? null : (parseInt(document.getElementById("gm-inp-fps")?.value) || 15);
    var loop = parseInt(document.getElementById("gm-inp-loop")?.value) || 0;
    var format = document.getElementById("gm-inp-maker-format")?.value || "gif";

    var jobId = "maker_vid_" + Date.now();
    var tempPath = await getTempOutputPath(format);

    logConsole("Compiling video to " + format.toUpperCase() + "...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: null,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: format,
      loop_count: loop,
      fps: fps,
      trim_start: start > 0 ? start : null,
      trim_end: end > 0 ? end : null
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Compiled video", tempPath);
    }
  }

  // Trim and convert video
  async function handleTrimVideo() {
    if (!currentMedia) return;
    var start = parseFloat(document.getElementById("gm-inp-trim-start")?.value) || 0;
    var end = parseFloat(document.getElementById("gm-inp-trim-end")?.value) || 10;
    var fps = parseInt(document.getElementById("gm-inp-trim-fps")?.value) || 10;

    var format = document.getElementById("gm-inp-trim-format")?.value || "gif";

    var jobId = "trim_" + Date.now();
    var tempPath = await getTempOutputPath(format);

    logConsole("Trimming video to " + format.toUpperCase() + "...", "info");
    // We run ProcessGifEffects which handles the video input too
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: null,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: format,
      loop_count: 0,
      fps: fps,
      trim_start: start > 0 ? start : null,
      trim_end: end > 0 ? end : null
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Trimmed & converted video", tempPath);
    }
  }

  // Apply Crop boundary
  async function handleApplyCrop() {
    if (!currentMedia) return;

    var container = document.getElementById("gm-overlay-interactive");
    if (!container || !currentMedia || currentMedia.width === 0) return;

    var containerWidth = container.clientWidth || 1;
    var containerHeight = container.clientHeight || 1;

    var scaleX = currentMedia.width / containerWidth;
    var scaleY = currentMedia.height / containerHeight;

    var xVal = parseFloat(document.getElementById("gm-inp-crop-x")?.value) || 0;
    var yVal = parseFloat(document.getElementById("gm-inp-crop-y")?.value) || 0;
    var wVal = parseFloat(document.getElementById("gm-inp-crop-w")?.value) || 100;
    var hVal = parseFloat(document.getElementById("gm-inp-crop-h")?.value) || 100;

    var x = Math.round(xVal * scaleX);
    var y = Math.round(yVal * scaleY);
    var w = Math.round(wVal * scaleX);
    var h = Math.round(hVal * scaleY);

    var jobId = "crop_" + Date.now();
    var ext = currentMedia.path.split('.').pop();
    var tempPath = await getTempOutputPath(ext);

    logConsole("Applying crop filter...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: w + ":" + h + ":" + x + ":" + y,
      scale: null,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: ext
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Cropped canvas to " + w + "x" + h, tempPath);
    }
  }

  // Render text captions
  async function handleApplyCaption() {
    if (!currentMedia) return;
    var txt = document.getElementById("gm-inp-caption-text")?.value || "";
    var style = document.getElementById("gm-inp-caption-style")?.value || "ifunny";

    if (!txt.trim()) {
      logConsole("Warning: No caption text inputted.", "error");
      return;
    }

    var sizeInp = document.getElementById("gm-inp-caption-size-num");
    var sizeVal = sizeInp ? parseInt(sizeInp.value) : 28;

    var displayW = document.getElementById("gm-composition-wrapper")?.clientWidth || 400;
    var originalW = currentMedia.width || 400;
    var scale = displayW > 0 ? (originalW / displayW) : 1;
    var originalFontSize = Math.round(sizeVal * scale);

    // Use shared function — identical output to the live preview
    var built = buildCaptionCanvas(txt, originalW, style, originalFontSize);
    var base64Png = built.canvas.toDataURL("image/png");
    var originalCaptionHeight = built.captionH;


    var jobId = "caption_" + Date.now();
    var ext = currentMedia.path.split('.').pop();
    var tempPath = await getTempOutputPath(ext);

    logConsole("Rendering text caption from Canvas PNG...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: null,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: base64Png,
      caption_image_height: Math.ceil(originalCaptionHeight),
      caption_style: style,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: ext
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Applied " + style + " caption", tempPath);
    }
  }

  // Apply speed, reverse, grayscale and color filter parameters
  async function handleApplyEffects() {
    if (!currentMedia) return;
    var speed = parseFloat(document.getElementById("gm-inp-speed")?.value) || 1.0;
    var rotate = document.getElementById("gm-inp-rotate")?.value || null;
    var reverse = document.getElementById("gm-inp-reverse")?.checked || false;
    var bounce = document.getElementById("gm-inp-bounce")?.checked || false;
    var grayscale = document.getElementById("gm-inp-grayscale")?.checked || false;
    var invert = document.getElementById("gm-inp-invert")?.checked || false;

    var jobId = "effects_" + Date.now();
    var ext = currentMedia.path.split('.').pop();
    var tempPath = await getTempOutputPath(ext);

    logConsole("Applying layout and speed transformations...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: null,
      speed_multiplier: speed,
      reverse: reverse,
      bounce: bounce,
      rotate: rotate ? rotate : null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: grayscale,
      invert: invert,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: ext
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Applied effects & speed adjustment", tempPath);
    }
  }

  // Apply compression size optimization
  async function handleApplyOptimize() {
    if (!currentMedia) return;
    var colors = parseInt(document.getElementById("gm-inp-colors")?.value) || 256;
    var dither = document.getElementById("gm-inp-dither")?.value || "floyd_steinberg";
    var dropFrames = parseInt(document.getElementById("gm-inp-drop-frames")?.value) || 1;

    var jobId = "optimize_" + Date.now();
    var ext = currentMedia.path.split('.').pop();
    var tempPath = await getTempOutputPath(ext);

    logConsole("Applying dither/colors reduction...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: null,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: colors,
      dither_type: dither,
      drop_frames_factor: dropFrames,
      target_format: ext
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Optimized color reduction", tempPath);
    }
  }

  // Extract frames
  async function handleSplitGif() {
    if (!currentMedia) return;
    var dirInput = document.getElementById("gm-inp-split-dir");
    var outDir = dirInput ? dirInput.value.trim() : "";
    if (!outDir) {
      outDir = currentMedia.path.replace(/[\/\\][^\/\\]+$/, "") || ".";
    }
    var jobId = "split_" + Date.now();
    logConsole("Extracting frames to folder: " + outDir, "info");

    var resp = await PH.callService("SplitGif", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_dir: outDir
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Split frames to directory", outDir);
    }
  }

  // Export & resize dimensions
  async function handleExportResize() {
    if (!currentMedia) return;
    var w = parseInt(document.getElementById("gm-inp-resize-w")?.value) || null;
    var h = parseInt(document.getElementById("gm-inp-resize-h")?.value) || null;
    var format = document.getElementById("gm-inp-export-format")?.value || "gif";

    var jobId = "export_" + Date.now();
    var tempPath = await getTempOutputPath(format);

    var scaleStr = (w && h) ? w + ":" + h : null;

    logConsole("Compiling export dimensions scaling...", "info");
    var resp = await PH.callService("ProcessGifEffects", {
      job_id: jobId,
      input_path: currentMedia.path,
      output_path: tempPath,
      crop: null,
      scale: scaleStr,
      speed_multiplier: null,
      reverse: false,
      bounce: false,
      rotate: null,
      brightness: null,
      contrast: null,
      saturation: null,
      grayscale: false,
      invert: false,
      caption_image_base64: null,
      caption_image_height: null,
      caption_style: null,
      max_colors: null,
      dither_type: null,
      drop_frames_factor: null,
      target_format: format
    });

    if (resp && resp.Error) {
      logConsole("Error: " + resp.Error.message, "error");
    } else {
      pollCompilationProgress(jobId, "Resized & converted export file", tempPath);
    }
  }

  // Copy intermediate files to a final directory path
  async function handleSaveFinal() {
    if (historyIndex < 0 || historyIndex >= history.length) return;
    var activeState = history[historyIndex];

    if (!window.__TAURI__ || !window.__TAURI__.core) {
      logConsole("Tauri core API not available.", "error");
      return;
    }

    // Derive a suggested filename from the current temp path
    var srcName = activeState.path.split(/[\\/]/).pop() || "output";
    var ext = srcName.split(".").pop().toLowerCase() || "gif";
    var baseName = srcName.substring(0, srcName.lastIndexOf(".")) || srcName;
    var suggestedName = baseName + "." + ext;

    var extMap = {
      gif: ["gif"], mp4: ["mp4"], webm: ["webm"], webp: ["webp"],
      png: ["png"], jpg: ["jpg", "jpeg"], jpeg: ["jpg", "jpeg"]
    };
    var filterExts = extMap[ext] || [ext];
    var filterName = ext.toUpperCase() + " File";

    var finalDest = await window.__TAURI__.core.invoke("save_file_dialog", {
      suggestedName: suggestedName,
      filterName: filterName,
      extensions: filterExts
    }).catch(function(err) {
      logConsole("Save dialog error: " + err, "error");
      return null;
    });

    if (!finalDest) return;

    logConsole("Saving final compiled media to disk...", "info");
    var resp = await PH.callService("PathExists", { path: activeState.path });
    if (resp && resp.PathExistsResult && resp.PathExistsResult.exists) {
      var copyResp = await PH.callService("EphemeralConvertImages", {
        conversions: [[activeState.path, finalDest]],
        quality: 100
      });
      if (copyResp && copyResp.ConvertImagesResult && copyResp.ConvertImagesResult.converted.length > 0) {
        var fileInfo = copyResp.ConvertImagesResult.converted[0];
        if (fileInfo.error) {
          logConsole("Save failed: " + fileInfo.error, "error");
        } else {
          logConsole("Saved successfully to " + fileInfo.output_path, "success");
        }
      } else {
        logConsole("Save operation returned empty results.", "error");
      }
    } else {
      logConsole("Source temp file is missing or expired.", "error");
    }
  }

  // Poll compilation job progress
  function pollCompilationProgress(jobId, description, filePath) {
    if (pollTimer) clearTimeout(pollTimer);
    activeJobId = jobId;
    var startTime = Date.now();

    var bar = document.getElementById("gm-progress-bar");
    var text = document.getElementById("gm-progress-text");

    var tick = async function () {
      var resp = await PH.callService("GetTranscodeProgress", { job_id: jobId });
      var progress = resp && resp.TranscodeProgressResult;
      if (!progress) {
        logConsole("Lost compilation job progress tracker.", "error");
        if (bar) bar.style.width = "0%";
        if (text) text.textContent = "0%";
        return;
      }

      var pct = Math.round(progress.percent || 0);
      if (bar) bar.style.width = pct + "%";
      if (text) text.textContent = pct + "%";

      if (progress.error) {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logConsole("Job Failed: " + progress.error + " (took " + elapsed + "s)", "error");
        activeJobId = null;
        if (bar) bar.style.width = "0%";
        if (text) text.textContent = "0%";
        return;
      }

      if (!progress.running && pct >= 100) {
        var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logConsole("Compilation completed successfully! (took " + elapsed + "s)", "success");
        activeJobId = null;
        if (bar) bar.style.width = "100%";
        if (text) text.textContent = "100%";
        
        var finalPath = progress.output_path || filePath;

        // Push state onto history — pushHistoryState is async and will fetch+store
        // the file size before calling restoreHistoryState, so stats are always fresh.
        if (finalPath.endsWith("_frames") || jobId.startsWith("split_")) {
          logConsole("Frames generated inside folder " + finalPath, "success");
        } else {
          pushHistoryState(finalPath, description);
        }
        return;
      }

      if (!progress.running) {
        logConsole("Job ended early without completing.", "error");
        activeJobId = null;
        if (bar) bar.style.width = "0%";
        if (text) text.textContent = "0%";
        return;
      }

      pollTimer = setTimeout(tick, 600);
    };
    tick();
  }

  // State History Stack Operations
  async function pushHistoryState(filePath, description) {
    // Truncate future branch if undoing and applying a new change
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }

    var size = null;
    if (window.__TAURI__ && window.__TAURI__.core) {
      try {
        size = await window.__TAURI__.core.invoke("get_file_size", { path: filePath });
      } catch(e) {}
    }

    history.push({ path: filePath, description: description, fileSize: size });
    historyIndex = history.length - 1;
    restoreHistoryState();
  }

  function restoreHistoryState() {
    var root = document.getElementById("view-extensions-" + TAB_ID);
    if (!root) return;

    var list = root.querySelector("#gm-hist-list");
    var btnUndo = root.querySelector("#gm-btn-undo");
    var btnRedo = root.querySelector("#gm-btn-redo");
    var btnSave = root.querySelector("#gm-btn-save-final");

    if (history.length === 0) {
      list.innerHTML = `<div style="color:#808080; padding:6px; font-style:italic;">No files loaded.</div>`;
      btnUndo.disabled = true;
      btnRedo.disabled = true;
      btnSave.disabled = true;
      var container = document.getElementById("gm-drop-zone");
      if (container) {
        container.style.background = "var(--sys-window-bg, #f0f0f0)";
        container.style.padding = "12px";
        container.style.alignItems = "stretch";
        container.style.justifyContent = "stretch";
      }
      var empty = document.getElementById("gm-empty-state");
      if (empty) empty.style.display = "flex";
      var img = document.getElementById("gm-preview-img");
      if (empty) empty.style.display = "flex";
      var wrapper = document.getElementById("gm-composition-wrapper");
      if (wrapper) wrapper.style.display = "none";
      if (img) img.style.display = "none";
      var vid = document.getElementById("gm-preview-video");
      if (vid) {
        vid.style.display = "none";
        vid.src = "";
      }
      currentMedia = null;
      return;
    }

    list.innerHTML = "";
    history.forEach(function (state, idx) {
      var item = document.createElement("div");
      item.className = "gm-history-item" + (idx === historyIndex ? " active" : "");
      var name = state.path.split(/[\\/]/).pop();
      var sizeStr = state.fileSize ? " (" + formatBytes(state.fileSize) + ")" : "";
      item.innerHTML = `
        <span>${state.description}</span>
        <span style="color:#666; font-size:10px;">${name}${sizeStr}</span>
      `;
      item.addEventListener("click", function () {
        historyIndex = idx;
        restoreHistoryState();
      });
      list.appendChild(item);
    });

    btnUndo.disabled = historyIndex <= 0;
    btnRedo.disabled = historyIndex >= history.length - 1;
    btnSave.disabled = historyIndex < 0;

    var activeState = history[historyIndex];
    previewMediaFile(activeState.path);
  }

  // Temporary file path generator helper
  async function getTempOutputPath(targetExt) {
    var rand = Math.floor(Math.random() * 1e7).toString(36);
    return ".curator\\temp_gif\\temp_gif_" + rand + "." + targetExt;
  }

  // Load selection from the main gallery grid
  async function handleLoadSelection() {
    logConsole("Fetching selected gallery assets...", "info");
    var selection = await PH.getSelectionAssetContexts();
    if (!selection || selection.length === 0) {
      logConsole("Error: Select files in the main gallery first.", "error");
      return;
    }

    if (currentTool === "maker") {
      droppedFrames = selection.map(function (asset) { return asset.path; });
      logConsole("Loaded " + droppedFrames.length + " frames to the GIF Maker frame pool.", "success");
      renderDroppedFrames();
    } else {
      pushHistoryState(selection[0].path, "Imported selected file");
    }
  }

  // Browse File Action via Native RFD Dialog
  async function handleBrowseFile() {
    try {
      var api = window.__TAURI__;
      if (!api || !api.core || !api.core.invoke) {
        logConsole("Error: Native Tauri bridge is not initialized.", "error");
        return;
      }
      var path = await api.core.invoke("select_path", { isDirectory: false });
      if (path) {
        if (currentTool === "maker") {
          // If in Maker mode and picked an image, add it to frames
          if (/\.(png|jpe?g|webp|gif)$/i.test(path)) {
            droppedFrames.push(path);
            logConsole("Added frame: " + path.split(/[\\/]/).pop(), "success");
            renderDroppedFrames();
          } else {
            logConsole("Error: Select an image file to add to GIF Maker frames.", "error");
          }
        } else {
          pushHistoryState(path, "Opened file: " + path.split(/[\\/]/).pop());
        }
      }
    } catch (err) {
      logConsole("Browse file error: " + err, "error");
    }
  }

  // Process Native Tauri Drop Actions
  function setupNativeDropZone(dropArea) {
    var api = window.__TAURI__;
    if (!api || !api.webview || !api.webview.getCurrentWebview) return;

    api.webview.getCurrentWebview().onDragDropEvent(function (event) {
      var tabActive = document.getElementById("view-extensions-" + TAB_ID);
      if (!tabActive || !tabActive.classList.contains("active")) return;

      var drop = event.payload;
      var dz = document.getElementById("gm-empty-state");
      if (!drop) return;

      // Handle drop highlighting
      if (drop.type === "enter" || drop.type === "over") {
        if (dz) dz.classList.add("toolbox-drop-active");
      } else if (drop.type === "leave" || drop.type === "drop") {
        if (dz) dz.classList.remove("toolbox-drop-active");
      }

      if (drop.type !== "drop" || !drop.paths || drop.paths.length === 0) return;

      // Device Pixel Ratio Hit-testing
      var hit = null;
      var pos = drop.position;
      if (pos && typeof pos.x === "number") {
        var cx = pos.x / window.devicePixelRatio;
        var cy = pos.y / window.devicePixelRatio;
        var element = document.elementFromPoint(cx, cy);
        hit = element ? element.closest("#gm-drop-zone") : null;
      }

      if (!hit) return;

      var paths = drop.paths;
      if (currentTool === "maker") {
        if (paths.length === 1 && /\.(mp4|webm|mov|gif|avi|mkv)$/i.test(paths[0])) {
          // Video dropped in maker mode — preview it and refresh sidebar to video mode
          previewMediaFile(paths[0]);
          setupToolboxPane();
        } else {
          logConsole("Sequence mode: enter your pattern in the Maker panel.", "info");
        }
      } else {
        pushHistoryState(paths[0], "Dropped media file");
      }
    });
  }

  // Console log writer helper
  function logConsole(msg, kind) {
    var box = document.getElementById("gm-console");
    if (!box) return;
    var colors = { info: "#cccccc", success: "#10b981", error: "#f87171" };
    var line = document.createElement("div");
    line.style.cssText = "font-family: 'Consolas', monospace; font-size: 11px; line-height: 1.4; color: " +
      (colors[kind] || colors.info) + "; white-space: pre-wrap; word-break: break-all;";
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

})();
