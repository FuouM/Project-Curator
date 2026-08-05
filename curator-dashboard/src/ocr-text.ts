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
}

const FONT_SIZE_KEY = "curator-ocr-font-size";
const STROKE_WIDTH_KEY = "curator-ocr-stroke-width";
const FONT_FAMILY_KEY = "curator-ocr-font-family";
const DEFAULT_FONT_FAMILY = "Segoe UI";

export function getOcrTextSettings(): OcrTextSettings {
  const fontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY) || "12", 10);
  const strokeWidth = parseInt(localStorage.getItem(STROKE_WIDTH_KEY) || "5", 10);
  const fontFamily = localStorage.getItem(FONT_FAMILY_KEY) || DEFAULT_FONT_FAMILY;
  return {
    fontSize: Number.isFinite(fontSize) ? fontSize : 12,
    strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 5,
    fontFamily,
  };
}

export function estimateLabelWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK ideographs/radicals, kana, Hangul, and fullwidth forms are ~1em wide
    if ((code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xff00 && code <= 0xffef)) {
      w += fontSize;
    } else {
      w += fontSize * 0.6;
    }
  }
  return w;
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
      if (lx < p.x + p.w + pad && lx + w + pad > p.x &&
          ly < p.y + p.h + pad && ly + h + pad > p.y) {
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
  const { fontSize, strokeWidth, fontFamily } = getOcrTextSettings();
  const sorted = [...boxes].sort((a, b) => {
    const ay = Math.min(a.pts[0][1], a.pts[1][1], a.pts[2][1], a.pts[3][1]);
    const by = Math.min(b.pts[0][1], b.pts[1][1], b.pts[2][1], b.pts[3][1]);
    const ax = Math.min(a.pts[0][0], a.pts[1][0], a.pts[2][0], a.pts[3][0]);
    const bx = Math.min(b.pts[0][0], b.pts[1][0], b.pts[2][0], b.pts[3][0]);
    return (ay - by) || (ax - bx);
  });

  const labelH = fontSize + 4;
  const placed: PlacedLabel[] = [];
  let polys = "";
  let labels = "";
  for (const b of sorted) {
    const ptsAttr = b.pts.map(pt => `${pt[0]},${pt[1]}`).join(" ");
    polys += `<polygon points="${ptsAttr}" fill="${b.fill}" stroke="${b.color}" stroke-width="2"/>`;
    const minX = Math.min(b.pts[0][0], b.pts[1][0], b.pts[2][0], b.pts[3][0]);
    const minY = Math.min(b.pts[0][1], b.pts[1][1], b.pts[2][1], b.pts[3][1]);
    const labelW = estimateLabelWidth(b.text, fontSize);
    const pos = placeLabelAvoidingOverlap(minX + 4, minY + 4, labelW, labelH, placed, 3, { w: viewW, h: viewH });
    placed.push({ x: pos.x, y: pos.y, w: labelW, h: labelH });
    labels +=
      `<text x="${pos.x}" y="${pos.y + fontSize}" fill="#ffffff" style="font-size:${fontSize}px; font-family:${fontFamily}, sans-serif" ` +
      `font-weight="600" paint-order="stroke" stroke="rgba(0,0,0,0.8)" ` +
      `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${b.text}</text>`;
  }
  return `<svg viewBox="0 0 ${viewW} ${viewH}" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block; background:#c8c8c8; height: auto;">${polys}${labels}</svg>`;
}
