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
  var targetSizeMb = 25;
  var audioBitrateKbps = 0;
  var mixdown = "";
  var sampleRate = 0;
  var mode = localStorage.getItem("ffmpeg-transcoder-mode") || "guided";
  var customArgs = localStorage.getItem("ffmpeg-transcoder-custom-args") || "";
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

  function formatBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return "unknown size";
    if (bytes === 0) return "0 B";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
        var sizeInfo = "";
        if (progress.input_size_bytes !== undefined && progress.input_size_bytes !== null &&
            progress.output_size_bytes !== undefined && progress.output_size_bytes !== null) {
          var breakdown = "";
          if (progress.output_video_size_bytes !== undefined && progress.output_video_size_bytes !== null &&
              progress.output_audio_size_bytes !== undefined && progress.output_audio_size_bytes !== null) {
            breakdown = " (Video: " + formatBytes(progress.output_video_size_bytes) + ", Audio: " + formatBytes(progress.output_audio_size_bytes) + ")";
          }
          sizeInfo = " [" + formatBytes(progress.input_size_bytes) + " -> " + formatBytes(progress.output_size_bytes) + breakdown + "]";
        }
        var msg = "OK " + sourcePath + sizeInfo + "  ->  " + progress.output_path + "  (" + formatDuration(Date.now() - startedAt) + ")";
        log(msg, "success");
        console.log("ffmpeg-transcoder: " + msg);
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

    var isCustom = mode === "custom" && customArgs.trim().length > 0;
    if (isCustom) {
      if (customArgs.indexOf("{input}") === -1) {
        log("Custom command must include the {input} placeholder for the source video.", "error");
        setBusy(false);
        return;
      }
      if (customArgs.indexOf("{output}") === -1) {
        log("Custom command must include the {output} placeholder for the output file.", "error");
        setBusy(false);
        return;
      }
    }

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
          vcodec: isCustom ? null : (vcodec || null),
          acodec: isCustom ? null : (acodec || null),
          crf: isCustom ? null : (qualityMode === "crf" && crf > 0 ? crf : null),
          video_bitrate: isCustom ? null : (qualityMode === "bitrate" && bitrateKbps > 0 ? bitrateKbps : null),
          preset: isCustom ? null : (preset || null),
          target_size_mb: isCustom ? null : (qualityMode === "size_budget" && targetSizeMb > 0 ? targetSizeMb : null),
          audio_bitrate: isCustom ? null : (audioBitrateKbps > 0 ? audioBitrateKbps : null),
          mixdown: isCustom ? null : (mixdown || null),
          sample_rate: isCustom ? null : (sampleRate > 0 ? sampleRate : null),
          custom_args: isCustom ? customArgs.trim() : null
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
      '      <label for="transcoder-mode" style="min-width:110px;">Mode:</label>' +
      '      <select class="input-field" id="transcoder-mode" style="width:130px;height:24px;">' +
      '        <option value="guided">Guided</option>' +
      '        <option value="custom">Custom command</option>' +
      '      </select>' +
      '    </div>' +

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
      '      <span id="transcoder-vcodec-wrap"><label for="transcoder-vcodec" style="min-width:70px;">Video codec:</label>' +
      '      <select class="input-field" id="transcoder-vcodec" style="width:130px;height:24px;"></select></span>' +
      '      <span id="transcoder-acodec-wrap"><label for="transcoder-acodec" style="min-width:70px;">Audio codec:</label>' +
      '      <select class="input-field" id="transcoder-acodec" style="width:130px;height:24px;"></select></span>' +
      '    </div>' +

      '    <div class="form-group" id="transcoder-quality-row">' +
      '      <label for="transcoder-quality-mode" style="min-width:110px;">Quality:</label>' +
      '      <select class="input-field" id="transcoder-quality-mode" style="width:130px;height:24px;">' +
      '        <option value="crf">CRF</option>' +
      '        <option value="bitrate">Avg bitrate</option>' +
      '        <option value="size_budget">Size budget</option>' +
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
      '      <div id="transcoder-size-budget-group" style="display:none;align-items:center;gap:8px;">' +
      '        <input type="number" id="transcoder-size-budget" min="1" value="25" style="width:80px;height:24px;" class="input-field" />' +
      '        <label for="transcoder-size-budget" style="font-size:10px;color:#777;white-space:nowrap;">MB</label>' +
      '        <button type="button" class="win-button transcoder-size-preset" data-val="8" style="font-size:10px;padding:1px 6px;">8 MB</button>' +
      '        <button type="button" class="win-button transcoder-size-preset" data-val="25" style="font-size:10px;padding:1px 6px;">25 MB</button>' +
      '        <button type="button" class="win-button transcoder-size-preset" data-val="50" style="font-size:10px;padding:1px 6px;">50 MB</button>' +
      '        <button type="button" class="win-button transcoder-size-preset" data-val="100" style="font-size:10px;padding:1px 6px;">100 MB</button>' +
      '      </div>' +
      '      <label for="transcoder-preset" style="min-width:70px;">Preset:</label>' +
      '      <select class="input-field" id="transcoder-preset" style="width:130px;height:24px;"></select>' +
      '    </div>' +
      '    <div class="group-box" id="transcoder-audio-settings-block">' +
      '      <div class="group-box-title"><i class="bi bi-music-note-beamed"></i> Audio Settings</div>' +
      '      <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:4px 0;">' +
      '        <div class="form-group" style="margin-bottom:0;">' +
      '          <label for="transcoder-audio-bitrate" style="min-width:80px;">Bitrate:</label>' +
      '          <select class="input-field" id="transcoder-audio-bitrate" style="width:100px;height:24px;">' +
      '            <option value="0">Auto</option>' +
      '            <option value="64">64 kbps</option>' +
      '            <option value="96">96 kbps</option>' +
      '            <option value="128">128 kbps</option>' +
      '            <option value="192">192 kbps</option>' +
      '            <option value="256">256 kbps</option>' +
      '            <option value="320">320 kbps</option>' +
      '          </select>' +
      '        </div>' +
      '        <div class="form-group" style="margin-bottom:0;">' +
      '          <label for="transcoder-audio-mixdown" style="min-width:60px;">Channels:</label>' +
      '          <select class="input-field" id="transcoder-audio-mixdown" style="width:100px;height:24px;">' +
      '            <option value="">Original</option>' +
      '            <option value="mono">Mono</option>' +
      '            <option value="stereo">Stereo</option>' +
      '            <option value="5.1">5.1 channels</option>' +
      '          </select>' +
      '        </div>' +
      '        <div class="form-group" style="margin-bottom:0;">' +
      '          <label for="transcoder-audio-samplerate" style="min-width:80px;">Sample Rate:</label>' +
      '          <select class="input-field" id="transcoder-audio-samplerate" style="width:100px;height:24px;">' +
      '            <option value="0">Original</option>' +
      '            <option value="22050">22050 Hz</option>' +
      '            <option value="32000">32000 Hz</option>' +
      '            <option value="44100">44100 Hz</option>' +
      '            <option value="48000">48000 Hz</option>' +
      '          </select>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +

      '    <div class="group-box" id="transcoder-custom-args-block" style="display:none;">' +
      '      <div class="group-box-title"><i class="bi bi-terminal-plus"></i> Custom FFmpeg command</div>' +
      '      <textarea id="transcoder-custom-args" rows="4" spellcheck="false" style="width:100%;box-sizing:border-box;font-family:\'Consolas\',monospace;font-size:11px;"' +
      ' placeholder="-i {input} -c:v libx264 -crf 18 -preset medium -c:a aac {output}"></textarea>' +
      '      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;">' +
      '        <span style="font-size:10px;color:#777;">Use <b>{input}</b> and <b>{output}</b> placeholders for the source and output paths. The output file extension follows the Target format.</span>' +
      '        <button type="button" class="win-button" id="transcoder-custom-default-btn" style="font-size:10px;padding:1px 8px;flex:none;">Use default template</button>' +
      '      </div>' +
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

    function updateAudioControls() {
      var acVal = acodecSelect ? acodecSelect.value : "";
      var block = container.querySelector("#transcoder-audio-settings-block");
      if (block) {
        block.style.display = acVal === "none" ? "none" : "block";
      }
      var isCopy = acVal === "copy";
      var abSelect = container.querySelector("#transcoder-audio-bitrate");
      var mdSelect = container.querySelector("#transcoder-audio-mixdown");
      var srSelect = container.querySelector("#transcoder-audio-samplerate");
      if (abSelect) abSelect.disabled = isCopy;
      if (mdSelect) mdSelect.disabled = isCopy;
      if (srSelect) srSelect.disabled = isCopy;
    }

    function setCodecOptions() {
      var format = formatSelect ? formatSelect.value : "mp4";
      var vcodecs = format === "webm"
        ? [["", "Auto"], ["libvpx-vp9", "VP9"], ["libvpx", "VP8"], ["libaom-av1", "AV1"], ["copy", "Copy stream"]]
        : [["", "Auto"], ["libx264", "H.264"], ["libx265", "H.265"], ["libaom-av1", "AV1"], ["copy", "Copy stream"]];
      var acodecs = format === "webm"
        ? [["", "Auto"], ["libopus", "Opus"], ["vorbis", "Vorbis"], ["copy", "Copy stream"], ["none", "No audio"]]
        : [["", "Auto"], ["aac", "AAC"], ["mp3", "MP3"], ["vorbis", "Vorbis"], ["copy", "Copy stream"], ["none", "No audio"]];
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
      updateAudioControls();
    }

    if (formatSelect) {
      formatSelect.value = targetFormat;
      formatSelect.addEventListener("change", function () {
        targetFormat = formatSelect.value;
        setCodecOptions();
      });
    }
    if (vcodecSelect) vcodecSelect.addEventListener("change", function () { vcodec = vcodecSelect.value; });
    if (acodecSelect) {
      acodecSelect.addEventListener("change", function () {
        acodec = acodecSelect.value;
        updateAudioControls();
      });
    }
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
    var sizeBudgetGroup = container.querySelector("#transcoder-size-budget-group");
    var sizeBudgetInput = container.querySelector("#transcoder-size-budget");

    function updateQualityMode() {
      var mode = qualityModeSelect ? qualityModeSelect.value : "crf";
      qualityMode = mode;
      if (crfGroup) crfGroup.style.display = mode === "crf" ? "flex" : "none";
      if (bitrateGroup) bitrateGroup.style.display = mode === "bitrate" ? "flex" : "none";
      if (sizeBudgetGroup) sizeBudgetGroup.style.display = mode === "size_budget" ? "flex" : "none";
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
    if (sizeBudgetInput) {
      sizeBudgetInput.value = String(targetSizeMb);
      sizeBudgetInput.addEventListener("input", function () {
        targetSizeMb = parseFloat(sizeBudgetInput.value) || 25;
      });
    }
    var sizePresets = container.querySelectorAll(".transcoder-size-preset");
    sizePresets.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var val = btn.getAttribute("data-val");
        if (sizeBudgetInput) {
          sizeBudgetInput.value = val;
          targetSizeMb = parseFloat(val) || 25;
        }
      });
    });

    var audioBitrateSelect = container.querySelector("#transcoder-audio-bitrate");
    if (audioBitrateSelect) {
      audioBitrateSelect.value = String(audioBitrateKbps);
      audioBitrateSelect.addEventListener("change", function () {
        audioBitrateKbps = parseInt(audioBitrateSelect.value, 10) || 0;
      });
    }

    var audioMixdownSelect = container.querySelector("#transcoder-audio-mixdown");
    if (audioMixdownSelect) {
      audioMixdownSelect.value = mixdown;
      audioMixdownSelect.addEventListener("change", function () {
        mixdown = audioMixdownSelect.value;
      });
    }

    var audioSampleRateSelect = container.querySelector("#transcoder-audio-samplerate");
    if (audioSampleRateSelect) {
      audioSampleRateSelect.value = String(sampleRate);
      audioSampleRateSelect.addEventListener("change", function () {
        sampleRate = parseInt(audioSampleRateSelect.value, 10) || 0;
      });
    }

    updateQualityMode();

    var modeSelect = container.querySelector("#transcoder-mode");
    var vcodecWrap = container.querySelector("#transcoder-vcodec-wrap");
    var acodecWrap = container.querySelector("#transcoder-acodec-wrap");
    var qualityRow = container.querySelector("#transcoder-quality-row");
    var audioSettingsBlock = container.querySelector("#transcoder-audio-settings-block");
    var customBlock = container.querySelector("#transcoder-custom-args-block");
    var customTextarea = container.querySelector("#transcoder-custom-args");

    function updateMode() {
      mode = modeSelect ? modeSelect.value : "guided";
      var isCustom = mode === "custom";
      if (vcodecWrap) vcodecWrap.style.display = isCustom ? "none" : "";
      if (acodecWrap) acodecWrap.style.display = isCustom ? "none" : "";
      if (qualityRow) qualityRow.style.display = isCustom ? "none" : "";
      if (audioSettingsBlock) {
        var acVal = acodecSelect ? acodecSelect.value : "";
        audioSettingsBlock.style.display = (isCustom || acVal === "none") ? "none" : "block";
      }
      if (customBlock) customBlock.style.display = isCustom ? "block" : "none";
    }

    if (modeSelect) {
      modeSelect.value = mode;
      modeSelect.addEventListener("change", function () {
        localStorage.setItem("ffmpeg-transcoder-mode", modeSelect.value);
        updateMode();
      });
    }
    if (customTextarea) {
      customTextarea.value = customArgs;
      customTextarea.addEventListener("input", function () {
        customArgs = customTextarea.value;
        localStorage.setItem("ffmpeg-transcoder-custom-args", customArgs);
      });
    }
    var customDefaultBtn = container.querySelector("#transcoder-custom-default-btn");
    if (customDefaultBtn) {
      customDefaultBtn.addEventListener("click", function () {
        var template = "-i {input} -c:v libx264 -crf 18 -preset medium -c:a aac {output}";
        customArgs = template;
        if (customTextarea) customTextarea.value = template;
        localStorage.setItem("ffmpeg-transcoder-custom-args", template);
        log("Custom command template filled. Edit as needed.", "info");
      });
    }
    updateMode();

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
