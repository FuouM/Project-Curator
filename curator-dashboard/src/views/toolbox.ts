import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { typedCall } from "../ipc";
import { tagSummaryFromProto } from "../proto-adapters";
import { EphemeralTagImageRequestSchema, EphemeralTagResultSchema } from "../gen/tagging_pb";
import { EphemeralRunOcrRequestSchema, EphemeralOcrResultSchema } from "../gen/ocr_pb";
import { EphemeralDetectCharactersRequestSchema, EphemeralDetectionResultSchema, CharacterIdentitiesListSchema } from "../gen/characters_pb";
import { EphemeralClassifySafetyRequestSchema, EphemeralClassifySafetyResultSchema } from "../gen/import_pb";
import { TaggerModel } from "../gen/common_pb";
import type { EphemeralOcrDetection, StoredDetection, BubbleBoxResult } from "../gen/common_pb";
import { maskPath, renderTagPill, SafeHtml, html, type TagSummary } from "../components";
import { navigateToView } from "./navigation";
import { buildOcrLabelSvg } from "../ocr-text";
import { logJS, setStatusMessage, escapeHtml } from "../utils";
import { formatCopiedTags } from "../state";
import { nsfwScore } from "../proto-adapters";
import { loadNsfwPrefs } from "../nsfw";

const IDENTITY_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#34495e", "#e91e63", "#00bcd4",
];

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|avif|tiff?|jxl)$/i;

function firstImagePath(paths: string[]): string | null {
  return paths.find((p) => IMAGE_EXT_RE.test(p)) || paths[0] || null;
}

interface ToolboxOcrDetection {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  is_from_bubble: boolean;
}

interface ToolboxStoredDetection {
  id: number;
  image_id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  has_embedding: boolean;
  identity_id: number | null;
}

function ocrDetectionFromProto(d: EphemeralOcrDetection): ToolboxOcrDetection {
  return {
    text: d.text,
    confidence: d.confidence,
    x0: d.x0,
    y0: d.y0,
    x1: d.x1,
    y1: d.y1,
    x2: d.x2,
    y2: d.y2,
    x3: d.x3,
    y3: d.y3,
    is_from_bubble: d.isFromBubble,
  };
}

function detectionFromProto(d: StoredDetection): ToolboxStoredDetection {
  return {
    id: Number(d.id),
    image_id: Number(d.imageId),
    x0: d.x0,
    y0: d.y0,
    x1: d.x1,
    y1: d.y1,
    confidence: d.confidence,
    has_embedding: d.hasEmbedding,
    identity_id: d.identityId === undefined ? null : Number(d.identityId),
  };
}

let currentPath: string | null = null;
let currentOcr: ToolboxOcrDetection[] = [];
let currentBubbles: BubbleBoxResult[] = [];
let currentDetections: ToolboxStoredDetection[] = [];
let identityNames: Map<number, string> = new Map();

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function resetResults() {
  currentOcr = [];
  currentBubbles = [];
  currentDetections = [];
  identityNames = new Map();
  const ocrList = el("toolbox-ocr-list");
  const detList = el("toolbox-detect-list");
  const tagList = el("toolbox-tag-list");
  const safetyResult = el("toolbox-safety-result");
  if (ocrList) ocrList.innerHTML = "";
  if (detList) detList.innerHTML = "";
  if (tagList) tagList.innerHTML = "";
  if (safetyResult) safetyResult.innerHTML = "";
  hideSafetySummary();
  const ocrOverlay = el("toolbox-overlay-ocr");
  const detOverlay = el("toolbox-overlay-detect");
  if (ocrOverlay) { ocrOverlay.innerHTML = ""; ocrOverlay.style.display = "none"; }
  if (detOverlay) { detOverlay.innerHTML = ""; detOverlay.style.display = "none"; }
}

function svgInner(svg: string): string {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  return m ? m[1] : "";
}

let previewW = 0;
let previewH = 0;

function loadImage(path: string) {
  currentPath = path;
  resetResults();

  const group = el("toolbox-preview-group");
  const filename = el("toolbox-preview-filename");
  const sourceStatus = el("toolbox-source-status");

  if (!group || !filename) return;

  filename.textContent = maskPath(path);
  filename.title = path;

  const probe = new Image();
  probe.onload = () => {
    previewW = probe.naturalWidth;
    previewH = probe.naturalHeight;
    const svg = el("toolbox-preview-svg");
    const img = document.getElementById("toolbox-preview-img") as unknown as SVGImageElement;
    if (svg && img) {
      svg.setAttribute("viewBox", `0 0 ${previewW} ${previewH}`);
      img.setAttribute("href", convertFileSrc(path));
      img.setAttribute("width", `${previewW}`);
      img.setAttribute("height", `${previewH}`);
    }
    group.style.display = "";
    const dropZone = el("toolbox-drop-zone");
    if (dropZone) dropZone.style.display = "none";
    if (sourceStatus) setStatusMessage(sourceStatus, "Image loaded.", "success");
  };
  probe.onerror = () => {
    previewW = 0;
    previewH = 0;
    group.style.display = "none";
    currentPath = null;
    const dropZone = el("toolbox-drop-zone");
    if (dropZone) dropZone.style.display = "";
    if (sourceStatus) setStatusMessage(sourceStatus, "Could not load image from that path.", "error");
  };
  probe.src = convertFileSrc(path);
}

function requirePath(): boolean {
  const sourceStatus = el("toolbox-source-status");
  if (!currentPath) {
    if (sourceStatus) setStatusMessage(sourceStatus, "Load an image first.", "error");
    return false;
  }
  return true;
}

/// Load an image file into the toolbox by path and switch to the toolbox view.
/// Used by external surfaces (e.g. the Image Details modal) to hand an asset
/// over to the toolbox without touching the library.
export function openToolboxWithImage(path: string) {
  const input = el<HTMLInputElement>("toolbox-image-path-input");
  if (input) {
    input.value = path;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  loadImage(path);
  navigateToView("toolbox");
}

// ── Reverse Image Search (jump to General Search) ─────────────────────

function runReverseSearch() {
  if (!requirePath()) return;
  const status = el("toolbox-reverse-status");
  if (status) setStatusMessage(status, "Opening General Search with this image...", "loading");

  navigateToView("search");
  setTimeout(() => {
    const imageInput = el<HTMLInputElement>("search-image-path-input");
    if (imageInput) {
      imageInput.value = currentPath || "";
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    document.getElementById("search-form")?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  }, 80);
}

// ── Auto-Tagging ──────────────────────────────────────────────────────

async function runTagging() {
  if (!requirePath()) return;

  const btn = el<HTMLButtonElement>("toolbox-tag-btn");
  const status = el("toolbox-tag-status");
  const tagList = el("toolbox-tag-list");
  const copyBtn = el<HTMLButtonElement>("toolbox-copy-tags-btn");
  if (!status || !tagList) return;

  const thresholdSelect = el<HTMLSelectElement>("toolbox-tagger-threshold-select");
  const threshold = thresholdSelect ? parseFloat(thresholdSelect.value) : 0.5;

  const taggerSelect = el<HTMLSelectElement>("toolbox-tagger-select");
  const tagger = taggerSelect ? (taggerSelect.value || null) : null;
  const taggerEnum = tagger === "camie" ? TaggerModel.CAMIE : tagger === "wd-eva02" ? TaggerModel.WD_EVA02 : undefined;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin"></i> Tagging...';
  }
  const taggerName = tagger === "wd-eva02" ? "WD EVA02 Tagger" : "Camie Tagger";
  setStatusMessage(status, `Running ${taggerName}...`, "loading");

  try {
    const resp = await typedCall("TaggingService.EphemeralTagImage", EphemeralTagImageRequestSchema, {
      path: currentPath as string,
      threshold,
      tagger: taggerEnum,
    }, EphemeralTagResultSchema);
    const tags: TagSummary[] = resp.tags.map(tagSummaryFromProto);
    if (tags.length === 0) {
      tagList.innerHTML = "";
      setStatusMessage(status, "No tags above the selected threshold.", "success");
    } else {
      tagList.innerHTML = tags.map((t) => renderTagPill(t)).join("");
      setStatusMessage(status, `${tags.length} tags predicted.`, "success");
    }
    if (copyBtn) copyBtn.style.display = tags.length > 0 ? "" : "none";
  } catch (e: any) {
    logJS("toolbox tagging error: " + (e?.message || e));
    setStatusMessage(status, `IPC error: ${e?.message || e}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-stars"></i> Tag Image';
    }
  }
}

async function copyTags() {
  const tagList = el("toolbox-tag-list");
  const status = el("toolbox-tag-status");
  if (!tagList || !status) return;
  const text = formatCopiedTags(
    Array.from(tagList.querySelectorAll(".tag-pill"))
      .map((p) => p.childNodes[0]?.textContent?.replace(/\u200B/g, "") || "")
      .filter(Boolean)
      .join(", ")
  );
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatusMessage(status, "Tags copied to clipboard.", "success");
  } catch (e: any) {
    setStatusMessage(status, `Copy failed: ${e?.message || e}`, "error");
  }
}

// ── OCR ───────────────────────────────────────────────────────────────

function renderOcrOverlay() {
  const g = el("toolbox-overlay-ocr");
  const toggle = el<HTMLInputElement>("toolbox-ocr-overlay-toggle");
  if (!g) return;
  g.innerHTML = "";
  g.style.display = "none";
  if (!toggle?.checked) return;
  if (!previewW || !previewH) return;

  const boxes = currentOcr.map((d) => ({
    pts: [[d.x0, d.y0], [d.x1, d.y1], [d.x2, d.y2], [d.x3, d.y3]],
    text: d.text,
    color: d.is_from_bubble ? "#9b59b6" : "#3498db",
    fill: d.is_from_bubble ? "rgba(155, 89, 182, 0.15)" : "rgba(52, 152, 219, 0.15)",
  }));

  let svg = buildOcrLabelSvg(boxes, previewW, previewH).replace("background:#c8c8c8;", "");
  for (const bub of currentBubbles) {
    const rect =
      `<rect x="${bub.x1}" y="${bub.y1}" width="${(bub.x2 - bub.x1).toFixed(1)}" ` +
      `height="${(bub.y2 - bub.y1).toFixed(1)}" fill="none" stroke="#2ecc71" ` +
      `stroke-width="2" stroke-dasharray="6,3" stroke-opacity="0.8"/>`;
    svg = svg.replace("</svg>", rect + "</svg>");
  }
  g.innerHTML = svgInner(svg);
  g.style.display = "";
}

async function runOcr() {
  if (!requirePath()) return;

  const btn = el<HTMLButtonElement>("toolbox-ocr-btn");
  const status = el("toolbox-ocr-status");
  const ocrList = el("toolbox-ocr-list");
  if (!status || !ocrList) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin"></i> Running...';
  }
  setStatusMessage(status, "Detecting and recognizing text...", "loading");

  try {
    const resp = await typedCall("OcrService.EphemeralRunOcr", EphemeralRunOcrRequestSchema, {
      path: currentPath as string,
    }, EphemeralOcrResultSchema);
    currentOcr = resp.detections.map(ocrDetectionFromProto);
    currentBubbles = resp.bubbleBoxes;

    if (currentOcr.length === 0) {
      ocrList.innerHTML = "<span style='color: #64748b; font-style: italic; font-size: 11px;'>No text detected.</span>";
      setStatusMessage(status, "No text detected.", "success");
    } else {
      ocrList.innerHTML = currentOcr
        .map((d, i) => {
          const badge = d.is_from_bubble
            ? '<span style="font-size: 10px; color: #9b59b6; margin-left: 6px;">[bubble]</span>'
            : "";
          return (
            `<div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; ` +
            `padding: 4px 6px; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px;">` +
            `<span style="font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(d.text)}">${escapeHtml(d.text)}${badge}</span>` +
            `<span style="font-size: 10px; color: #555555; white-space: nowrap;">${(d.confidence * 100).toFixed(1)}%</span>` +
            `<button type="button" class="toolbox-ocr-copy" data-index="${i}" title="Copy text"><i class="bi bi-clipboard"></i></button>` +
            `</div>`
          );
        })
        .join("");
      setStatusMessage(status, `${currentOcr.length} text block(s) detected.`, "success");
    }
    renderOcrOverlay();
  } catch (e: any) {
    logJS("toolbox OCR error: " + (e?.message || e));
    setStatusMessage(status, `IPC error: ${e?.message || e}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-fonts"></i> Run OCR';
    }
  }
}

// ── Character Detection ───────────────────────────────────────────────

function renderDetectionOverlay() {
  const g = el("toolbox-overlay-detect");
  const toggle = el<HTMLInputElement>("toolbox-detect-overlay-toggle");
  if (!g) return;
  g.innerHTML = "";
  g.style.display = "none";
  if (!toggle?.checked) return;
  if (!previewW || !previewH) return;

  const rects = currentDetections
    .map((d) => {
      const color = d.identity_id !== null
        ? IDENTITY_COLORS[((d.identity_id - 1) % IDENTITY_COLORS.length + IDENTITY_COLORS.length) % IDENTITY_COLORS.length]
        : "#888888";
      const name = d.identity_id !== null
        ? identityNames.get(d.identity_id) || `#${d.identity_id}`
        : "Unknown";
      const safeName = escapeHtml(name);
      const x = d.x0;
      const y = d.y0;
      const ww = d.x1 - d.x0;
      const hh = d.y1 - d.y0;
      return (
        `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" fill="none" stroke="${color}" stroke-width="2"/>` +
        `<text x="${x + 4}" y="${y + 14}" fill="${color}" font-size="12" font-weight="600" ` +
        `paint-order="stroke" stroke="rgba(0,0,0,0.7)" stroke-width="3" ` +
        `stroke-linecap="round" stroke-linejoin="round">${safeName}</text>`
      );
    })
    .join("");

  g.innerHTML = rects;
  g.style.display = "";
}

async function runDetection() {
  if (!requirePath()) return;

  const btn = el<HTMLButtonElement>("toolbox-detect-btn");
  const status = el("toolbox-detect-status");
  const detList = el("toolbox-detect-list");
  if (!status || !detList) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin"></i> Detecting...';
  }
  setStatusMessage(status, "Running YOLO + CCIP detection...", "loading");

  try {
    const [detResp, idResp] = await Promise.all([
      typedCall("CharactersService.EphemeralDetectCharacters", EphemeralDetectCharactersRequestSchema, {
        path: currentPath as string,
      }, EphemeralDetectionResultSchema),
      typedCall("CharactersService.ListCharacterIdentities", null, null, CharacterIdentitiesListSchema),
    ]);

    currentDetections = detResp.detections.map(detectionFromProto);
    identityNames = new Map();
    for (const ident of idResp.identities) {
      identityNames.set(Number(ident.id), ident.name);
    }

    if (currentDetections.length === 0) {
      detList.innerHTML = "<span style='color: #64748b; font-style: italic; font-size: 11px;'>No persons detected.</span>";
      setStatusMessage(status, "No persons detected.", "success");
    } else {
      detList.innerHTML = currentDetections
        .map((d) => {
          const color = d.identity_id !== null
            ? IDENTITY_COLORS[((d.identity_id - 1) % IDENTITY_COLORS.length + IDENTITY_COLORS.length) % IDENTITY_COLORS.length]
            : "#888888";
          const name = d.identity_id !== null
            ? identityNames.get(d.identity_id) || `#${d.identity_id}`
            : "Unknown";
          return (
            `<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; ` +
            `padding: 4px 6px; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px;">` +
            `<span style="font-size: 11px;"><span style="display:inline-block; width:10px; height:10px; background:${color}; margin-right:6px; border:1px solid #555;"></span>${escapeHtml(name)}</span>` +
            `<span style="font-size: 10px; color: #555555; white-space: nowrap;">${(d.confidence * 100).toFixed(1)}%</span>` +
            `</div>`
          );
        })
        .join("");
      setStatusMessage(status, `${currentDetections.length} character(s) detected.`, "success");
    }
    renderDetectionOverlay();
  } catch (e: any) {
    logJS("toolbox detection error: " + (e?.message || e));
    setStatusMessage(status, `IPC error: ${e?.message || e}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-bounding-box"></i> Detect Characters';
    }
  }
}

// ── Safety Classification ─────────────────────────────────────────────

/// Render the per-class NSFW probabilities in a two-column layout sized for the
/// narrow toolbox column: safe categories (Safe, Drawing) on the left, unsafe
/// categories (Hentai, Porn, Sexy) on the right. The NSFW/SFW totals live next
/// to the Classify button (see `setSafetySummary`) to save vertical space.
function renderSafetyHtml(s: { safe_score?: number; hentai_score?: number; porn_score?: number; sexy_score?: number; drawing_score?: number }): string {
  const threshold = loadNsfwPrefs().threshold;
  const bar = (label: string, icon: string, value: number): string => {
    const pct = Math.round(value * 1000) / 10;
    const danger = label !== "Safe" && label !== "Drawing" && value >= threshold;
    const safeHighlight = (label === "Safe" || label === "Drawing") && value >= threshold;
    const bg = danger ? "background:#f8d7da;" : safeHighlight ? "background:#d1e7dd;" : "";
    return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 6px;' + bg + '">' +
      '<i class="bi ' + icon + '" style="color:#666;width:14px;"></i>' +
      '<span style="width:52px;font-weight:600;">' + label + '</span>' +
      '<div class="prob-bar" style="flex:1;min-width:0;"><div style="height:100%;width:' + pct + '%;background:var(--sys-accent,#0078d7);"></div></div>' +
      '<span style="width:40px;text-align:right;color:#333;">' + pct + '%</span>' +
      '</div>';
  };
  const col = (rows: string): string =>
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:0;">' + rows + '</div>';
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
    col(bar("Safe", "bi-shield-check", s.safe_score ?? 0) + bar("Drawing", "bi-palette", s.drawing_score ?? 0)) +
    col(
      bar("Hentai", "bi-exclamation-triangle", s.hentai_score ?? 0) +
      bar("Porn", "bi-exclamation-triangle", s.porn_score ?? 0) +
      bar("Sexy", "bi-emoji-sunglasses", s.sexy_score ?? 0)
    ) +
    '</div>';
}

function setSafetySummary(ns: number, sf: number) {
  const summary = el("toolbox-safety-summary");
  if (!summary) return;
  summary.innerHTML =
    '<span style="color:#842029;">NSFW ' + (ns * 1000 / 10).toFixed(1) + '%</span>' +
    '<span style="color:#2e7d32;margin-left:10px;">SFW ' + (sf * 1000 / 10).toFixed(1) + '%</span>';
  summary.style.display = "inline-flex";
}

function hideSafetySummary() {
  const summary = el("toolbox-safety-summary");
  if (summary) summary.style.display = "none";
}

async function runSafety() {
  if (!requirePath()) return;

  const btn = el<HTMLButtonElement>("toolbox-safety-btn");
  const status = el("toolbox-safety-status");
  const resultBox = el("toolbox-safety-result");
  if (!status || !resultBox) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin"></i> Classifying...';
  }
  setStatusMessage(status, "Running NSFW classification...", "loading");

  try {
    const resp = await typedCall("ImportService.EphemeralClassifySafety", EphemeralClassifySafetyRequestSchema, {
      path: currentPath as string,
    }, EphemeralClassifySafetyResultSchema);
    const scores = {
      safe_score: resp.safeScore,
      hentai_score: resp.hentaiScore,
      porn_score: resp.pornScore,
      sexy_score: resp.sexyScore,
      drawing_score: resp.drawingScore,
    };
    resultBox.innerHTML = renderSafetyHtml(scores);
    setSafetySummary(nsfwScore(scores), (scores.safe_score ?? 0) + (scores.drawing_score ?? 0));
    setStatusMessage(status, "Classification complete.", "success");
  } catch (e: any) {
    logJS("toolbox safety error: " + (e?.message || e));
    resultBox.innerHTML = "";
    hideSafetySummary();
    setStatusMessage(status, `IPC error: ${e?.message || e}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-shield-check"></i> Classify Safety';
    }
  }
}

// ── Fullscreen Preview ────────────────────────────────────────────────

function openFullscreen() {
  if (!requirePath()) return;
  const overlay = el("toolbox-fullscreen-overlay");
  const src = el("toolbox-preview-svg");
  const target = el("toolbox-fullscreen-svg");
  if (!overlay || !src || !target) return;
  const clone = src.cloneNode(true) as Element;
  clone.removeAttribute("id");
  target.innerHTML = "";
  target.appendChild(clone);
  overlay.style.display = "flex";
}

let escapeKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function closeFullscreen() {
  const overlay = el("toolbox-fullscreen-overlay");
  if (overlay) overlay.style.display = "none";
  if (escapeKeyHandler) {
    window.removeEventListener("keydown", escapeKeyHandler);
    escapeKeyHandler = null;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────

export function setupToolbox() {
  el("toolbox-browse-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected) {
        const input = el<HTMLInputElement>("toolbox-image-path-input");
        if (input) {
          input.value = selected;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        loadImage(selected);
      }
    } catch (err) {
      logJS("toolbox browse error: " + ((err as any)?.message || err));
    }
  });

  // Drag & drop an image file directly onto the toolbox.
  const sourceGroup = el("toolbox-source-group");
  getCurrentWebview().onDragDropEvent((event) => {
    const toolboxActive = document.getElementById("view-toolbox")?.classList.contains("active");
    if (!toolboxActive) return;
    if (!sourceGroup) return;

    const drop = event.payload;

    // Only highlight the drop zone when the cursor is actually over the source group.
    const isOverSourceGroup = (): boolean => {
      if (!sourceGroup) return false;
      const pos = (drop as any).position;
      if (!pos || typeof pos.x !== "number") return false;
      const cx = pos.x / window.devicePixelRatio;
      const cy = pos.y / window.devicePixelRatio;
      const hit = document.elementFromPoint(cx, cy);
      return !!hit && (sourceGroup.contains(hit) || sourceGroup === hit);
    };

    if (drop.type === "enter" || drop.type === "over") {
      if (isOverSourceGroup()) {
        sourceGroup.classList.add("toolbox-drop-active");
      } else {
        sourceGroup.classList.remove("toolbox-drop-active");
      }
    } else if (drop.type === "leave") {
      sourceGroup.classList.remove("toolbox-drop-active");
    } else if (drop.type === "drop") {
      sourceGroup.classList.remove("toolbox-drop-active");
      const path = firstImagePath(drop.paths);
      if (path) {
        const input = el<HTMLInputElement>("toolbox-image-path-input");
        if (input) {
          input.value = path;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        loadImage(path);
      }
    }
  });

  el("toolbox-load-btn")?.addEventListener("click", () => {
    const input = el<HTMLInputElement>("toolbox-image-path-input");
    const path = input?.value.trim();
    if (path) {
      loadImage(path);
    } else {
      const status = el("toolbox-source-status");
      if (status) setStatusMessage(status, "Enter or browse for an image path first.", "error");
    }
  });

  el("toolbox-clear-preview-btn")?.addEventListener("click", () => {
    currentPath = null;
    const input = el<HTMLInputElement>("toolbox-image-path-input");
    if (input) input.value = "";
    const group = el("toolbox-preview-group");
    if (group) group.style.display = "none";
    const dropZone = el("toolbox-drop-zone");
    if (dropZone) dropZone.style.display = "";
    resetResults();
    const status = el("toolbox-source-status");
    if (status) setStatusMessage(status, "Image cleared.", "success");
  });

  el("toolbox-reverse-search-btn")?.addEventListener("click", runReverseSearch);
  el("toolbox-tag-btn")?.addEventListener("click", runTagging);
  el("toolbox-copy-tags-btn")?.addEventListener("click", copyTags);
  el("toolbox-ocr-btn")?.addEventListener("click", runOcr);
  el("toolbox-detect-btn")?.addEventListener("click", runDetection);
  el("toolbox-safety-btn")?.addEventListener("click", runSafety);

  el("toolbox-fullscreen-btn")?.addEventListener("click", openFullscreen);
  const fullscreenOverlay = el("toolbox-fullscreen-overlay");
  if (fullscreenOverlay) {
    document.body.appendChild(fullscreenOverlay);
    el("toolbox-fullscreen-close")?.addEventListener("click", closeFullscreen);
    fullscreenOverlay.addEventListener("click", (e) => {
      if (e.target === fullscreenOverlay) closeFullscreen();
    });
  }
  escapeKeyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeFullscreen();
  };
  window.addEventListener("keydown", escapeKeyHandler);

  el("toolbox-ocr-list")?.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest(".toolbox-ocr-copy") as HTMLButtonElement | null;
    if (!copyBtn) return;
    const item = currentOcr[parseInt(copyBtn.dataset.index || "", 10)];
    const status = el("toolbox-ocr-status");
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.text);
      if (status) setStatusMessage(status, "Text copied to clipboard.", "success");
    } catch (err: any) {
      if (status) setStatusMessage(status, `Copy failed: ${err?.message || err}`, "error");
    }
  });

  el("toolbox-ocr-overlay-toggle")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const overlay = el("toolbox-overlay-ocr");
    if (overlay) {
      if (checked) {
        renderOcrOverlay();
      } else {
        overlay.style.display = "none";
      }
    }
  });

  el("toolbox-detect-overlay-toggle")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const overlay = el("toolbox-overlay-detect");
    if (overlay) {
      if (checked) {
        renderDetectionOverlay();
      } else {
        overlay.style.display = "none";
      }
    }
  });
}

// ── HTML Template ─────────────────────────────────────────────────────

export function renderToolboxHtml(): SafeHtml {
  return html`
    <div class="toolbox-layout">

      <!-- LEFT: Source Image / Preview -->
      <div class="toolbox-column">
        <div class="group-box" id="toolbox-source-group">
          <div class="group-box-title"><i class="bi bi-file-earmark-image"></i> Source Image</div>
          <div class="form-group" style="margin-top: 6px;">
            <div class="input-wrapper" style="flex: 1;">
              <input class="input-field has-clear" id="toolbox-image-path-input" placeholder="Select or paste a path to any image file..." />
              <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
            </div>
            <button type="button" class="win-button" id="toolbox-browse-btn" style="white-space: nowrap;">
              <i class="bi bi-file-earmark-image"></i> Browse Image...
            </button>
            <button type="button" class="win-button primary" id="toolbox-load-btn" style="white-space: nowrap;">
              <i class="bi bi-arrow-clockwise"></i> Load
            </button>
          </div>
          <p id="toolbox-source-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;">
            Drag &amp; drop an image here, or pick any image file. Processing is ephemeral — nothing is written to your library.
          </p>
          <div class="toolbox-drop-zone" id="toolbox-drop-zone">
            <div class="toolbox-drop-icon">
              <i class="bi bi-image"></i>
            </div>
            <span>Drop an image here</span>
          </div>
          <div class="toolbox-preview-box" id="toolbox-preview-group" style="display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; margin-bottom: 8px;">
              <div id="toolbox-preview-filename" title="" style="font-size: 11px; color: var(--sys-text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;"></div>
              <button type="button" class="win-button" id="toolbox-fullscreen-btn" style="font-size: 11px; padding: 2px 8px;"><i class="bi bi-fullscreen"></i> Fullscreen</button>
              <button type="button" class="win-button" id="toolbox-clear-preview-btn" style="font-size: 11px; padding: 2px 8px;"><i class="bi bi-x-lg"></i> Clear</button>
            </div>
            <div class="toolbox-preview-scroll" style="background: #1a1a1a; border: 1px solid var(--sys-border-dark);">
              <svg id="toolbox-preview-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; display: block;">
                <image id="toolbox-preview-img" x="0" y="0" width="0" height="0" />
                <g id="toolbox-overlay-ocr"></g>
                <g id="toolbox-overlay-detect"></g>
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: AI Processing Tools -->
      <div class="toolbox-column">
        <div class="group-box toolbox-fixed">
          <div class="group-box-title"><i class="bi bi-search"></i> Reverse Image Search</div>
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <span style="font-size: 11px; color: var(--sys-text-subtle); flex: 1;">Find similar images in your library using the current image as the query.</span>
            <button type="button" class="win-button primary" id="toolbox-reverse-search-btn">
              <i class="bi bi-search"></i> Open in General Search
            </button>
          </div>
          <p id="toolbox-reverse-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;"></p>
        </div>

        <div class="group-box toolbox-panel">
          <div class="group-box-title"><i class="bi bi-stars"></i> AUTO TAG</div>
          <div class="form-group" style="margin-top: 6px; flex-wrap: wrap;">
            <select class="input-field" id="toolbox-tagger-select" style="width: 155px; font-size: 11px;" title="Tagger model to use for this run">
              <option value="" selected>Preferred Tagger</option>
              <option value="camie">Camie Tagger v2</option>
              <option value="wd-eva02">WD EVA02 Tagger</option>
            </select>
            <select class="input-field" id="toolbox-tagger-threshold-select" style="width: 155px; font-size: 11px;">
              <option value="0.5" selected>Balanced (0.50)</option>
              <option value="0.65">High Precision (0.65)</option>
              <option value="0.35">High Recall (0.35)</option>
            </select>
            <button type="button" class="win-button" id="toolbox-tag-btn"><i class="bi bi-stars"></i> Tag Image</button>
            <button type="button" class="win-button" id="toolbox-copy-tags-btn" style="display: none;"><i class="bi bi-clipboard"></i> Copy Tags</button>
          </div>
          <p id="toolbox-tag-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;"></p>
          <div id="toolbox-tag-list" class="toolbox-output" style="display: flex; flex-wrap: wrap; gap: 4px; padding: 4px;"></div>
        </div>

        <div class="group-box toolbox-panel">
          <div class="group-box-title"><i class="bi bi-fonts"></i> OCR Text Detection</div>
          <div class="form-group" style="margin-top: 6px;">
            <button type="button" class="win-button" id="toolbox-ocr-btn"><i class="bi bi-fonts"></i> Run OCR</button>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; cursor: pointer;">
              <input type="checkbox" id="toolbox-ocr-overlay-toggle" checked /> Show overlay
            </label>
          </div>
          <p id="toolbox-ocr-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;"></p>
          <div id="toolbox-ocr-list" class="toolbox-output" style="display: flex; flex-direction: column; gap: 4px; padding: 4px;"></div>
        </div>

        <div class="group-box toolbox-panel">
          <div class="group-box-title"><i class="bi bi-bounding-box"></i> Character Detection</div>
          <div class="form-group" style="margin-top: 6px;">
            <button type="button" class="win-button" id="toolbox-detect-btn"><i class="bi bi-bounding-box"></i> Detect Characters</button>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; cursor: pointer;">
              <input type="checkbox" id="toolbox-detect-overlay-toggle" checked /> Show overlay
            </label>
          </div>
          <p id="toolbox-detect-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;"></p>
          <div id="toolbox-detect-list" class="toolbox-output" style="display: flex; flex-direction: column; gap: 4px; padding: 4px;"></div>
        </div>

        <div class="group-box toolbox-panel">
          <div class="group-box-title"><i class="bi bi-shield-check"></i> Safety Rating</div>
          <div class="form-group" style="margin-top: 6px; flex-wrap: wrap;">
            <button type="button" class="win-button" id="toolbox-safety-btn"><i class="bi bi-shield-check"></i> Classify Safety</button>
            <span id="toolbox-safety-summary" style="display: none; font-size: 11px; font-weight: 600; white-space: nowrap;"></span>
          </div>
          <p id="toolbox-safety-status" style="font-size: 11px; color: var(--sys-text-subtle); min-height: 16px; margin: 6px 0 0 0;"></p>
          <div id="toolbox-safety-result" class="toolbox-output" style="padding: 4px;"></div>
        </div>
      </div>
    </div>

    <div id="toolbox-fullscreen-overlay">
      <button type="button" class="toolbox-fullscreen-close" id="toolbox-fullscreen-close" title="Close (Esc)"><i class="bi bi-x-lg"></i></button>
      <div id="toolbox-fullscreen-svg"></div>
    </div>
  `;
}
