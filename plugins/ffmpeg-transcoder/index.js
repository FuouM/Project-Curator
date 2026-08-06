// Project Curator - FFmpeg Transcoder plugin (v1.0.0)
//
// Runs in the dashboard's global scope, loaded by PluginHost.initPlugins().
// Exposes:
//   - A plugin tab with drag-and-drop queue, target format, codec options,
//     CRF, preset, and live progress.
//   - A metadata renderer ("Send to Transcoder") in the image info modal.
//   - A toolbar button ("Transcode Selected") in select-mode toolbars.
//
// All work is done by the service's TranscodeVideo IPC endpoint, which spawns
// FFmpeg as a polled background job (GetTranscodeProgress). Outputs are plain
// files in the user-chosen output_dir and never touch the library.
(function () {
  "use strict";

  var PH = window.PluginHost;
  if (!PH) {
    console.error("ffmpeg-transcoder: PluginHost not available; aborting.");
    return;
  }

  var TAB_ID = "ffmpeg-transcoder";
  var VIDEO_RE = /\.(mp4|webm)$/i;

  var queue = [];
  var inQueue = {};
  var outputDir = "";
  var targetFormat = "mp4";
  var vcodec = "";
  var acodec = "";
  var qualityMode = "crf";
  var crf = 23;
  var bitrateKbps = 6000;
  var preset = "";
  var busy = false;
  var pollTimer = null;
  var verbose = localStorage.getItem("ffmpeg-transcoder-verbose") === "true";

  function setVerbose(value) {
    verbose = !!value;
    localStorage.setItem("ffmpeg-transcoder-verbose", verbose ? "true" : "false");
  }

  function verboseLog(message, kind) {
    if (verbose) log(message, kind);
  }

  function formatDuration(ms) {
    if (ms < 1000) return Math.round(ms) + " ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " s";
    var m = Math.floor(s / 60);
    var rem = Math.round(s % 60);
    return m + "m " + rem + "s";
  }

  function el(id) {
    return document.getElementById(id);
  }

  function log(message, kind) {
    var box = el("transcoder-log");
    if (!box) return;
    var colors = { info: "#cccccc", success: "#10b981", error: "#f87171" };
    var line = document.createElement("div");
    line.style.cssText = "font-family: 'Consolas', monospace; font-size: 11px; line-height: 1.4; color: " +
      (colors[kind] || colors.info) + "; white-space: pre-wrap; word-break: break-all;";
    line.textContent = message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function updateQueueList() {
    var list = el("transcoder-queue-list");
    if (!list) return;
    list.innerHTML = "";
    queue.forEach(function (path, index) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 6px;" +
        "border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;" +
        "background:var(--sys-window-bg,#fff);font-size:11px;";
      var parts = path.split(/[\\/]/);
      var base = parts.pop();
      var label = document.createElement("span");
      label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      label.title = path;
      label.textContent = base;
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
    var empty = el("transcoder-queue-empty");
    if (empty) empty.style.display = queue.length === 0 ? "block" : "none";
    var count = el("transcoder-queue-count");
    if (count) count.textContent = queue.length + " file(s) queued";
  }

  function addToQueue(path) {
    if (!path) return;
    if (!VIDEO_RE.test(path)) {
      log("Not a supported video (mp4/webm): " + path, "error");
      return;
    }
    if (inQueue[path]) {
      verboseLog("Already queued: " + path, "info");
      return;
    }
    inQueue[path] = true;
    queue.push(path);
    updateQueueList();
    updateProgress(0, queue.length);
    verboseLog("Queued: " + path, "info");
  }

  function updateProgress(done, total) {
    var fill = el("transcoder-progress-fill");
    var text = el("transcoder-progress-text");
    if (!fill) return;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + "%";
    if (text) text.textContent = done + " / " + total + " (" + pct + "%)";
  }

  function setBusy(value) {
    busy = value;
    var btn = el("transcoder-run-btn");
    if (btn) {
      btn.disabled = value;
      btn.innerHTML = value
        ? '<i class="bi bi-hourglass-split"></i> Transcoding...'
        : '<i class="bi bi-collection-play"></i> Transcode';
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
      if (candidate.toLowerCase() === sourcePath.toLowerCase()) {
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

  function closeInfoModal() {
    var modal = document.getElementById("image-info-modal");
    if (!modal || !modal.classList.contains("active")) return;
    var closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) {
      closeBtn.click();
    } else {
      modal.classList.remove("active");
    }
  }

  function navigateToTab() {
    var item = document.querySelector('.nav-item[data-view="extensions-' + TAB_ID + '"]');
    if (item) item.click();
  }

  function makeJobId() {
    return "transcode_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  }

  function pollProgress(jobId, sourcePath, outputPath, doneCallback) {
    if (pollTimer) clearTimeout(pollTimer);
    var commandLogged = false;
    var startedAt = Date.now();
    var tick = async function () {
      var resp = await PH.callService("GetTranscodeProgress", { job_id: jobId });
      var progress = resp && resp.TranscodeProgressResult;
      if (!progress) {
        log("Lost transcode job: " + sourcePath, "error");
        setBusy(false);
        return;
      }
      var pct = Math.round(progress.percent || 0);
      var fill = el("transcoder-progress-fill");
      var text = el("transcoder-progress-text");
      if (fill) fill.style.width = pct + "%";
      var base = sourcePath.split(/[\\/]/).pop();
      if (text) {
        var detail = progress.x_speed ? "  (" + progress.fps.toFixed(1) + " fps, " + progress.x_speed.toFixed(2) + "x)" : "";
        text.textContent = base + " " + pct + "%" + detail;
      }
      if (verbose && !commandLogged && progress.command) {
        commandLogged = true;
        verboseLog("COMMAND " + progress.command, "info");
      }
      if (progress.error) {
        log("FAIL " + sourcePath + " - " + progress.error + " (" + formatDuration(Date.now() - startedAt) + ")", "error");
        setBusy(false);
        updateProgress(0, queue.length);
        doneCallback(false);
        return;
      }
      if (!progress.running && pct >= 100) {
        log("OK " + sourcePath + "  ->  " + progress.output_path + "  (" + formatDuration(Date.now() - startedAt) + ")", "success");
        setBusy(false);
        updateProgress(0, queue.length);
        doneCallback(true);
        return;
      }
      if (!progress.running) {
        log("FAIL " + sourcePath + " - job ended before completion. (" + formatDuration(Date.now() - startedAt) + ")", "error");
        setBusy(false);
        updateProgress(0, queue.length);
        doneCallback(false);
        return;
      }
      pollTimer = setTimeout(tick, 500);
    };
    tick();
  }

  async function runTranscode() {
    if (busy) return;
    if (queue.length === 0) {
      log("No videos queued. Drag & drop mp4/webm files or use Send to Transcoder.", "error");
      return;
    }
    if (!outputDir) {
      log("Choose an output directory first.", "error");
      return;
    }

    var sources = queue.slice();
    setBusy(true);
    var batchStartedAt = Date.now();
    log("Resolving output paths and detecting collisions...", "info");

    var transcodes = [];
    try {
      for (var i = 0; i < sources.length; i++) {
        var tgt = await getUniqueOutputPath(sources[i], outputDir, targetFormat);
        transcodes.push([sources[i], tgt]);
      }
    } catch (err) {
      log("Path resolution failed: " + (err && err.message ? err.message : String(err)), "error");
      setBusy(false);
      return;
    }

    log("Transcoding " + transcodes.length + " video(s) to " + targetFormat + " ...", "info");
    var next = async function (index) {
      if (index >= transcodes.length) {
        log("Done. Total: " + formatDuration(Date.now() - batchStartedAt), "success");
        setBusy(false);
        return;
      }
      var src = transcodes[index][0];
      var tgt = transcodes[index][1];
      var jobId = makeJobId();
      try {
        var resp = await PH.callService("TranscodeVideo", {
          job_id: jobId,
          input_path: src,
          output_path: tgt,
          target_format: targetFormat,
          vcodec: vcodec || null,
          acodec: acodec || null,
          crf: qualityMode === "crf" && crf > 0 ? crf : null,
          video_bitrate: qualityMode === "bitrate" && bitrateKbps > 0 ? bitrateKbps : null,
          preset: preset || null
        });
        if (resp && resp.Error) {
          log("FAIL " + src + " - " + resp.Error.message, "error");
          next(index + 1);
          return;
        }
      } catch (e) {
        log("FAIL " + src + " - " + (e && e.message ? e.message : String(e)), "error");
        next(index + 1);
        return;
      }

      pollProgress(jobId, src, tgt, function (ok) {
        next(index + 1);
      });
    };
    next(0);
  }

  function setupDropZone() {
    var api = window.__TAURI__;
    if (!api || !api.webview || !api.webview.getCurrentWebview) return;
    var dropZone = el("transcoder-drop-zone");
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

  function renderTab() {
    var container = document.createElement("div");

    container.innerHTML =
      '<div class="group-box">' +
      '  <div class="group-box-title"><i class="bi bi-collection-play"></i> FFmpeg Transcoder</div>' +
      '  <div style="display:flex;flex-direction:column;gap:12px;">' +

      '    <div class="form-group">' +
      '      <label for="transcoder-output-dir" style="min-width:110px;">Output folder:</label>' +
      '      <div class="input-wrapper" style="flex:1;">' +
      '        <input class="input-field has-clear" id="transcoder-output-dir" placeholder="Where transcoded files should be written..." />' +
      '        <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>' +
      '      </div>' +
      '      <button type="button" class="win-button" id="transcoder-browse-btn"><i class="bi bi-folder2-open"></i> Browse...</button>' +
      '    </div>' +

      '    <div class="form-group">' +
      '      <label for="transcoder-format" style="min-width:110px;">Target format:</label>' +
      '      <select class="input-field" id="transcoder-format" style="width:140px;height:24px;">' +
      '        <option value="mp4">MP4</option>' +
      '        <option value="webm">WebM</option>' +
      '      </select>' +
      '      <label for="transcoder-vcodec" style="min-width:70px;">Video codec:</label>' +
      '      <select class="input-field" id="transcoder-vcodec" style="width:130px;height:24px;"></select>' +
      '      <label for="transcoder-acodec" style="min-width:70px;">Audio codec:</label>' +
      '      <select class="input-field" id="transcoder-acodec" style="width:130px;height:24px;"></select>' +
      '    </div>' +

      '    <div class="form-group">' +
      '      <label for="transcoder-quality-mode" style="min-width:110px;">Quality:</label>' +
      '      <select class="input-field" id="transcoder-quality-mode" style="width:130px;height:24px;">' +
      '        <option value="crf">CRF</option>' +
      '        <option value="bitrate">Avg bitrate</option>' +
      '      </select>' +
      '      <div id="transcoder-crf-group" style="display:flex;align-items:center;gap:8px;flex:1;">' +
      '        <label for="transcoder-crf" style="font-size:10px;color:#777;white-space:nowrap;">more quality</label>' +
      '        <input type="range" id="transcoder-crf" min="0" max="51" value="23" style="flex:1;max-width:160px;" />' +
      '        <label for="transcoder-crf" style="font-size:10px;color:#777;white-space:nowrap;">less quality</label>' +
      '        <span id="transcoder-crf-value" style="font-size:11px;color:#555;min-width:30px;">23</span>' +
      '      </div>' +
      '      <div id="transcoder-bitrate-group" style="display:none;align-items:center;gap:8px;">' +
      '        <input type="number" id="transcoder-bitrate" min="100" step="100" value="6000" style="width:100px;height:24px;" class="input-field" />' +
      '        <label for="transcoder-bitrate" style="font-size:10px;color:#777;white-space:nowrap;">kbps</label>' +
      '      </div>' +
      '      <label for="transcoder-preset" style="min-width:70px;">Preset:</label>' +
      '      <select class="input-field" id="transcoder-preset" style="width:130px;height:24px;"></select>' +
      '    </div>' +

      '    <div id="transcoder-drop-host">' +
      '      <div class="toolbox-drop-zone" id="transcoder-drop-zone" style="flex:none;height:130px;">' +
      '        <div class="toolbox-drop-icon"><i class="bi bi-collection-play"></i></div>' +
      '        <span>Drop video files (mp4/webm) here to queue them</span>' +
      '      </div>' +
      '    </div>' +

      '    <div class="group-box" style="margin-top:8px;">' +
      '      <div class="group-box-title">Queue <span id="transcoder-queue-count" style="font-weight:400;color:#777;font-size:10px;">0 file(s) queued</span>' +
      '        <button type="button" class="win-button" id="transcoder-clear-btn" style="font-size:10px;padding:1px 8px;margin-left:8px;"><i class="bi bi-trash3"></i> Clear</button></div>' +
      '      <div id="transcoder-queue-empty" style="font-size:11px;color:#999;font-style:italic;padding:4px 0;">No files queued.</div>' +
      '      <div id="transcoder-queue-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;"></div>' +
      '    </div>' +

      '    <div style="display:flex;align-items:center;gap:12px;">' +
      '      <button type="button" class="win-button primary" id="transcoder-run-btn" style="padding:4px 14px;">' +
      '        <i class="bi bi-collection-play"></i> Transcode' +
      '      </button>' +
      '      <div class="progress-bar" style="flex:1;max-width:300px;">' +
      '        <div class="progress-fill" id="transcoder-progress-fill" style="width:0%;"></div>' +
      '      </div>' +
      '      <span id="transcoder-progress-text" style="font-size:11px;color:#555;">0 / 0 (0%)</span>' +
      '    </div>' +

      '    <div class="group-box" style="margin-top:8px;">' +
      '      <div class="group-box-title"><i class="bi bi-terminal"></i> Output Log' +
      '        <label style="margin-left:8px;font-weight:400;font-size:10px;color:#777;display:inline-flex;align-items:center;gap:4px;cursor:pointer;">' +
      '          <input type="checkbox" id="transcoder-verbose" /> Verbose' +
      '        </label></div>' +
      '      <div id="transcoder-log" style="height:140px;overflow-y:auto;background-color:#1e1e1e;color:#cccccc;border:1px solid #7a7a7a;padding:8px;font-family:\'Consolas\',monospace;font-size:11px;white-space:pre-wrap;"></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var runBtn = container.querySelector("#transcoder-run-btn");
    if (runBtn) runBtn.addEventListener("click", runTranscode);

    var clearBtn = container.querySelector("#transcoder-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        queue.length = 0;
        inQueue = {};
        updateQueueList();
        updateProgress(0, 0);
        log("Queue cleared.", "info");
      });
    }

    var browseBtn = container.querySelector("#transcoder-browse-btn");
    var outInput = container.querySelector("#transcoder-output-dir");
    if (browseBtn && outInput && window.__TAURI__ && window.__TAURI__.core) {
      browseBtn.addEventListener("click", function () {
        window.__TAURI__.core.invoke("select_path", { isDirectory: true }).then(function (path) {
          if (path) {
            outInput.value = path;
            outputDir = path;
            verboseLog("Output directory set: " + path, "success");
          }
        }).catch(function (err) {
          log("Folder picker failed: " + (err && err.message ? err.message : err), "error");
        });
      });
    }
    if (outInput) {
      outInput.addEventListener("change", function () {
        outputDir = outInput.value.trim();
      });
    }

    var formatSelect = container.querySelector("#transcoder-format");
    var vcodecSelect = container.querySelector("#transcoder-vcodec");
    var acodecSelect = container.querySelector("#transcoder-acodec");
    var presetSelect = container.querySelector("#transcoder-preset");

    function setCodecOptions() {
      var format = formatSelect ? formatSelect.value : "mp4";
      var vcodecs = format === "webm"
        ? [["", "Auto"], ["libvpx-vp9", "VP9"], ["libvpx", "VP8"], ["libaom-av1", "AV1"]]
        : [["", "Auto"], ["libx264", "H.264"], ["libx265", "H.265"], ["libaom-av1", "AV1"]];
      var acodecs = format === "webm"
        ? [["", "Auto"], ["libopus", "Opus"], ["none", "No audio"]]
        : [["", "Auto"], ["aac", "AAC"], ["mp3", "MP3"], ["none", "No audio"]];
      if (vcodecSelect) {
        var prevV = vcodec;
        vcodecSelect.innerHTML = vcodecs.map(function (c) {
          return '<option value="' + c[0] + '">' + c[1] + '</option>';
        }).join("");
        vcodecSelect.value = vcodecs.some(function (c) { return c[0] === prevV; }) ? prevV : "";
      }
      if (acodecSelect) {
        var prevA = acodec;
        acodecSelect.innerHTML = acodecs.map(function (c) {
          return '<option value="' + c[0] + '">' + c[1] + '</option>';
        }).join("");
        acodecSelect.value = acodecs.some(function (c) { return c[0] === prevA; }) ? prevA : "";
      }
      if (presetSelect) {
        var presets = format === "webm"
          ? [["", "Default"], ["good", "Good"], ["realtime", "Realtime"], ["best", "Best"]]
          : [["", "Default"], ["ultrafast", "Ultrafast"], ["fast", "Fast"], ["medium", "Medium"], ["slow", "Slow"], ["veryslow", "Veryslow"]];
        presetSelect.innerHTML = presets.map(function (p) {
          return '<option value="' + p[0] + '">' + p[1] + '</option>';
        }).join("");
      }
    }

    if (formatSelect) {
      formatSelect.value = targetFormat;
      formatSelect.addEventListener("change", function () {
        targetFormat = formatSelect.value;
        setCodecOptions();
      });
    }
    if (vcodecSelect) vcodecSelect.addEventListener("change", function () { vcodec = vcodecSelect.value; });
    if (acodecSelect) acodecSelect.addEventListener("change", function () { acodec = acodecSelect.value; });
    if (presetSelect) presetSelect.addEventListener("change", function () { preset = presetSelect.value; });

    var crfInput = container.querySelector("#transcoder-crf");
    var crfValue = container.querySelector("#transcoder-crf-value");
    if (crfInput) {
      crfInput.addEventListener("input", function () {
        crf = parseInt(crfInput.value, 10) || 0;
        if (crfValue) crfValue.textContent = String(crf);
      });
    }

    var qualityModeSelect = container.querySelector("#transcoder-quality-mode");
    var crfGroup = container.querySelector("#transcoder-crf-group");
    var bitrateGroup = container.querySelector("#transcoder-bitrate-group");
    var bitrateInput = container.querySelector("#transcoder-bitrate");
    function updateQualityMode() {
      var mode = qualityModeSelect ? qualityModeSelect.value : "crf";
      qualityMode = mode;
      if (crfGroup) crfGroup.style.display = mode === "crf" ? "flex" : "none";
      if (bitrateGroup) bitrateGroup.style.display = mode === "bitrate" ? "flex" : "none";
      if (bitrateInput) bitrateInput.disabled = mode !== "bitrate";
    }
    if (qualityModeSelect) {
      qualityModeSelect.value = qualityMode;
      qualityModeSelect.addEventListener("change", updateQualityMode);
    }
    if (bitrateInput) {
      bitrateInput.addEventListener("input", function () {
        bitrateKbps = parseInt(bitrateInput.value, 10) || 0;
      });
    }
    updateQualityMode();

    setCodecOptions();

    var verboseCheckbox = container.querySelector("#transcoder-verbose");
    if (verboseCheckbox) {
      verboseCheckbox.checked = verbose;
      verboseCheckbox.addEventListener("change", function () {
        setVerbose(verboseCheckbox.checked);
        log(verbose ? "Verbose logging enabled." : "Verbose logging disabled.", "info");
      });
    }

    setTimeout(function () {
      setupDropZone();
      updateQueueList();
      updateProgress(0, queue.length);
    }, 0);
    return container;
  }

  PH.registerTab(TAB_ID, "FFmpeg Transcoder", "bi bi-collection-play", renderTab);

  PH.registerMetadataRenderer("ffmpeg-transcoder-send", function (asset) {
    if (!asset || !asset.path || !VIDEO_RE.test(asset.path)) return null;
    var box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-collection-play"></i> FFmpeg Transcoder</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Queue this video for transcoding.</span>' +
      '  <button type="button" class="win-button" id="transcoder-send-asset">' +
      '    <i class="bi bi-send"></i> Send to Transcoder' +
      '  </button>' +
      '</div>';
    var sendBtn = box.querySelector("#transcoder-send-asset");
    sendBtn.addEventListener("click", function () {
      addToQueue(asset.path);
      log("Sent to transcoder: " + asset.path, "info");
      closeInfoModal();
      navigateToTab();
    });
    return box;
  });

  PH.registerToolbarButton("ffmpeg-transcoder-selection", "Transcode Selected", "bi bi-collection-play", function (selection) {
    var paths = (selection || []).map(function (a) { return a.path; }).filter(Boolean);
    if (paths.length === 0) return;
    paths.forEach(addToQueue);
    closeInfoModal();
    navigateToTab();
  });

  PH.registerContextMenuItem("ffmpeg-transcoder-ctx", "Send to Transcoder", function (asset) {
    if (!asset || !asset.path) return;
    addToQueue(asset.path);
    closeInfoModal();
    navigateToTab();
  });

  console.log("ffmpeg-transcoder: registered tab, renderer, toolbar button, and context menu item.");
})();
