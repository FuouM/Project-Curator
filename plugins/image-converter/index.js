// ─────────────────────────────────────────────────────────────────────────────
// Project Curator — Image Converter plugin (v1.0.0)
//
// Runs in the dashboard's global scope, loaded by PluginHost.initPlugins().
// Exposes:
//   • A plugin tab with drag-and-drop queue, target format, quality, and log.
//   • A metadata renderer ("Send to Converter") in the image info modal.
//   • A toolbar button ("Convert Selected") in select-mode toolbars.
//   • A right-click context menu item.
//
// All conversion work is done by the service's EphemeralConvertImages IPC
// endpoint — outputs are plain files in the user-chosen output_dir and never
// touch the library. No core UI code was modified.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";

  var PH = window.PluginHost;
  if (!PH) {
    console.error("image-converter: PluginHost not available; aborting.");
    return;
  }

  var CONVERT_FORMATS = [
    "png", "jpg", "webp", "gif", "bmp", "tiff", "qoi",
    "tga", "pnm", "hdr", "ico", "exr", "avif"
  ];

  var TAB_ID = "image-converter";

  // ── Module state ──────────────────────────────────────────────────────────
  var queue = [];       // ordered source paths
  var inQueue = {};     // path -> true (dedupe)
  var outputDir = "";
  var targetExt = "png";
  var quality = 90;
  var busy = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function el(id) {
    return document.getElementById(id);
  }

  function log(message, kind) {
    var box = el("converter-log");
    if (!box) return;
    // Colors mirror the app's System Diagnostic Logs console (views/logs.ts):
    // INFO green #10b981, ERROR red #f87171, default text #cccccc.
    var colors = {
      info: "#cccccc",
      success: "#10b981",
      error: "#f87171"
    };
    var line = document.createElement("div");
    line.style.cssText = "font-family: 'Consolas', monospace; font-size: 11px; line-height: 1.4; color: " +
      (colors[kind] || colors.info) + "; white-space: pre-wrap; word-break: break-all;";
    line.textContent = message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function updateQueueList() {
    var list = el("converter-queue-list");
    if (!list) return;
    list.innerHTML = "";

    // Count basenames so same-named files from different folders can be
    // disambiguated by showing their parent folder.
    var basenames = {};
    queue.forEach(function (path) {
      var base = path.split(/[\\/]/).pop();
      basenames[base] = (basenames[base] || 0) + 1;
    });

    queue.forEach(function (path, index) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 6px;" +
        "border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;" +
        "background:var(--sys-window-bg,#fff);font-size:11px;";
      var parts = path.split(/[\\/]/);
      var base = parts.pop();
      var labelText = base;
      if (basenames[base] > 1) {
        var parent = parts[parts.length - 1];
        labelText = (parent ? parent + "/" : "") + base;
      }
      var label = document.createElement("span");
      label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      label.title = path;
      label.textContent = labelText;
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "win-button";
      remove.style.cssText = "font-size:10px;padding:1px 6px;";
      remove.innerHTML = '<i class="bi bi-x-lg"></i>';
      remove.addEventListener("click", function () {
        queue.splice(index, 1);
        delete inQueue[path];
        updateQueueList();
        updateProgress(0, queue.length);
      });
      row.appendChild(label);
      row.appendChild(remove);
      list.appendChild(row);
    });
    var empty = el("converter-queue-empty");
    if (empty) empty.style.display = queue.length === 0 ? "block" : "none";
    var count = el("converter-queue-count");
    if (count) count.textContent = queue.length + " file(s) queued";
  }

  function addToQueue(path) {
    if (!path) return;
    if (inQueue[path]) {
      log("Already queued: " + path, "info");
      return;
    }
    inQueue[path] = true;
    queue.push(path);
    updateQueueList();
    updateProgress(0, queue.length);
    log("Queued: " + path, "info");
  }

  function updateProgress(done, total) {
    var fill = el("converter-progress-fill");
    var text = el("converter-progress-text");
    if (!fill) return;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + "%";
    if (text) text.textContent = done + " / " + total + " (" + pct + "%)";
  }

  function setBusy(value) {
    busy = value;
    var btn = el("converter-run-btn");
    if (btn) {
      btn.disabled = value;
      btn.innerHTML = value
        ? '<i class="bi bi-hourglass-split"></i> Converting...'
        : '<i class="bi bi-arrow-repeat"></i> Convert';
    }
  }

  function qualityVisibility() {
    var slider = el("converter-quality");
    var note = el("converter-quality-note");
    var wrapper = el("converter-quality-group");
    if (!slider || !wrapper) return;
    var applies = targetExt === "jpg" || targetExt === "jpeg" || targetExt === "webp";
    wrapper.style.display = applies ? "" : "none";
    slider.disabled = !applies;
    if (note) {
      note.textContent = targetExt === "webp"
        ? "WebP output is lossless (quality not applied)."
        : "";
    }
  }

  function navigateToTab() {
    var item = document.querySelector('.nav-item[data-view="extensions-' + TAB_ID + '"]');
    if (item) item.click();
  }

  function closeInfoModal() {
    var modal = document.getElementById("image-info-modal");
    if (!modal || !modal.classList.contains("active")) return;
    // Reuse the core modal's own close handler (removes the .active class).
    var closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) {
      closeBtn.click();
    } else {
      modal.classList.remove("active");
    }
  }

  async function checkFileExists(path) {
    var resp = await PH.callService("PathExists", { path: path });
    return !!(resp && resp.PathExistsResult && resp.PathExistsResult.exists);
  }

  async function getUniqueOutputPath(sourcePath, outputDir, targetExt) {
    var base = sourcePath.split(/[\\/]/).pop();
    var idx = base.lastIndexOf('.');
    var stem = idx !== -1 ? base.substring(0, idx) : base;

    var sep = outputDir.indexOf('\\') !== -1 ? '\\' : '/';
    var cleanOutDir = outputDir;
    if (cleanOutDir.charAt(cleanOutDir.length - 1) === sep) {
      cleanOutDir = cleanOutDir.substring(0, cleanOutDir.length - 1);
    }

    var n = 0;
    while (true) {
      var name = n === 0 ? (stem + "." + targetExt) : (stem + "_" + n + "." + targetExt);
      var candidate = cleanOutDir + sep + name;

      if (candidate === sourcePath) {
        n++;
        continue;
      }

      var exists = await checkFileExists(candidate);
      if (!exists) {
        return candidate;
      }
      n++;
    }
  }

  // ── Conversion ────────────────────────────────────────────────────────────
  async function runConversion() {
    if (busy) return;
    if (queue.length === 0) {
      log("No files queued. Drag & drop images or use Send to Converter.", "error");
      return;
    }
    if (!outputDir) {
      log("Choose an output directory first.", "error");
      return;
    }

    var sources = queue.slice();
    setBusy(true);
    log("Resolving output paths and detecting collisions...", "info");

    var conversions = [];
    try {
      for (var i = 0; i < sources.length; i++) {
        var src = sources[i];
        var tgt = await getUniqueOutputPath(src, outputDir, targetExt);
        conversions.push([src, tgt]);
      }
    } catch (err) {
      log("Path resolution failed: " + (err && err.message ? err.message : String(err)), "error");
      setBusy(false);
      return;
    }

    log("Converting " + conversions.length + " file(s) to " + targetExt + " ...", "info");

    try {
      var resp = await PH.callService("EphemeralConvertImages", {
        conversions: conversions,
        quality: quality
      });

      if (resp && resp.ConvertImagesResult) {
        var converted = resp.ConvertImagesResult.converted;
        var ok = 0;
        var fail = 0;
        converted.forEach(function (c) {
          if (c.error) {
            fail++;
            log("FAIL " + c.source_path + " — " + c.error, "error");
          } else {
            ok++;
            log("OK " + c.source_path + "  ->  " + c.output_path, "success");
          }
        });
        updateProgress(converted.length, converted.length);
        if (fail === 0) {
          log("Done: " + ok + " file(s) converted.", "success");
        } else {
          log("Done: " + ok + " converted, " + fail + " failed.", "error");
        }
      } else if (resp && resp.Error) {
        log("Service error: " + resp.Error.message, "error");
      } else {
        log("Unexpected response from service.", "error");
      }
    } catch (e) {
      log("Conversion failed: " + (e && e.message ? e.message : String(e)), "error");
    } finally {
      setBusy(false);
    }
  }

  // ── Drop zone (Tauri v2 drag-drop events, like the Toolbox view) ─────────
  function setupDropZone() {
    var api = window.__TAURI__;
    if (!api || !api.webview || !api.webview.getCurrentWebview) return;

    var dropZone = el("converter-drop-zone");
    api.webview.getCurrentWebview().onDragDropEvent(function (event) {
      var tabActive = document.getElementById("view-extensions-" + TAB_ID);
      if (!tabActive || !tabActive.classList.contains("active")) return;
      var drop = event.payload;

      // Only highlight when the cursor is actually over the drop zone.
      var isOverDropZone = function () {
        if (!dropZone) return false;
        var pos = drop.position;
        if (!pos || typeof pos.x !== "number") return false;
        var cx = pos.x / window.devicePixelRatio;
        var cy = pos.y / window.devicePixelRatio;
        var hit = document.elementFromPoint(cx, cy);
        return !!hit && (dropZone.contains(hit) || dropZone === hit);
      };

      if (drop.type === "enter" || drop.type === "over") {
        if (isOverDropZone()) {
          dropZone.classList.add("toolbox-drop-active");
        } else {
          dropZone.classList.remove("toolbox-drop-active");
        }
      } else if (drop.type === "leave") {
        dropZone.classList.remove("toolbox-drop-active");
      } else if (drop.type === "drop") {
        dropZone.classList.remove("toolbox-drop-active");
        (drop.paths || []).forEach(addToQueue);
      }
    });
  }

  // ── Tab render function (called once on first activation) ────────────────
  function renderTab() {
    var container = document.createElement("div");

    container.innerHTML =
      '<div class="group-box">' +
      '  <div class="group-box-title"><i class="bi bi-arrow-repeat"></i> Image Converter</div>' +
      '  <div style="display:flex;flex-direction:column;gap:12px;">' +

      '    <div class="form-group">' +
      '      <label for="converter-output-dir" style="min-width:110px;">Output folder:</label>' +
      '      <div class="input-wrapper" style="flex:1;">' +
      '        <input class="input-field has-clear" id="converter-output-dir" placeholder="Where converted files should be written..." />' +
      '        <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>' +
      '      </div>' +
      '      <button type="button" class="win-button" id="converter-browse-btn"><i class="bi bi-folder2-open"></i> Browse...</button>' +
      '    </div>' +

      '    <div class="form-group">' +
      '      <label for="converter-format" style="min-width:110px;">Target format:</label>' +
      '      <select class="input-field" id="converter-format" style="width:160px;height:24px;">' +
      CONVERT_FORMATS.map(function (f) {
        return '<option value="' + f + '">' + f.toUpperCase() + '</option>';
      }).join("") +
      '      </select>' +
      '      <div id="converter-quality-group" class="form-group" style="margin:0;flex:1;">' +
      '        <label for="converter-quality" style="min-width:70px;">Quality: <span id="converter-quality-value">90</span></label>' +
      '        <input type="range" id="converter-quality" min="1" max="100" value="90" style="flex:1;max-width:200px;" />' +
      '      </div>' +
      '    </div>' +
      '    <div id="converter-quality-note" style="font-size:10px;color:#777;margin-top:-6px;"></div>' +

      '    <div id="converter-drop-host">' +
      '      <div class="toolbox-drop-zone" id="converter-drop-zone" style="flex:none;height:130px;">' +
      '        <div class="toolbox-drop-icon"><i class="bi bi-images"></i></div>' +
      '        <span>Drop image files here to queue them</span>' +
      '      </div>' +
      '    </div>' +

      '    <div class="group-box" style="margin-top:8px;">' +
      '      <div class="group-box-title">Queue <span id="converter-queue-count" style="font-weight:400;color:#777;font-size:10px;">0 file(s) queued</span>' +
      '        <button type="button" class="win-button" id="converter-clear-btn" style="font-size:10px;padding:1px 8px;margin-left:8px;"><i class="bi bi-trash3"></i> Clear</button></div>' +
      '      <div id="converter-queue-empty" style="font-size:11px;color:#999;font-style:italic;padding:4px 0;">No files queued.</div>' +
      '      <div id="converter-queue-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;"></div>' +
      '    </div>' +

      '    <div style="display:flex;align-items:center;gap:12px;">' +
      '      <button type="button" class="win-button primary" id="converter-run-btn" style="padding:4px 14px;">' +
      '        <i class="bi bi-arrow-repeat"></i> Convert' +
      '      </button>' +
      '      <div class="progress-bar" style="flex:1;max-width:300px;">' +
      '        <div class="progress-fill" id="converter-progress-fill" style="width:0%;"></div>' +
      '      </div>' +
      '      <span id="converter-progress-text" style="font-size:11px;color:#555;">0 / 0 (0%)</span>' +
      '    </div>' +

      '    <div class="group-box" style="margin-top:8px;">' +
      '      <div class="group-box-title"><i class="bi bi-terminal"></i> Output Log</div>' +
      '      <div id="converter-log" style="height:140px;overflow-y:auto;background-color:#1e1e1e;color:#cccccc;border:1px solid #7a7a7a;padding:8px;font-family:\'Consolas\',monospace;font-size:11px;white-space:pre-wrap;"></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var runBtn = container.querySelector("#converter-run-btn");
    if (runBtn) runBtn.addEventListener("click", runConversion);

    var clearBtn = container.querySelector("#converter-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        queue.length = 0;
        inQueue = {};
        updateQueueList();
        updateProgress(0, 0);
        log("Queue cleared.", "info");
      });
    }

    var browseBtn = container.querySelector("#converter-browse-btn");
    var outInput = container.querySelector("#converter-output-dir");
    if (browseBtn && outInput && window.__TAURI__ && window.__TAURI__.core) {
      browseBtn.addEventListener("click", function () {
        window.__TAURI__.core.invoke("select_path", { isDirectory: true }).then(function (path) {
          if (path) {
            outInput.value = path;
            outputDir = path;
            log("Output directory set: " + path, "success");
          }
        }).catch(function (err) {
          log("Folder picker failed: " + (err && err.message ? err.message : err), "error");
        });
      });
    }

    var formatSelect = container.querySelector("#converter-format");
    if (formatSelect) {
      formatSelect.value = targetExt;
      formatSelect.addEventListener("change", function () {
        targetExt = formatSelect.value;
        qualityVisibility();
      });
    }

    var qualityInput = container.querySelector("#converter-quality");
    var qualityValue = container.querySelector("#converter-quality-value");
    if (qualityInput) {
      qualityInput.addEventListener("input", function () {
        quality = parseInt(qualityInput.value, 10) || 90;
        if (qualityValue) qualityValue.textContent = String(quality);
      });
    }

    // Output-dir manual typing
    if (outInput) {
      outInput.addEventListener("change", function () {
        outputDir = outInput.value.trim();
      });
    }

    // This container is still detached from the document while renderTab runs
    // (the plugin-host refresh callback appends it after tab.render() returns),
    // so every document.getElementById lookup inside qualityVisibility,
    // setupDropZone, updateQueueList, and updateProgress would silently no-op.
    // Defer them until the section is mounted.
    setTimeout(function () {
      qualityVisibility();
      setupDropZone();
      updateQueueList();
      updateProgress(0, queue.length);
    }, 0);
    return container;
  }

  // ── Register plugin capabilities ─────────────────────────────────────────
  PH.registerTab(TAB_ID, "Image Converter", "bi bi-arrow-repeat", renderTab);

  PH.registerMetadataRenderer("image-converter-send", function (asset) {
    if (!asset || !asset.path) return null;
    var box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-arrow-repeat"></i> Image Converter</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Queue this image for batch conversion.</span>' +
      '  <button type="button" class="win-button" id="converter-send-asset">' +
      '    <i class="bi bi-send"></i> Send to Converter' +
      '  </button>' +
      '</div>';
    var sendBtn = box.querySelector("#converter-send-asset");
    sendBtn.addEventListener("click", function () {
      addToQueue(asset.path);
      log("Sent to converter: " + asset.path, "info");
      closeInfoModal();
      navigateToTab();
    });
    return box;
  });

  PH.registerToolbarButton("image-converter-selection", "Convert Selected", "bi bi-arrow-repeat", function (selection) {
    var paths = (selection || []).map(function (a) { return a.path; }).filter(Boolean);
    if (paths.length === 0) return;
    paths.forEach(addToQueue);
    closeInfoModal();
    navigateToTab();
  });

  PH.registerContextMenuItem("image-converter-ctx", "Send to Converter", function (asset) {
    if (!asset || !asset.path) return;
    addToQueue(asset.path);
    closeInfoModal();
    navigateToTab();
  });

  console.log("image-converter: registered tab, renderer, toolbar button, and context menu item.");
})();
