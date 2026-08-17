export interface PlacedLabel {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrTextSettings {
  fontSize: number;
  strokeWidth: number;
  fontFamily: string;
  fitInBox: boolean;
  verticalText: boolean;
}

const FONT_SIZE_KEY = "curator-ocr-font-size";
const STROKE_WIDTH_KEY = "curator-ocr-stroke-width";
const FONT_FAMILY_KEY = "curator-ocr-font-family";
const FIT_IN_BOX_KEY = "curator-ocr-fit-in-box";
const VERTICAL_TEXT_KEY = "curator-ocr-vertical-text";
const DEFAULT_FONT_FAMILY = "Segoe UI";
const MIN_FIT_FONT_SIZE = 4;

export function getOcrTextSettings(): OcrTextSettings {
  const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || "12", 10);
  const strokeWidth = parseInt(localStorage.getItem(STROKE_WIDTH_KEY) || "5", 10);
  const fontFamily = localStorage.getItem(FONT_FAMILY_KEY) || DEFAULT_FONT_FAMILY;
  const fitInBox = localStorage.getItem(FIT_IN_BOX_KEY) === "1";
  const verticalText = localStorage.getItem(VERTICAL_TEXT_KEY) === "1";
  return {
    fontSize: Number.isFinite(fontSize) ? fontSize : 12,
    strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 5,
    fontFamily,
    fitInBox,
    verticalText,
  };
}

export function estimateLabelWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK ideographs/radicals, kana, Hangul, and fullwidth forms are ~1em wide
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      w += fontSize;
    } else {
      w += fontSize * 0.6;
    }
  }
  return w;
}

// Returns true when the detection quadrilateral's long axis runs vertically,
// i.e. the recognized text line reads top-to-bottom (typical for CJK). Uses the
// two edges originating at point 0 (top-left of the box).
export function isVerticalBox(pts: number[][]): boolean {
  const p0 = pts[0];
  const p1 = pts[1];
  const p3 = pts[3];
  const dx1 = p1[0] - p0[0];
  const dy1 = p1[1] - p0[1];
  const dx2 = p3[0] - p0[0];
  const dy2 = p3[1] - p0[1];
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);
  if (len1 >= len2) return Math.abs(dy1) > Math.abs(dx1);
  return Math.abs(dy2) > Math.abs(dx2);
}

// Returns tspan markup that stacks each character one below the next, so a
// vertical OCR box renders the text as a top-to-bottom column instead of a
// single horizontal line. Font size is set explicitly on every tspan.
export function buildVerticalSpans(
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  spacing: number = 0,
): string {
  const chars = Array.from(text);
  return chars
    .map(
      (ch, i) =>
        `<tspan x="${x}" y="${baselineY + i * (fontSize + spacing)}" font-size="${fontSize}" style="font-size: ${fontSize}px;">${ch}</tspan>`,
    )
    .join("");
}

// Measures the rendered width of text at a given font size using the canvas
// API, falling back to the per-character estimate when measurement is
// unavailable (e.g. during SSR). Used to compute exact letter-spacing.
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(text: string, fontFamily: string, fontSize: number): number {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (measureCtx) {
    measureCtx.font = `${fontSize}px ${fontFamily}, sans-serif`;
    return measureCtx.measureText(text).width;
  }
  return estimateLabelWidth(text, fontSize);
}

// Returns the font size (and label position relative to the box top-left) that
// fills the given axis-aligned box. Horizontal text scales to fill the box
// height, then adds letter-spacing to stretch it across the full box width;
// when the text would overflow the box width the font is scaled down instead.
// Vertical text scales to fill the box width, then char-spaces to fill the box
// height; when the column would overflow the box height the font is scaled
// down instead. `spacing` is letter-spacing (horizontal) or the vertical gap
// between characters (vertical). The label block is centered inside the box.
export function fitLabelInBox(
  text: string,
  boxW: number,
  boxH: number,
  pad: number,
  vertical: boolean,
  fontFamily: string,
): { fontSize: number; x: number; y: number; w: number; h: number; spacing: number } {
  if (vertical) {
    const chars = Array.from(text);
    const count = Math.max(chars.length, 1);
    const availableWidth = boxW - 2 * pad;
    const availableHeight = boxH - 2 * pad;
    const maxFactor = chars.length
      ? Math.max(...chars.map((ch) => estimateLabelWidth(ch, 1)))
      : 0.6;
    // Scale font size so each character fills the box width.
    let fontSize = Math.max(MIN_FIT_FONT_SIZE, availableWidth / maxFactor);
    let widestWidth = chars.length
      ? Math.max(...chars.map((ch) => measureTextWidth(ch, fontFamily, fontSize)))
      : fontSize * 0.6;
    if (widestWidth > availableWidth) {
      fontSize = Math.max(MIN_FIT_FONT_SIZE, fontSize * (availableWidth / widestWidth));
      widestWidth = chars.length
        ? Math.max(...chars.map((ch) => measureTextWidth(ch, fontFamily, fontSize)))
        : fontSize * 0.6;
    }
    // Check height constraint: if column height exceeds available height, scale font down.
    let baseHeight = fontSize * count;
    if (baseHeight > availableHeight) {
      fontSize = Math.max(MIN_FIT_FONT_SIZE, fontSize * (availableHeight / baseHeight));
      widestWidth = chars.length
        ? Math.max(...chars.map((ch) => measureTextWidth(ch, fontFamily, fontSize)))
        : fontSize * 0.6;
      baseHeight = fontSize * count;
    }
    // Compute vertical character spacing to fill box height.
    const gapCount = Math.max(count - 1, 0);
    const spacing = gapCount > 0 ? Math.max(0, (availableHeight - baseHeight) / gapCount) : 0;
    const labelW = widestWidth;
    const labelH = baseHeight + spacing * gapCount;
    return {
      fontSize,
      x: (boxW - labelW) / 2,
      y: (boxH - labelH) / 2,
      w: labelW,
      h: labelH,
      spacing,
    };
  }
  // Scale to fill the box height, then letter-space to fill the box width.
  const availableWidth = boxW - 2 * pad;
  let fontSize = Math.max(MIN_FIT_FONT_SIZE, boxH - 2 * pad);
  let baseWidth = measureTextWidth(text, fontFamily, fontSize);
  if (baseWidth > availableWidth) {
    // Text is too wide even without spacing: scale the font down to fit.
    fontSize = Math.max(MIN_FIT_FONT_SIZE, fontSize * (availableWidth / baseWidth));
    baseWidth = measureTextWidth(text, fontFamily, fontSize);
  }
  const gapCount = Math.max(Array.from(text).length - 1, 0);
  const spacing = gapCount > 0 ? Math.max(0, (availableWidth - baseWidth) / gapCount) : 0;
  const labelW = baseWidth + spacing * gapCount;
  const labelH = fontSize;
  return {
    fontSize,
    x: (boxW - labelW) / 2,
    y: (boxH - labelH) / 2,
    w: labelW,
    h: labelH,
    spacing,
  };
}

// Pushes a label downwards until it no longer overlaps any previously placed
// label (stopping at the overlay bounds), so stacked/overlapping OCR boxes
// never draw text on top of each other and text never runs off the edges.
export function placeLabelAvoidingOverlap(
  x: number,
  y: number,
  w: number,
  h: number,
  placed: PlacedLabel[],
  pad: number,
  bounds?: { w: number; h: number },
): { x: number; y: number } {
  let lx = x;
  let ly = y;
  const maxY = bounds ? bounds.h - h : Number.POSITIVE_INFINITY;
  let guard = 0;
  while (guard++ < 64) {
    let hit: PlacedLabel | null = null;
    for (const p of placed) {
      if (
        lx < p.x + p.w + pad &&
        lx + w + pad > p.x &&
        ly < p.y + p.h + pad &&
        ly + h + pad > p.y
      ) {
        hit = p;
        break;
      }
    }
    if (!hit) break;
    const nextY = hit.y + hit.h + pad;
    if (nextY > maxY) break;
    ly = nextY;
  }
  // Clamp into the overlay bounds so labels at the edges are never lost.
  if (bounds) {
    if (lx + w > bounds.w) lx = Math.max(0, bounds.w - w);
    if (lx < 0) lx = 0;
    if (ly + h > bounds.h) ly = Math.max(0, bounds.h - h);
    if (ly < 0) ly = 0;
  }
  return { x: lx, y: ly };
}

export interface OcrPreviewBox {
  pts: number[][];
  text: string;
  color: string;
  fill: string;
}

// Renders a sample OCR overlay (boxes + non-overlapping text labels) using the
// current settings, used for the live preview in Settings.
export function buildOcrLabelSvg(boxes: OcrPreviewBox[], viewW: number, viewH: number): string {
  const { fontSize, strokeWidth, fontFamily, fitInBox, verticalText } = getOcrTextSettings();
  const sorted = [...boxes].sort((a, b) => {
    const ay = Math.min(a.pts[0][1], a.pts[1][1], a.pts[2][1], a.pts[3][1]);
    const by = Math.min(b.pts[0][1], b.pts[1][1], b.pts[2][1], b.pts[3][1]);
    const ax = Math.min(a.pts[0][0], a.pts[1][0], a.pts[2][0], a.pts[3][0]);
    const bx = Math.min(b.pts[0][0], b.pts[1][0], b.pts[2][0], b.pts[3][0]);
    return ay - by || ax - bx;
  });

  const placed: PlacedLabel[] = [];
  const pad = Math.max(1, Math.ceil(strokeWidth / 2));
  let polys = "";
  let labels = "";
  for (const b of sorted) {
    const minX = Math.min(b.pts[0][0], b.pts[1][0], b.pts[2][0], b.pts[3][0]);
    const minY = Math.min(b.pts[0][1], b.pts[1][1], b.pts[2][1], b.pts[3][1]);
    const maxX = Math.max(b.pts[0][0], b.pts[1][0], b.pts[2][0], b.pts[3][0]);
    const maxY = Math.max(b.pts[0][1], b.pts[1][1], b.pts[2][1], b.pts[3][1]);
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    const idx = boxes.indexOf(b);
    polys += `<rect x="${minX}" y="${minY}" width="${boxW}" height="${boxH}" fill="${b.fill}" stroke="${b.color}" stroke-width="2" class="preview-box-rect" data-index="${idx}" style="cursor: move; pointer-events: auto;"/>`;
    polys += `<circle cx="${maxX}" cy="${maxY}" r="5" fill="${b.color}" stroke="#ffffff" stroke-width="1.5" class="preview-box-handle" data-index="${idx}" style="cursor: nwse-resize; pointer-events: auto;"/>`;
    const boxVertical = isVerticalBox(b.pts);
    const vertical = verticalText && boxVertical;
    // A vertical box without vertical stacking should not be fit-scaled: the
    // horizontal label would collapse into a sliver, so render it with the
    // normal overlap-avoidance placement instead.
    const fitEffective = fitInBox && !(boxVertical && !verticalText);
    let fs = fontSize;
    let pos: { x: number; y: number };
    let labelBody = b.text;
    let letterSpacing = 0;
    if (vertical && fitInBox) {
      const fit = fitLabelInBox(b.text, boxW, boxH, pad, true, fontFamily);
      fs = fit.fontSize;
      pos = { x: minX + fit.x, y: minY + fit.y };
      const final = placeLabelAvoidingOverlap(pos.x, pos.y, fit.w, fit.h, placed, 3, {
        w: viewW,
        h: viewH,
      });
      pos = { x: final.x, y: final.y };
      placed.push({ x: pos.x, y: pos.y, w: fit.w, h: fit.h });
      labelBody = buildVerticalSpans(b.text, pos.x, pos.y + fs, fs, fit.spacing);
    } else if (vertical) {
      const chars = Array.from(b.text);
      const count = Math.max(chars.length, 1);
      const labelW = chars.length
        ? Math.max(...chars.map((ch) => estimateLabelWidth(ch, fs)))
        : fs * 0.6;
      const labelH = fs * count;
      pos = placeLabelAvoidingOverlap(minX + 4, minY + 4, labelW, labelH, placed, 3, {
        w: viewW,
        h: viewH,
      });
      placed.push({ x: pos.x, y: pos.y, w: labelW, h: labelH });
      labelBody = buildVerticalSpans(b.text, pos.x, pos.y + fs, fs, 0);
    } else if (fitEffective) {
      const fit = fitLabelInBox(b.text, boxW, boxH, pad, false, fontFamily);
      fs = fit.fontSize;
      pos = { x: minX + fit.x, y: minY + fit.y };
      letterSpacing = fit.spacing;
      const final = placeLabelAvoidingOverlap(pos.x, pos.y, fit.w, fit.h, placed, 3, {
        w: viewW,
        h: viewH,
      });
      pos = { x: final.x, y: final.y };
      placed.push({ x: pos.x, y: pos.y, w: fit.w, h: fit.h });
    } else {
      const labelW = estimateLabelWidth(b.text, fs);
      const labelH = fs + 4;
      pos = placeLabelAvoidingOverlap(minX + 4, minY + 4, labelW, labelH, placed, 3, {
        w: viewW,
        h: viewH,
      });
      placed.push({ x: pos.x, y: pos.y, w: labelW, h: labelH });
    }
    const textX = vertical ? "0" : pos.x;
    const textY = vertical ? "0" : pos.y + fs;
    const lsAttr = letterSpacing > 0 ? `letter-spacing:${letterSpacing}px; ` : "";
    labels +=
      `<text x="${textX}" y="${textY}" fill="#ffffff" style="font-size:${fs}px; ${lsAttr}font-family:${fontFamily}, sans-serif" ` +
      `font-weight="600" paint-order="stroke" stroke="rgba(0,0,0,0.8)" ` +
      `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${labelBody}</text>`;
  }
  return `<svg viewBox="0 0 ${viewW} ${viewH}" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block; background:#c8c8c8; height: auto;">${polys}${labels}</svg>`;
}
