/**
 * UI components, DOM event logic, and transcode execution loop for ffmpeg-transcoder.
 */

import { state, TAB_ID, VIDEO_RE, setVerbose, setOutputDir } from "./state";
import { getUniqueOutputPath } from "./ipc";
import {
  createLogger,
  navigateToTab as _navigateToTab,
  closeInfoModal,
  setupDropZone as _setupDropZone,
  formatBytes,
  pollTranscodeProgress,
  pickDirectory,
  savePersisted,
} from "../../lib";

const PH = window.PluginHost;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export const log = createLogger("transcoder-log");

export const navigateToTab = (): void => _navigateToTab(TAB_ID);
export { closeInfoModal };

function verboseLog(message: string, kind?: "info" | "success" | "error"): void {
  if (state.verbose) {
    log(message, kind);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + " ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + " s";
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return m + "m " + rem + "s";
}

export function updateQueueList(): void {
  const list = el("transcoder-queue-list");
  if (!list) return;
  list.innerHTML = "";
  state.queue.forEach((path, index) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:3px 6px;" +
      "border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;" +
      "background:var(--sys-window-bg,#fff);font-size:11px;";
    const parts = path.split(/[\\/]/);
    const base = parts.pop()!;
    const label = document.createElement("span");
    label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    label.title = path;
    label.textContent = base;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "win-button";
    remove.style.cssText = "font-size:10px;padding:1px 6px;";
    remove.innerHTML = '<i class="bi bi-x-lg"></i>';
    remove.addEventListener("click", () => {
      state.queue.splice(index, 1);
      delete state.inQueue[path];
      updateQueueList();
      updateProgress(0, state.queue.length);
    });
    row.appendChild(label);
    row.appendChild(remove);
    list.appendChild(row);
  });
  const empty = el("transcoder-queue-empty");
  if (empty) empty.style.display = state.queue.length === 0 ? "block" : "none";
  const count = el("transcoder-queue-count");
  if (count) count.textContent = state.queue.length + " file(s) queued";
}

export function addToQueue(path: string): void {
  if (!path) return;
  if (!VIDEO_RE.test(path)) {
    log("Not a supported video (mp4/webm): " + path, "error");
    return;
  }
  if (state.inQueue[path]) {
    verboseLog("Already queued: " + path, "info");
    return;
  }
  state.inQueue[path] = true;
  state.queue.push(path);
  updateQueueList();
  updateProgress(0, state.queue.length);
  verboseLog("Queued: " + path, "info");
}

export function updateProgress(done: number, total: number): void {
  const fill = el("transcoder-progress-fill");
  const text = el("transcoder-progress-text");
  if (!fill) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = pct + "%";
  if (text) text.textContent = done + " / " + total + " (" + pct + "%)";
}

export function setBusy(value: boolean): void {
  state.busy = value;
  const btn = el<HTMLButtonElement>("transcoder-run-btn");
  if (btn) {
    btn.disabled = value;
    btn.innerHTML = value
      ? '<i class="bi bi-hourglass-split"></i> Transcoding...'
      : '<i class="bi bi-collection-play"></i> Transcode';
  }
}

function makeJobId(): string {
  return "transcode_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

export async function runTranscode(): Promise<void> {
  if (state.busy) return;
  if (state.queue.length === 0) {
    log("No videos queued. Drag & drop mp4/webm files or use Send to Transcoder.", "error");
    return;
  }
  if (!state.outputDir) {
    log("Choose an output directory first.", "error");
    return;
  }

  const sources = state.queue.slice();
  setBusy(true);
  const batchStartedAt = Date.now();
  log("Resolving output paths and detecting collisions...", "info");

  const transcodes: [string, string][] = [];
  try {
    for (let i = 0; i < sources.length; i++) {
      const tgt = await getUniqueOutputPath(sources[i], state.outputDir, state.targetFormat);
      transcodes.push([sources[i], tgt]);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("Path resolution failed: " + errMsg, "error");
    setBusy(false);
    return;
  }

  log("Transcoding " + transcodes.length + " video(s) to " + state.targetFormat + " ...", "info");

  const isCustom = state.mode === "custom" && state.customArgs.trim().length > 0;
  if (isCustom) {
    if (state.customArgs.indexOf("{input}") === -1) {
      log("Custom command must include the {input} placeholder for the source video.", "error");
      setBusy(false);
      return;
    }
    if (state.customArgs.indexOf("{output}") === -1) {
      log("Custom command must include the {output} placeholder for the output file.", "error");
      setBusy(false);
      return;
    }
  }

  const next = async (index: number): Promise<void> => {
    if (index >= transcodes.length) {
      log("Done. Total: " + formatDuration(Date.now() - batchStartedAt), "success");
      setBusy(false);
      return;
    }
    const src = transcodes[index][0];
    const tgt = transcodes[index][1];
    const jobId = makeJobId();
    try {
      const resp = await PH.callService("TranscodeVideo", {
        job_id: jobId,
        input_path: src,
        output_path: tgt,
        target_format: state.targetFormat,
        vcodec: isCustom ? null : (state.vcodec || null),
        acodec: isCustom ? null : (state.acodec || null),
        crf: isCustom ? null : (state.qualityMode === "crf" && state.crf > 0 ? state.crf : null),
        video_bitrate: isCustom ? null : (state.qualityMode === "bitrate" && state.bitrateKbps > 0 ? state.bitrateKbps : null),
        preset: isCustom ? null : (state.preset || null),
        target_size_mb: isCustom ? null : (state.qualityMode === "size_budget" && state.targetSizeMb > 0 ? state.targetSizeMb : null),
        audio_bitrate: isCustom ? null : (state.audioBitrateKbps > 0 ? state.audioBitrateKbps : null),
        mixdown: isCustom ? null : (state.mixdown || null),
        sample_rate: isCustom ? null : (state.sampleRate > 0 ? state.sampleRate : null),
        custom_args: isCustom ? state.customArgs.trim() : null,
      });
      if (resp && resp.Error) {
        log("FAIL " + src + " - " + resp.Error.message, "error");
        void next(index + 1);
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("FAIL " + src + " - " + msg, "error");
      void next(index + 1);
      return;
    }

    let commandLogged = false;
    const startedAt = Date.now();
    let lastProgress: any = null;

    pollTranscodeProgress({
      jobId,
      onTick: (progress) => {
        lastProgress = progress;
        const pct = progress.percent;
        const fill = el("transcoder-progress-fill");
        const text = el("transcoder-progress-text");
        if (fill) fill.style.width = pct + "%";
        const base = src.split(/[\\/]/).pop()!;
        if (text) {
          const detail = progress.xSpeed ? "  (" + (progress.fps ?? 0).toFixed(1) + " fps, " + progress.xSpeed.toFixed(2) + "x)" : "";
          text.textContent = base + " " + pct + "%" + detail;
        }
        if (state.verbose && !commandLogged && progress.raw.command) {
          commandLogged = true;
          verboseLog("COMMAND " + progress.raw.command, "info");
        }
      },
      onComplete: (ok) => {
        if (!ok) {
          log("FAIL " + src + " - transcode job failed or ended early. (" + formatDuration(Date.now() - startedAt) + ")", "error");
          setBusy(false);
          updateProgress(0, state.queue.length);
          void next(index + 1);
          return;
        }

        let sizeInfo = "";
        if (lastProgress && lastProgress.raw) {
          const raw = lastProgress.raw;
          const inputSize = raw.input_size_bytes;
          const outputSize = raw.output_size_bytes;
          if (inputSize !== undefined && inputSize !== null && outputSize !== undefined && outputSize !== null) {
            let breakdown = "";
            const outVideo = raw.output_video_size_bytes;
            const outAudio = raw.output_audio_size_bytes;
            if (outVideo !== undefined && outVideo !== null && outAudio !== undefined && outAudio !== null) {
              breakdown = " (Video: " + formatBytes(outVideo) + ", Audio: " + formatBytes(outAudio) + ")";
            }
            sizeInfo = " [" + formatBytes(inputSize) + " -> " + formatBytes(outputSize) + breakdown + "]";
          }
        }

        const msg = "OK " + src + sizeInfo + "  ->  " + tgt + "  (" + formatDuration(Date.now() - startedAt) + ")";
        log(msg, "success");
        console.log("ffmpeg-transcoder: " + msg);
        setBusy(false);
        updateProgress(0, state.queue.length);
        void next(index + 1);
      },
    });
  };
  void next(0);
}

export function renderTab(): HTMLElement {
  const container = document.createElement("div");

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

  const runBtn = container.querySelector("#transcoder-run-btn");
  if (runBtn) runBtn.addEventListener("click", () => void runTranscode());

  const clearBtn = container.querySelector("#transcoder-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.queue.length = 0;
      state.inQueue = {};
      updateQueueList();
      updateProgress(0, 0);
      log("Queue cleared.", "info");
    });
  }

  const browseBtn = container.querySelector("#transcoder-browse-btn");
  const outInput = container.querySelector<HTMLInputElement>("#transcoder-output-dir");
  if (outInput) outInput.value = state.outputDir;
  if (browseBtn && outInput && window.__TAURI__ && window.__TAURI__.core) {
    browseBtn.addEventListener("click", async () => {
      const path = await pickDirectory();
      if (path) {
        outInput.value = path;
        setOutputDir(path);
        verboseLog("Output directory set: " + path, "success");
      }
    });
  }
  if (outInput) {
    outInput.addEventListener("change", () => {
      setOutputDir(outInput.value.trim());
    });
  }

  const formatSelect = container.querySelector<HTMLSelectElement>("#transcoder-format");
  const vcodecSelect = container.querySelector<HTMLSelectElement>("#transcoder-vcodec");
  const acodecSelect = container.querySelector<HTMLSelectElement>("#transcoder-acodec");
  const presetSelect = container.querySelector<HTMLSelectElement>("#transcoder-preset");

  function updateAudioControls(): void {
    const acVal = acodecSelect ? acodecSelect.value : "";
    const block = container.querySelector<HTMLElement>("#transcoder-audio-settings-block");
    if (block) {
      block.style.display = acVal === "none" ? "none" : "block";
    }
    const isCopy = acVal === "copy";
    const abSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-bitrate");
    const mdSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-mixdown");
    const srSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-samplerate");
    if (abSelect) abSelect.disabled = isCopy;
    if (mdSelect) mdSelect.disabled = isCopy;
    if (srSelect) srSelect.disabled = isCopy;
  }

  function setCodecOptions(): void {
    const format = formatSelect ? formatSelect.value : "mp4";
    const vcodecs = format === "webm"
      ? [["", "Auto"], ["libvpx-vp9", "VP9"], ["libvpx", "VP8"], ["libaom-av1", "AV1"], ["copy", "Copy stream"]]
      : [["", "Auto"], ["libx264", "H.264"], ["libx265", "H.265"], ["libaom-av1", "AV1"], ["copy", "Copy stream"]];
    const acodecs = format === "webm"
      ? [["", "Auto"], ["libopus", "Opus"], ["vorbis", "Vorbis"], ["copy", "Copy stream"], ["none", "No audio"]]
      : [["", "Auto"], ["aac", "AAC"], ["mp3", "MP3"], ["vorbis", "Vorbis"], ["copy", "Copy stream"], ["none", "No audio"]];
    if (vcodecSelect) {
      const prevV = state.vcodec;
      vcodecSelect.innerHTML = vcodecs.map((c) => {
        return '<option value="' + c[0] + '">' + c[1] + '</option>';
      }).join("");
      vcodecSelect.value = vcodecs.some((c) => c[0] === prevV) ? prevV : "";
    }
    if (acodecSelect) {
      const prevA = state.acodec;
      acodecSelect.innerHTML = acodecs.map((c) => {
        return '<option value="' + c[0] + '">' + c[1] + '</option>';
      }).join("");
      acodecSelect.value = acodecs.some((c) => c[0] === prevA) ? prevA : "";
    }
    if (presetSelect) {
      const presets = format === "webm"
        ? [["", "Default"], ["good", "Good"], ["realtime", "Realtime"], ["best", "Best"]]
        : [["", "Default"], ["ultrafast", "Ultrafast"], ["fast", "Fast"], ["medium", "Medium"], ["slow", "Slow"], ["veryslow", "Veryslow"]];
      presetSelect.innerHTML = presets.map((p) => {
        return '<option value="' + p[0] + '">' + p[1] + '</option>';
      }).join("");
    }
    updateAudioControls();
  }

  if (formatSelect) {
    formatSelect.value = state.targetFormat;
    formatSelect.addEventListener("change", () => {
      state.targetFormat = formatSelect.value;
      setCodecOptions();
    });
  }
  if (vcodecSelect) vcodecSelect.addEventListener("change", () => { state.vcodec = vcodecSelect.value; });
  if (acodecSelect) {
    acodecSelect.addEventListener("change", () => {
      state.acodec = acodecSelect.value;
      updateAudioControls();
    });
  }
  if (presetSelect) presetSelect.addEventListener("change", () => { state.preset = presetSelect.value; });

  const crfInput = container.querySelector<HTMLInputElement>("#transcoder-crf");
  const crfValue = container.querySelector("#transcoder-crf-value");
  if (crfInput) {
    crfInput.addEventListener("input", () => {
      state.crf = parseInt(crfInput.value, 10) || 0;
      if (crfValue) crfValue.textContent = String(state.crf);
    });
  }

  const qualityModeSelect = container.querySelector<HTMLSelectElement>("#transcoder-quality-mode");
  const crfGroup = container.querySelector<HTMLElement>("#transcoder-crf-group");
  const bitrateGroup = container.querySelector<HTMLElement>("#transcoder-bitrate-group");
  const bitrateInput = container.querySelector<HTMLInputElement>("#transcoder-bitrate");
  const sizeBudgetGroup = container.querySelector<HTMLElement>("#transcoder-size-budget-group");
  const sizeBudgetInput = container.querySelector<HTMLInputElement>("#transcoder-size-budget");

  function updateQualityMode(): void {
    const mode = qualityModeSelect ? qualityModeSelect.value : "crf";
    state.qualityMode = mode;
    if (crfGroup) crfGroup.style.display = mode === "crf" ? "flex" : "none";
    if (bitrateGroup) bitrateGroup.style.display = mode === "bitrate" ? "flex" : "none";
    if (sizeBudgetGroup) sizeBudgetGroup.style.display = mode === "size_budget" ? "flex" : "none";
    if (bitrateInput) bitrateInput.disabled = mode !== "bitrate";
  }
  if (qualityModeSelect) {
    qualityModeSelect.value = state.qualityMode;
    qualityModeSelect.addEventListener("change", updateQualityMode);
  }
  if (bitrateInput) {
    bitrateInput.addEventListener("input", () => {
      state.bitrateKbps = parseInt(bitrateInput.value, 10) || 0;
    });
  }
  if (sizeBudgetInput) {
    sizeBudgetInput.value = String(state.targetSizeMb);
    sizeBudgetInput.addEventListener("input", () => {
      state.targetSizeMb = parseFloat(sizeBudgetInput.value) || 25;
    });
  }
  const sizePresets = container.querySelectorAll(".transcoder-size-preset");
  sizePresets.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-val");
      if (sizeBudgetInput && val) {
        sizeBudgetInput.value = val;
        state.targetSizeMb = parseFloat(val) || 25;
      }
    });
  });

  const audioBitrateSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-bitrate");
  if (audioBitrateSelect) {
    audioBitrateSelect.value = String(state.audioBitrateKbps);
    audioBitrateSelect.addEventListener("change", () => {
      state.audioBitrateKbps = parseInt(audioBitrateSelect.value, 10) || 0;
    });
  }

  const audioMixdownSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-mixdown");
  if (audioMixdownSelect) {
    audioMixdownSelect.value = state.mixdown;
    audioMixdownSelect.addEventListener("change", () => {
      state.mixdown = audioMixdownSelect.value;
    });
  }

  const audioSampleRateSelect = container.querySelector<HTMLSelectElement>("#transcoder-audio-samplerate");
  if (audioSampleRateSelect) {
    audioSampleRateSelect.value = String(state.sampleRate);
    audioSampleRateSelect.addEventListener("change", () => {
      state.sampleRate = parseInt(audioSampleRateSelect.value, 10) || 0;
    });
  }

  updateQualityMode();

  const modeSelect = container.querySelector<HTMLSelectElement>("#transcoder-mode");
  const vcodecWrap = container.querySelector<HTMLElement>("#transcoder-vcodec-wrap");
  const acodecWrap = container.querySelector<HTMLElement>("#transcoder-acodec-wrap");
  const qualityRow = container.querySelector<HTMLElement>("#transcoder-quality-row");
  const audioSettingsBlock = container.querySelector<HTMLElement>("#transcoder-audio-settings-block");
  const customBlock = container.querySelector<HTMLElement>("#transcoder-custom-args-block");
  const customTextarea = container.querySelector<HTMLTextAreaElement>("#transcoder-custom-args");

  function updateMode(): void {
    const val = modeSelect ? modeSelect.value : "guided";
    state.mode = val;
    const isCustom = val === "custom";
    if (vcodecWrap) vcodecWrap.style.display = isCustom ? "none" : "";
    if (acodecWrap) acodecWrap.style.display = isCustom ? "none" : "";
    if (qualityRow) qualityRow.style.display = isCustom ? "none" : "";
    if (audioSettingsBlock) {
      const acVal = acodecSelect ? acodecSelect.value : "";
      audioSettingsBlock.style.display = (isCustom || acVal === "none") ? "none" : "block";
    }
    if (customBlock) customBlock.style.display = isCustom ? "block" : "none";
  }

  if (modeSelect) {
    modeSelect.value = state.mode;
    modeSelect.addEventListener("change", () => {
      savePersisted("ffmpeg-transcoder-mode", modeSelect.value);
      updateMode();
    });
  }
  if (customTextarea) {
    customTextarea.value = state.customArgs;
    customTextarea.addEventListener("input", () => {
      state.customArgs = customTextarea.value;
      savePersisted("ffmpeg-transcoder-custom-args", state.customArgs);
    });
  }
  const customDefaultBtn = container.querySelector("#transcoder-custom-default-btn");
  if (customDefaultBtn) {
    customDefaultBtn.addEventListener("click", () => {
      const template = "-i {input} -c:v libx264 -crf 18 -preset medium -c:a aac {output}";
      state.customArgs = template;
      if (customTextarea) customTextarea.value = template;
      savePersisted("ffmpeg-transcoder-custom-args", template);
      log("Custom command template filled. Edit as needed.", "info");
    });
  }
  updateMode();

  setCodecOptions();

  const verboseCheckbox = container.querySelector<HTMLInputElement>("#transcoder-verbose");
  if (verboseCheckbox) {
    verboseCheckbox.checked = state.verbose;
    verboseCheckbox.addEventListener("change", () => {
      setVerbose(verboseCheckbox.checked);
      log(state.verbose ? "Verbose logging enabled." : "Verbose logging disabled.", "info");
    });
  }

  setTimeout(() => {
    _setupDropZone(TAB_ID, "transcoder-drop-zone", (paths) => {
      paths.forEach(addToQueue);
    });
    updateQueueList();
    updateProgress(0, state.queue.length);
  }, 0);

  return container;
}
