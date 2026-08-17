/**
 * FFmpeg compilation & export pipeline for gif-maker.
 *
 * Each `compile*` / `handle*` function reads the active tool panel inputs,
 * starts a service-side transcode/GIF job, and reports progress through
 * `pollCompilationProgress`. The heavy lifting stays in the backend
 * (`TranscodeVideo` / `ProcessGifEffects` / `CreateGifFromImages` /
 * `SplitGif` / `EphemeralConvertImages`).
 */

import { pollTranscodeProgress } from "../../lib";
import { state } from "./state";
import { PH, el, logConsole } from "./ui-core";
import { getTempOutputPath } from "./timeline";
import { buildCaptionCanvas } from "./effects";
import { pushHistoryState } from "./history";

export async function compileImagesToAnimation(): Promise<void> {
  const patternInput = el<HTMLInputElement>("gm-inp-seq-pattern");
  const pattern = patternInput ? patternInput.value.trim() : state.sequencePattern;
  if (!pattern) {
    logConsole("Error: No sequence pattern entered. Example: D:\\renders\\frame_%05d.png", "error");
    return;
  }
  state.sequencePattern = pattern;

  const fps = parseFloat(el<HTMLInputElement>("gm-inp-fps")?.value || "24");
  const loop = parseInt(el<HTMLInputElement>("gm-inp-loop")?.value || "0");
  const format = el<HTMLSelectElement>("gm-inp-maker-format")?.value || "gif";

  const jobId = "make_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole("Compiling sequence: " + pattern, "info");
  const resp = await PH.callService("CreateGifFromImages", {
    job_id: jobId,
    image_pattern: pattern,
    frame_rate: fps,
    output_path: tempPath,
    width: null,
    height: null,
    loop_count: loop,
    target_format: format,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Compiled sequence", tempPath);
  }
}

export async function compileMakerVideo(): Promise<void> {
  if (!state.currentMedia) {
    logConsole("Error: No video loaded.", "error");
    return;
  }

  const keepNativeFps = el<HTMLInputElement>("gm-chk-native-fps")?.checked || false;
  const fps = keepNativeFps ? null : parseInt(el<HTMLInputElement>("gm-inp-fps")?.value || "15");
  const loop = parseInt(el<HTMLInputElement>("gm-inp-loop")?.value || "0");
  const format = el<HTMLSelectElement>("gm-inp-maker-format")?.value || "gif";

  const jobId = "maker_vid_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole(`Compiling video to ${format.toUpperCase()}...`, "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    trim_start: null,
    trim_end: null,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Compiled video", tempPath);
  }
}

export async function handleTrimVideo(): Promise<void> {
  if (!state.currentMedia) return;
  const start = parseFloat(el<HTMLInputElement>("gm-inp-trim-start")?.value || "0");
  const end = parseFloat(el<HTMLInputElement>("gm-inp-trim-end")?.value || "10");
  const fps = parseInt(el<HTMLInputElement>("gm-inp-trim-fps")?.value || "10");
  const format = el<HTMLSelectElement>("gm-inp-trim-format")?.value || "gif";

  const jobId = "trim_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  logConsole(`Trimming video to ${format.toUpperCase()}...`, "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    trim_end: end > 0 ? end : null,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Trimmed & converted video", tempPath);
  }
}

export async function handleApplyCrop(): Promise<void> {
  if (!state.currentMedia) return;

  const container = el("gm-overlay-interactive");
  if (!container || state.currentMedia.width === 0) return;

  const containerWidth = container.clientWidth || 1;
  const containerHeight = container.clientHeight || 1;

  const scaleX = state.currentMedia.width / containerWidth;
  const scaleY = state.currentMedia.height / containerHeight;

  const xVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-x")?.value || "0");
  const yVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-y")?.value || "0");
  const wVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-w")?.value || "100");
  const hVal = parseFloat(el<HTMLInputElement>("gm-inp-crop-h")?.value || "100");

  const x = Math.round(xVal * scaleX);
  const y = Math.round(yVal * scaleY);
  const w = Math.round(wVal * scaleX);
  const h = Math.round(hVal * scaleY);

  const jobId = "crop_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying crop filter...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_path: tempPath,
    crop: `${w}:${h}:${x}:${y}`,
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
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, `Cropped canvas to ${w}x${h}`, tempPath);
  }
}

export async function handleApplyCaption(): Promise<void> {
  if (!state.currentMedia) return;
  const txt = el<HTMLTextAreaElement>("gm-inp-caption-text")?.value || "";
  const captionStyle = el<HTMLSelectElement>("gm-inp-caption-style")?.value || "ifunny";

  if (!txt.trim()) {
    logConsole("Warning: No caption text inputted.", "error");
    return;
  }

  const sizeInp = el<HTMLInputElement>("gm-inp-caption-size-num");
  const sizeVal = sizeInp ? parseInt(sizeInp.value) : 28;

  const displayW = el("gm-composition-wrapper")?.clientWidth || 400;
  const originalW = state.currentMedia.width || 400;
  const scale = displayW > 0 ? originalW / displayW : 1;
  const originalFontSize = Math.round(sizeVal * scale);

  const built = buildCaptionCanvas(txt, originalW, captionStyle, originalFontSize);
  const base64Png = built.canvas.toDataURL("image/png");
  const originalCaptionHeight = built.captionH;

  const jobId = "caption_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Rendering text caption from Canvas PNG...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    caption_style: captionStyle,
    max_colors: null,
    dither_type: null,
    drop_frames_factor: null,
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, `Applied ${captionStyle} caption`, tempPath);
  }
}

export async function handleApplyEffects(): Promise<void> {
  if (!state.currentMedia) return;
  const speed = parseFloat(el<HTMLInputElement>("gm-inp-speed")?.value || "1.0");
  const rotate = el<HTMLSelectElement>("gm-inp-rotate")?.value || null;
  const reverse = el<HTMLInputElement>("gm-inp-reverse")?.checked || false;
  const bounce = el<HTMLInputElement>("gm-inp-bounce")?.checked || false;
  const grayscale = el<HTMLInputElement>("gm-inp-grayscale")?.checked || false;
  const invert = el<HTMLInputElement>("gm-inp-invert")?.checked || false;

  const jobId = "effects_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying layout and speed transformations...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Applied effects & speed adjustment", tempPath);
  }
}

export async function handleApplyOptimize(): Promise<void> {
  if (!state.currentMedia) return;
  const colors = parseInt(el<HTMLSelectElement>("gm-inp-colors")?.value || "256");
  const dither = el<HTMLSelectElement>("gm-inp-dither")?.value || "floyd_steinberg";
  const dropFrames = parseInt(el<HTMLSelectElement>("gm-inp-drop-frames")?.value || "1");

  const jobId = "optimize_" + Date.now();
  const ext = state.currentMedia.path.split(".").pop()!;
  const tempPath = await getTempOutputPath(ext);

  logConsole("Applying dither/colors reduction...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    target_format: ext,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Optimized color reduction", tempPath);
  }
}

export async function handleSplitGif(): Promise<void> {
  if (!state.currentMedia) return;
  const dirInput = el<HTMLInputElement>("gm-inp-split-dir");
  let outDir = dirInput ? dirInput.value.trim() : "";
  if (!outDir) {
    outDir = state.currentMedia.path.replace(/[\/\\][^\/\\]+$/, "") || ".";
  }
  const jobId = "split_" + Date.now();
  logConsole("Extracting frames to folder: " + outDir, "info");

  const resp = await PH.callService("SplitGif", {
    job_id: jobId,
    input_path: state.currentMedia.path,
    output_dir: outDir,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Split frames to directory", outDir);
  }
}

export async function handleExportResize(): Promise<void> {
  if (!state.currentMedia) return;
  const w = parseInt(el<HTMLInputElement>("gm-inp-resize-w")?.value || "");
  const h = parseInt(el<HTMLInputElement>("gm-inp-resize-h")?.value || "");
  const format = el<HTMLSelectElement>("gm-inp-export-format")?.value || "gif";

  const jobId = "export_" + Date.now();
  const tempPath = await getTempOutputPath(format);

  const scaleStr = w && h ? w + ":" + h : null;

  logConsole("Compiling export dimensions scaling...", "info");
  const resp = await PH.callService("ProcessGifEffects", {
    job_id: jobId,
    input_path: state.currentMedia.path,
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
    target_format: format,
  });

  if (resp && resp.Error) {
    logConsole("Error: " + resp.Error.message, "error");
  } else {
    pollCompilationProgress(jobId, "Resized & converted export file", tempPath);
  }
}

export async function handleSaveFinal(): Promise<void> {
  if (state.historyIndex < 0 || state.historyIndex >= state.history.length) return;
  const activeState = state.history[state.historyIndex];

  const srcName = activeState.path.split(/[\\/]/).pop() || "output";
  const ext = srcName.split(".").pop()?.toLowerCase() || "gif";
  const baseName = srcName.substring(0, srcName.lastIndexOf(".")) || srcName;
  const suggestedName = baseName + "." + ext;

  const extMap: Record<string, string[]> = {
    gif: ["gif"],
    mp4: ["mp4"],
    webm: ["webm"],
    webp: ["webp"],
    png: ["png"],
    jpg: ["jpg", "jpeg"],
    jpeg: ["jpg", "jpeg"],
  };
  const filterExts = extMap[ext] || [ext];
  const filterName = ext.toUpperCase() + " File";

  const finalDest = await PH.dialogs.saveFile({ suggestedName, filterName, extensions: filterExts });

  if (!finalDest) return;

  logConsole("Saving final compiled media to disk...", "info");
  const resp = await PH.callService("PathExists", { path: activeState.path });
  if (resp && resp.PathExistsResult && resp.PathExistsResult.exists) {
    const copyResp = await PH.callService("EphemeralConvertImages", {
      conversions: [[activeState.path, finalDest]],
      quality: 100,
    });
    if (
      copyResp &&
      copyResp.ConvertImagesResult &&
      copyResp.ConvertImagesResult.converted.length > 0
    ) {
      const fileInfo = copyResp.ConvertImagesResult.converted[0];
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

export function pollCompilationProgress(
  jobId: string,
  description: string,
  filePath: string,
): void {
  const bar = el("gm-progress-bar");
  const text = el("gm-progress-text");
  const startTime = Date.now();

  state.activeJobId = jobId;

  pollTranscodeProgress({
    jobId,
    onTick: (progress) => {
      const pct = progress.percent;
      if (bar) bar.style.width = pct + "%";
      if (text) text.textContent = pct + "%";
    },
    onComplete: (ok, lastProgress) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      state.activeJobId = null;

      if (!ok) {
        logConsole(`Job Failed (took ${elapsed}s)`, "error");
        if (bar) bar.style.width = "0%";
        if (text) text.textContent = "0%";
        return;
      }

      logConsole(`Compilation completed successfully! (took ${elapsed}s)`, "success");
      if (bar) bar.style.width = "100%";
      if (text) text.textContent = "100%";

      const finalPath = (lastProgress?.raw?.output_path as string) || filePath;
      if (finalPath.endsWith("_frames") || jobId.startsWith("split_")) {
        logConsole(`Frames generated inside folder ${finalPath}`, "success");
      } else {
        void pushHistoryState(finalPath, description);
      }
    },
  });
}
