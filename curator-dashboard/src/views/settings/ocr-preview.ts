import { buildOcrLabelSvg, getOcrTextSettings } from "../../ocr-text";
import type { OcrPreviewBox } from "../../ocr-text";

const OCR_PREVIEW_BOXES: OcrPreviewBox[] = [
  {
    pts: [
      [30, 30],
      [190, 30],
      [190, 70],
      [30, 70],
    ],
    text: "Lorem ipsum dolor",
    color: "#3498db",
    fill: "rgba(52, 152, 219, 0.15)",
  },
  {
    pts: [
      [100, 50],
      [300, 50],
      [300, 90],
      [100, 90],
    ],
    text: "overlapping labels",
    color: "#9b59b6",
    fill: "rgba(155, 89, 182, 0.15)",
  },
  {
    pts: [
      [40, 110],
      [260, 110],
      [260, 155],
      [40, 155],
    ],
    text: "pushed below",
    color: "#3498db",
    fill: "rgba(52, 152, 219, 0.15)",
  },
  {
    pts: [
      [410, 20],
      [450, 20],
      [450, 180],
      [410, 180],
    ],
    text: "縦書き",
    color: "#9b59b6",
    fill: "rgba(155, 89, 182, 0.15)",
  },
];

export function renderOcrPreview() {
  const preview = document.getElementById("settings-ocr-preview");
  if (!preview) return;
  preview.innerHTML = buildOcrLabelSvg(OCR_PREVIEW_BOXES, 500, 200);
}

export function bindOcrPreviewControls() {
  const ocrFontSizeSelect = document.getElementById("settings-ocr-font-size") as HTMLSelectElement;
  const ocrStrokeWidthSelect = document.getElementById(
    "settings-ocr-stroke-width",
  ) as HTMLSelectElement;
  const ocrFontFamilySelect = document.getElementById(
    "settings-ocr-font-family",
  ) as HTMLSelectElement;
  const ocrFitInBoxCheckbox = document.getElementById(
    "settings-ocr-fit-in-box",
  ) as HTMLInputElement;
  const ocrVerticalTextCheckbox = document.getElementById(
    "settings-ocr-vertical-text",
  ) as HTMLInputElement;
  const { fontSize, strokeWidth, fontFamily, fitInBox, verticalText } = getOcrTextSettings();
  if (ocrFontSizeSelect) ocrFontSizeSelect.value = fontSize.toString();
  if (ocrStrokeWidthSelect) ocrStrokeWidthSelect.value = strokeWidth.toString();
  if (ocrFontFamilySelect) {
    ocrFontFamilySelect.value = fontFamily;
    if (!ocrFontFamilySelect.value) ocrFontFamilySelect.value = "Segoe UI";
  }
  if (ocrFitInBoxCheckbox) ocrFitInBoxCheckbox.checked = fitInBox;
  if (ocrVerticalTextCheckbox) ocrVerticalTextCheckbox.checked = verticalText;

  if (ocrFontSizeSelect) {
    ocrFontSizeSelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-font-size", ocrFontSizeSelect.value);
      renderOcrPreview();
    });
  }
  if (ocrStrokeWidthSelect) {
    ocrStrokeWidthSelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-stroke-width", ocrStrokeWidthSelect.value);
      renderOcrPreview();
    });
  }
  if (ocrFontFamilySelect) {
    ocrFontFamilySelect.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-font-family", ocrFontFamilySelect.value);
      renderOcrPreview();
    });
  }
  if (ocrFitInBoxCheckbox) {
    ocrFitInBoxCheckbox.addEventListener("change", () => {
      localStorage.setItem("curator-ocr-fit-in-box", ocrFitInBoxCheckbox.checked ? "1" : "0");
      renderOcrPreview();
    });
  }
  if (ocrVerticalTextCheckbox) {
    ocrVerticalTextCheckbox.addEventListener("change", () => {
      localStorage.setItem(
        "curator-ocr-vertical-text",
        ocrVerticalTextCheckbox.checked ? "1" : "0",
      );
      renderOcrPreview();
    });
  }
}

export function setupOcrDragListeners(previewContainer: HTMLElement) {
  let isDragging = false;
  let activeIndex = -1;
  let activeAction: "move" | "resize" | null = null;
  let startX = 0;
  let startY = 0;
  let startPts: number[][] = [];

  previewContainer.addEventListener("mousedown", (e) => {
    const target = e.target as SVGElement;
    if (!target) return;

    const isRect = target.classList.contains("preview-box-rect");
    const isHandle = target.classList.contains("preview-box-handle");

    if (isRect || isHandle) {
      const indexAttr = target.getAttribute("data-index");
      if (indexAttr === null) return;

      e.preventDefault();
      isDragging = true;
      activeIndex = parseInt(indexAttr, 10);
      activeAction = isHandle ? "resize" : "move";
      startX = e.clientX;
      startY = e.clientY;
      startPts = OCR_PREVIEW_BOXES[activeIndex].pts.map((pt) => [...pt]);
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging || activeIndex === -1) return;

    const svgEl = previewContainer.querySelector("svg");
    if (!svgEl) return;

    const rect = svgEl.getBoundingClientRect();
    const scaleX = 500 / rect.width;
    const scaleY = 200 / rect.height;

    const dx = (e.clientX - startX) * scaleX;
    const dy = (e.clientY - startY) * scaleY;

    const box = OCR_PREVIEW_BOXES[activeIndex];
    const minX = Math.min(...startPts.map((pt) => pt[0]));
    const minY = Math.min(...startPts.map((pt) => pt[1]));
    const maxX = Math.max(...startPts.map((pt) => pt[0]));
    const maxY = Math.max(...startPts.map((pt) => pt[1]));

    if (activeAction === "move") {
      const w = maxX - minX;
      const h = maxY - minY;

      const newMinX = Math.max(0, Math.min(500 - w, minX + dx));
      const newMinY = Math.max(0, Math.min(200 - h, minY + dy));

      box.pts = [
        [newMinX, newMinY],
        [newMinX + w, newMinY],
        [newMinX + w, newMinY + h],
        [newMinX, newMinY + h],
      ];
    } else if (activeAction === "resize") {
      const newMaxX = Math.max(minX + 20, Math.min(500, maxX + dx));
      const newMaxY = Math.max(minY + 20, Math.min(200, maxY + dy));

      box.pts = [
        [minX, minY],
        [newMaxX, minY],
        [newMaxX, newMaxY],
        [minX, newMaxY],
      ];
    }

    renderOcrPreview();
  });

  window.addEventListener("mouseup", () => {
    isDragging = false;
    activeIndex = -1;
    activeAction = null;
  });
}
