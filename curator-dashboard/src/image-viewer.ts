import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { maskPath } from "./components";
import { logJS } from "./utils";
import { getImageClickAction } from "./state";
import { callService } from "./ipc";
import { buildVerticalSpans, estimateLabelWidth, fitLabelInBox, getOcrTextSettings, isVerticalBox, placeLabelAvoidingOverlap, type PlacedLabel } from "./ocr-text";
import { showErrorAlert } from "./alert";

let currentViewerPath: string | null = null;
let currentViewerImageId: number | null = null;
let detectionsVisible = false;
let ocrVisible = false;

const IDENTITY_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#34495e", "#e91e63", "#00bcd4",
];

function isVideoPath(p: string): boolean {
  return /\.(mp4|webm)$/i.test(p);
}

export function openImageViewer(filepath: string, _imageId?: number) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement;
  const video = document.getElementById("image-viewer-video") as HTMLVideoElement;
  const title = document.getElementById("image-viewer-filename");
  const overlay = document.getElementById("image-viewer-detections-overlay");
  const ocrOverlay = document.getElementById("image-viewer-ocr-overlay");

  if (!modal || !title) return;

  currentViewerPath = filepath;
  currentViewerImageId = _imageId ?? null;
  title.textContent = maskPath(filepath);

  const isVideo = isVideoPath(filepath);
  if (img) img.style.display = isVideo ? "none" : "";
  if (video) {
    if (isVideo) {
      video.src = convertFileSrc(filepath);
      video.style.display = "";
      void video.play().catch(() => {});
    } else {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.style.display = "none";
    }
  }
  if (img && !isVideo) img.src = convertFileSrc(filepath);
  modal.classList.add("active");

  // Reset detections
  detectionsVisible = false;
  ocrVisible = false;
  if (overlay) overlay.style.display = "none";
  if (ocrOverlay) ocrOverlay.style.display = "none";
  updateDetectionButton(false);
  updateOcrButton(false);
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement | null;
  const video = document.getElementById("image-viewer-video") as HTMLVideoElement | null;
  if (img) { img.src = ""; img.style.display = ""; }
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); video.style.display = "none"; }
  if (modal) modal.classList.remove("active");
  currentViewerPath = null;
  currentViewerImageId = null;
  detectionsVisible = false;
  ocrVisible = false;
}

function updateDetectionButton(active: boolean) {
  const btn = document.getElementById("image-viewer-toggle-detections");
  if (!btn) return;
  btn.classList.toggle("active", active);
}

function updateOcrButton(active: boolean) {
  const btn = document.getElementById("image-viewer-toggle-ocr");
  if (!btn) return;
  btn.classList.toggle("active", active);
}

function currentViewerIsVideo(): boolean {
  return currentViewerPath ? isVideoPath(currentViewerPath) : false;
}

async function toggleOcr() {
  if (!currentViewerImageId) return;
  if (currentViewerIsVideo()) return;

  const ocrOverlay = document.getElementById("image-viewer-ocr-overlay");
  if (!ocrOverlay) return;

  if (ocrVisible) {
    ocrVisible = false;
    ocrOverlay.style.display = "none";
    updateOcrButton(false);
    return;
  }

  try {
    // 1. Get existing OCR detections
    let resp = await callService({ GetOcrDetections: { image_id: currentViewerImageId } });
    let detections = ("OcrDetectionsResult" in resp) ? resp.OcrDetectionsResult.detections : [];
    let bubbleBoxes = ("OcrDetectionsResult" in resp) ? (resp.OcrDetectionsResult as any).bubble_boxes ?? [] : [];

    // 2. If none exist in database, run OCR process on-demand
    if (detections.length === 0) {
      const waitBtn = document.getElementById("image-viewer-toggle-ocr");
      if (waitBtn) waitBtn.textContent = "OCR Processing...";
      resp = await callService({ RunOcr: { image_id: currentViewerImageId } });
      if (waitBtn) waitBtn.innerHTML = '<i class="bi bi-fonts"></i> OCR Text';
      detections = ("OcrDetectionsResult" in resp) ? resp.OcrDetectionsResult.detections : [];
      bubbleBoxes = ("OcrDetectionsResult" in resp) ? (resp.OcrDetectionsResult as any).bubble_boxes ?? [] : [];
      // Update card OCR text directly
      const ocrText = detections.map((d: any) => d.text).join("\n");
      import("./cards").then(m => m.refreshCardOcr(currentViewerImageId!, ocrText));
    }

    if (detections.length === 0) return;

    const img = document.getElementById("image-viewer-img") as HTMLImageElement;
    if (!img.naturalWidth) return;

    const scaleX = img.clientWidth / img.naturalWidth;
    const scaleY = img.clientHeight / img.naturalHeight;

    ocrOverlay.style.left = `${img.offsetLeft}px`;
    ocrOverlay.style.top = `${img.offsetTop}px`;
    ocrOverlay.style.width = `${img.clientWidth}px`;
    ocrOverlay.style.height = `${img.clientHeight}px`;

    ocrOverlay.innerHTML = "";
    ocrOverlay.setAttribute("viewBox", `0 0 ${img.clientWidth} ${img.clientHeight}`);

    // Draw top-to-bottom so overlap resolution pushes text into unclaimed space
    const sortedDetections = [...detections].sort(
      (a: any, b: any) =>
        (Math.min(a.y0, a.y1, a.y2, a.y3) - Math.min(b.y0, b.y1, b.y2, b.y3)) ||
        (Math.min(a.x0, a.x1, a.x2, a.x3) - Math.min(b.x0, b.x1, b.x2, b.x3)),
    );

    // Collect per-detection polygon geometry so all boxes can be drawn first
    // and all text labels afterwards (keeping text on top of the boxes).
    const boxGeom: { det: any; points: number[][]; minX: number; minY: number; maxX: number; maxY: number }[] = [];
    for (const det of sortedDetections) {
      const points = [
        [det.x0 * scaleX, det.y0 * scaleY],
        [det.x1 * scaleX, det.y1 * scaleY],
        [det.x2 * scaleX, det.y2 * scaleY],
        [det.x3 * scaleX, det.y3 * scaleY],
      ];
      boxGeom.push({
        det,
        points,
        minX: Math.min(points[0][0], points[1][0], points[2][0], points[3][0]),
        minY: Math.min(points[0][1], points[1][1], points[2][1], points[3][1]),
        maxX: Math.max(points[0][0], points[1][0], points[2][0], points[3][0]),
        maxY: Math.max(points[0][1], points[1][1], points[2][1], points[3][1]),
      });
    }

    // Pass 1: draw polygon boxes
    for (const { det, points } of boxGeom) {
      const polyPath = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      const ptsAttr = points.map(pt => `${pt[0]},${pt[1]}`).join(" ");
      polyPath.setAttribute("points", ptsAttr);
      if (det.is_from_bubble) {
        polyPath.setAttribute("fill", "rgba(155, 89, 182, 0.15)");
        polyPath.setAttribute("stroke", "#9b59b6");
      } else {
        polyPath.setAttribute("fill", "rgba(52, 152, 219, 0.15)");
        polyPath.setAttribute("stroke", "#3498db");
      }
      polyPath.setAttribute("stroke-width", "2");
      ocrOverlay.appendChild(polyPath);
    }

    // Draw YOLO bubble detection boxes as dashed green rectangles
    for (const bub of bubbleBoxes) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(bub.x1 * scaleX));
      rect.setAttribute("y", String(bub.y1 * scaleY));
      rect.setAttribute("width", String((bub.x2 - bub.x1) * scaleX));
      rect.setAttribute("height", String((bub.y2 - bub.y1) * scaleY));
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", "#2ecc71");
      rect.setAttribute("stroke-width", "2");
      rect.setAttribute("stroke-dasharray", "6,3");
      rect.setAttribute("stroke-opacity", "0.8");
      ocrOverlay.appendChild(rect);
    }

    // Pass 2: draw text labels on top, shifting each below any previous label
    // so overlapping boxes don't stack text on top of one another. In fit-in-box
    // mode the label is instead scaled and centered inside its own detection box;
    // vertical boxes render as a top-to-bottom character column when enabled.
    const { fontSize, strokeWidth, fontFamily, fitInBox, verticalText } = getOcrTextSettings();
    const pad = Math.max(1, Math.ceil(strokeWidth / 2));
    const placedLabels: PlacedLabel[] = [];
    for (const { det, points, minX, minY, maxX, maxY } of boxGeom) {
      const boxW = maxX - minX;
      const boxH = maxY - minY;
      const boxVertical = isVerticalBox(points);
      const vertical = verticalText && boxVertical;
      // A vertical box without vertical stacking should not be fit-scaled: the
      // horizontal label would collapse into a sliver, so render it with the
      // normal overlap-avoidance placement instead.
      const fitEffective = fitInBox && !(boxVertical && !verticalText);
      let fs = fontSize;
      let pos: { x: number; y: number };
      let letterSpacing = 0;
      let verticalSpacing = 0;
      if (vertical && fitInBox) {
        const fit = fitLabelInBox(det.text as string, boxW, boxH, pad, true, fontFamily);
        fs = fit.fontSize;
        pos = { x: minX + fit.x, y: minY + fit.y };
        verticalSpacing = fit.spacing;
        const final = placeLabelAvoidingOverlap(pos.x, pos.y, fit.w, fit.h, placedLabels, 3, {
          w: img.clientWidth,
          h: img.clientHeight,
        });
        pos = { x: final.x, y: final.y };
        placedLabels.push({ x: pos.x, y: pos.y, w: fit.w, h: fit.h });
      } else if (vertical) {
        const chars = Array.from(det.text as string);
        const count = Math.max(chars.length, 1);
        const labelW = chars.length
          ? Math.max(...chars.map(ch => estimateLabelWidth(ch as string, fs)))
          : fs * 0.6;
        const labelH = fs * count;
        pos = placeLabelAvoidingOverlap(minX + 4, minY + 4, labelW, labelH, placedLabels, 3, {
          w: img.clientWidth,
          h: img.clientHeight,
        });
        placedLabels.push({ x: pos.x, y: pos.y, w: labelW, h: labelH });
      } else if (fitEffective) {
        const fit = fitLabelInBox(det.text as string, boxW, boxH, pad, false, fontFamily);
        fs = fit.fontSize;
        pos = { x: minX + fit.x, y: minY + fit.y };
        letterSpacing = fit.spacing;
        const final = placeLabelAvoidingOverlap(pos.x, pos.y, fit.w, fit.h, placedLabels, 3, {
          w: img.clientWidth,
          h: img.clientHeight,
        });
        pos = { x: final.x, y: final.y };
        placedLabels.push({ x: pos.x, y: pos.y, w: fit.w, h: fit.h });
      } else {
        const labelW = estimateLabelWidth(det.text, fs);
        const labelH = fs + 4;
        pos = placeLabelAvoidingOverlap(minX + 4, minY + 4, labelW, labelH, placedLabels, 3, {
          w: img.clientWidth,
          h: img.clientHeight,
        });
        placedLabels.push({ x: pos.x, y: pos.y, w: labelW, h: labelH });
      }

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("fill", "#ffffff");
      label.style.fontSize = `${fs}px`;
      label.setAttribute("font-size", String(fs));
      label.style.fontFamily = `${fontFamily}, sans-serif`;
      if (letterSpacing > 0) label.style.letterSpacing = `${letterSpacing}px`;
      label.setAttribute("font-weight", "600");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke", "rgba(0,0,0,0.8)");
      label.setAttribute("stroke-width", String(strokeWidth));
      label.setAttribute("stroke-linecap", "round");
      label.setAttribute("stroke-linejoin", "round");
      if (vertical) {
        label.setAttribute("x", "0");
        label.setAttribute("y", "0");
        label.innerHTML = buildVerticalSpans(det.text, pos.x, pos.y + fs, fs, verticalSpacing);
      } else {
        label.setAttribute("x", String(pos.x));
        label.setAttribute("y", String(pos.y + fs));
        label.textContent = det.text;
      }
      ocrOverlay.appendChild(label);
    }

    ocrVisible = true;
    ocrOverlay.style.display = "block";
    updateOcrButton(true);

  } catch (e: any) {
    console.error("Failed to load OCR detections:", e);
  }
}

async function toggleDetections() {
  if (!currentViewerImageId) return;
  if (currentViewerIsVideo()) return;

  const overlay = document.getElementById("image-viewer-detections-overlay");
  if (!overlay) return;

  if (detectionsVisible) {
    detectionsVisible = false;
    overlay.style.display = "none";
    updateDetectionButton(false);
    return;
  }

  // Load detections
  try {
    const resp = await callService({ GetCharacterDetections: { image_id: currentViewerImageId } });
    if (!("CharacterDetectionsResult" in resp)) return;
    const detections = resp.CharacterDetectionsResult.detections;
    if (detections.length === 0) return;

    // Load identities for labels
    const idResp = await callService({ ListCharacterIdentities: null });
    const identities: any[] = "CharacterIdentitiesList" in idResp ? idResp.CharacterIdentitiesList.identities : [];

    // Wait for image to get natural dimensions
    const img = document.getElementById("image-viewer-img") as HTMLImageElement;
    if (!img.naturalWidth) return;

    const scaleX = img.clientWidth / img.naturalWidth;
    const scaleY = img.clientHeight / img.naturalHeight;

    // Reposition and resize the SVG element to match the image dimensions exactly
    overlay.style.left = `${img.offsetLeft}px`;
    overlay.style.top = `${img.offsetTop}px`;
    overlay.style.width = `${img.clientWidth}px`;
    overlay.style.height = `${img.clientHeight}px`;

    overlay.innerHTML = "";
    overlay.setAttribute("viewBox", `0 0 ${img.clientWidth} ${img.clientHeight}`);

    for (const det of detections) {
      const color = det.identity_id !== null
        ? IDENTITY_COLORS[(det.identity_id - 1) % IDENTITY_COLORS.length]
        : "#888";
      const identityName = det.identity_id !== null
        ? (identities.find((i: any) => i.id === det.identity_id)?.name || `#${det.identity_id}`)
        : "Unknown";

      const x = det.x0 * scaleX;
      const y = det.y0 * scaleY;
      const w = (det.x1 - det.x0) * scaleX;
      const h = (det.y1 - det.y0) * scaleY;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(h));
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", "2");
      overlay.appendChild(rect);

      // Label background
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(x + 4));
      label.setAttribute("y", String(y + 14));
      label.setAttribute("fill", color);
      label.setAttribute("font-size", "12");
      label.setAttribute("font-weight", "600");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke", "rgba(0,0,0,0.7)");
      label.setAttribute("stroke-width", "3");
      label.setAttribute("stroke-linecap", "round");
      label.setAttribute("stroke-linejoin", "round");
      label.textContent = identityName;
      overlay.appendChild(label);
    }

    detectionsVisible = true;
    overlay.style.display = "block";
    updateDetectionButton(true);
  } catch (e: any) {
    console.error("Failed to load detections for viewer:", e);
  }
}

export function setupImageViewer() {
  document.getElementById("image-viewer-close")?.addEventListener("click", closeImageViewer);

  document.getElementById("image-viewer-modal")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("button") && !target.closest(".image-viewer-close") && target.tagName !== "IMG" && target.tagName !== "VIDEO") {
      closeImageViewer();
    }
  });

  document.getElementById("image-viewer-open-external")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (currentViewerPath) {
      logJS("Open external clicked for: " + currentViewerPath);
      try {
        await invoke("open_file_externally", { path: currentViewerPath });
      } catch (err: any) {
        logJS("open_file_externally error: " + (err?.message || String(err)));
        showErrorAlert("Failed to open file:\n" + (err?.message || err));
      }
    }
  });

  document.getElementById("image-viewer-toggle-detections")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetections();
  });

  document.getElementById("image-viewer-toggle-ocr")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleOcr();
  });

  document.getElementById("image-viewer-rerun-ocr")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentViewerImageId) return;
    const btn = document.getElementById("image-viewer-rerun-ocr");
    try {
      if (btn) btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Running...';
      const resp = await callService({ RunOcr: { image_id: currentViewerImageId } });
      const detections = ("OcrDetectionsResult" in resp) ? resp.OcrDetectionsResult.detections : [];
      // Re-fetch from DB so the viewer shows stored data
      ocrVisible = false;
      if (detections.length > 0) {
        toggleOcr();
      } else {
        const overlay = document.getElementById("image-viewer-ocr-overlay");
        if (overlay) { overlay.innerHTML = ""; overlay.style.display = "none"; }
        ocrVisible = false;
        updateOcrButton(false);
      }
      // Update card OCR text directly
      const ocrText = detections.map((d: any) => d.text).join("\n");
      import("./cards").then(m => m.refreshCardOcr(currentViewerImageId!, ocrText));
    } catch (err) {
      console.error("Re-run OCR failed:", err);
    } finally {
      if (btn) btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Re-run OCR';
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageViewer();
  });
}

// Re-export for use by other modules
export { getImageClickAction };
