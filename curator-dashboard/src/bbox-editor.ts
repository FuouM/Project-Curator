import { typedCall } from "./ipc";
import { convertFileSrc } from "@tauri-apps/api/core";
import { showErrorAlert } from "./alert";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  AddDetectionRequestSchema,
  AddDetectionResultSchema,
  UpdateDetectionBoundingBoxRequestSchema,
} from "./gen/characters_pb";

let currentDetId: number | null = null;
let currentImageId: number | null = null;
let imgNaturalWidth = 1;
let imgNaturalHeight = 1;

let boxX0 = 0;
let boxY0 = 0;
let boxX1 = 0;
let boxY1 = 0;

let isDragging = false;
let activeHandle: string | null = null; // 'move' or 'nw', 'ne', etc.
let startPointerX = 0;
let startPointerY = 0;
let startBoxX0 = 0;
let startBoxY0 = 0;
let startBoxX1 = 0;
let startBoxY1 = 0;

let onSaveCallback: (() => void) | null = null;

export function openBBoxEditor(
  detectionId: number | null,
  imageId: number,
  filePath: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  onSave?: () => void
) {
  currentDetId = detectionId;
  currentImageId = imageId;
  boxX0 = x0;
  boxY0 = y0;
  boxX1 = x1;
  boxY1 = y1;
  onSaveCallback = onSave || null;

  const modal = document.getElementById("bbox-editor-modal");
  const img = document.getElementById("bbox-editor-img") as HTMLImageElement;
  const box = document.getElementById("bbox-editor-box");

  if (!modal || !img || !box) return;

  // Clear previous box display until image is loaded and sized
  box.style.display = "none";

  // Activate modal first so clientWidth/clientHeight layout is determined
  modal.classList.add("active");

  const showBox = () => {
    const activeBox = document.getElementById("bbox-editor-box");
    if (activeBox) activeBox.style.display = "block";
  };

  img.onload = () => {
    imgNaturalWidth = img.naturalWidth || 1;
    imgNaturalHeight = img.naturalHeight || 1;
    if (boxX0 === 0 && boxY0 === 0 && boxX1 === 0 && boxY1 === 0) {
      boxX0 = Math.round(imgNaturalWidth * 0.25);
      boxY0 = Math.round(imgNaturalHeight * 0.25);
      boxX1 = Math.round(imgNaturalWidth * 0.75);
      boxY1 = Math.round(imgNaturalHeight * 0.75);
    }
    showBox();
    setTimeout(() => {
      updateBBoxUI();
    }, 50);
  };

  img.src = convertFileSrc(filePath);

  if (img.complete) {
    imgNaturalWidth = img.naturalWidth || 1;
    imgNaturalHeight = img.naturalHeight || 1;
    if (boxX0 === 0 && boxY0 === 0 && boxX1 === 0 && boxY1 === 0) {
      boxX0 = Math.round(imgNaturalWidth * 0.25);
      boxY0 = Math.round(imgNaturalHeight * 0.25);
      boxX1 = Math.round(imgNaturalWidth * 0.75);
      boxY1 = Math.round(imgNaturalHeight * 0.75);
    }
    showBox();
    setTimeout(() => {
      updateBBoxUI();
    }, 100);
  }

  setupBBoxEvents();
}

function updateBBoxUI() {
  const img = document.getElementById("bbox-editor-img") as HTMLImageElement;
  const box = document.getElementById("bbox-editor-box");
  if (!img || !box) return;

  const dispWidth = img.clientWidth;
  const dispHeight = img.clientHeight;

  const scaleX = dispWidth / imgNaturalWidth;
  const scaleY = dispHeight / imgNaturalHeight;

  const left = Math.min(boxX0, boxX1) * scaleX;
  const top = Math.min(boxY0, boxY1) * scaleY;
  const width = Math.abs(boxX1 - boxX0) * scaleX;
  const height = Math.abs(boxY1 - boxY0) * scaleY;

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;

  // Update inputs
  const inputX0 = document.getElementById("bbox-input-x0") as HTMLInputElement;
  const inputY0 = document.getElementById("bbox-input-y0") as HTMLInputElement;
  const inputX1 = document.getElementById("bbox-input-x1") as HTMLInputElement;
  const inputY1 = document.getElementById("bbox-input-y1") as HTMLInputElement;

  if (inputX0) inputX0.value = String(Math.round(boxX0));
  if (inputY0) inputY0.value = String(Math.round(boxY0));
  if (inputX1) inputX1.value = String(Math.round(boxX1));
  if (inputY1) inputY1.value = String(Math.round(boxY1));
}

function closeBBoxEditor() {
  const modal = document.getElementById("bbox-editor-modal");
  if (modal) modal.classList.remove("active");
  currentDetId = null;
  onSaveCallback = null;
}

function setupBBoxEvents() {
  const overlay = document.getElementById("bbox-editor-overlay");
  const box = document.getElementById("bbox-editor-box");
  const saveBtn = document.getElementById("bbox-editor-save");
  const cancelBtn = document.getElementById("bbox-editor-cancel");
  const closeBtn = document.getElementById("bbox-editor-close");
  const img = document.getElementById("bbox-editor-img") as HTMLImageElement;

  if (!overlay || !box || !img) return;

  // Cleanup old handlers to avoid leaks
  const newOverlay = overlay.cloneNode(true);
  overlay.parentNode!.replaceChild(newOverlay, overlay);
  const activeOverlay = document.getElementById("bbox-editor-overlay")!;

  const activeBox = document.getElementById("bbox-editor-box")!;

  // Inputs change handlers
  const inputs = ["x0", "y0", "x1", "y1"].map(id => document.getElementById(`bbox-input-${id}`) as HTMLInputElement);
  inputs.forEach(input => {
    if (!input) return;
    input.oninput = () => {
      const val = parseInt(input.value) || 0;
      if (input.id.endsWith("x0")) boxX0 = val;
      if (input.id.endsWith("y0")) boxY0 = val;
      if (input.id.endsWith("x1")) boxX1 = val;
      if (input.id.endsWith("y1")) boxY1 = val;
      updateBBoxUI();
    };
  });

  // Pointer Down
  activeOverlay.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    const rect = activeOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const scaleX = imgNaturalWidth / img.clientWidth;
    const scaleY = imgNaturalHeight / img.clientHeight;

    isDragging = true;
    startPointerX = x;
    startPointerY = y;
    startBoxX0 = boxX0;
    startBoxY0 = boxY0;
    startBoxX1 = boxX1;
    startBoxY1 = boxY1;

    if (target.classList.contains("bbox-handle")) {
      // Find resize handle
      if (target.classList.contains("nw")) activeHandle = "nw";
      else if (target.classList.contains("ne")) activeHandle = "ne";
      else if (target.classList.contains("se")) activeHandle = "se";
      else if (target.classList.contains("sw")) activeHandle = "sw";
      else if (target.classList.contains("n")) activeHandle = "n";
      else if (target.classList.contains("s")) activeHandle = "s";
      else if (target.classList.contains("e")) activeHandle = "e";
      else if (target.classList.contains("w")) activeHandle = "w";
    } else if (target === activeBox || activeBox.contains(target)) {
      activeHandle = "move";
    } else {
      // Clicked outside, start drawing a new box from scratch!
      activeHandle = "draw";
      const startX = Math.round(x * scaleX);
      const startY = Math.round(y * scaleY);
      boxX0 = startX;
      boxY0 = startY;
      boxX1 = startX;
      boxY1 = startY;
      updateBBoxUI();
    }

    activeOverlay.setPointerCapture(e.pointerId);
  });

  // Pointer Move
  activeOverlay.addEventListener("pointermove", (e: PointerEvent) => {
    if (!isDragging || !activeHandle) return;

    const rect = activeOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const scaleX = imgNaturalWidth / img.clientWidth;
    const scaleY = imgNaturalHeight / img.clientHeight;

    const deltaX = Math.round((x - startPointerX) * scaleX);
    const deltaY = Math.round((y - startPointerY) * scaleY);

    if (activeHandle === "move") {
      const w = startBoxX1 - startBoxX0;
      const h = startBoxY1 - startBoxY0;
      let newX0 = startBoxX0 + deltaX;
      let newY0 = startBoxY0 + deltaY;

      // Clamp movement bounds
      newX0 = Math.max(0, Math.min(imgNaturalWidth - w, newX0));
      newY0 = Math.max(0, Math.min(imgNaturalHeight - h, newY0));

      boxX0 = newX0;
      boxY0 = newY0;
      boxX1 = newX0 + w;
      boxY1 = newY0 + h;
    } else if (activeHandle === "draw") {
      boxX1 = Math.max(0, Math.min(imgNaturalWidth, Math.round(x * scaleX)));
      boxY1 = Math.max(0, Math.min(imgNaturalHeight, Math.round(y * scaleY)));
    } else {
      // Handles resize
      if (activeHandle.includes("e")) {
        boxX1 = Math.max(boxX0 + 2, Math.min(imgNaturalWidth, startBoxX1 + deltaX));
      }
      if (activeHandle.includes("w")) {
        boxX0 = Math.max(0, Math.min(boxX1 - 2, startBoxX0 + deltaX));
      }
      if (activeHandle.includes("s")) {
        boxY1 = Math.max(boxY0 + 2, Math.min(imgNaturalHeight, startBoxY1 + deltaY));
      }
      if (activeHandle.includes("n")) {
        boxY0 = Math.max(0, Math.min(boxY1 - 2, startBoxY0 + deltaY));
      }
    }

    updateBBoxUI();
  });

  // Pointer Up
  activeOverlay.addEventListener("pointerup", (e: PointerEvent) => {
    isDragging = false;
    activeHandle = null;
    activeOverlay.releasePointerCapture(e.pointerId);

    // Normalize coordinates so x0 < x1 and y0 < y1
    if (boxX0 > boxX1) {
      const temp = boxX0;
      boxX0 = boxX1;
      boxX1 = temp;
    }
    if (boxY0 > boxY1) {
      const temp = boxY0;
      boxY0 = boxY1;
      boxY1 = temp;
    }
    updateBBoxUI();
  });

  // Save
  if (saveBtn) {
    saveBtn.onclick = async () => {
      try {
        const x0 = Math.round(boxX0);
        const y0 = Math.round(boxY0);
        const x1 = Math.round(boxX1);
        const y1 = Math.round(boxY1);

        if (currentDetId === null) {
          if (currentImageId === null) return;
          await typedCall("CharactersService.AddDetection", AddDetectionRequestSchema, {
            imageId: BigInt(currentImageId),
            x0,
            y0,
            x1,
            y1,
          }, AddDetectionResultSchema);
          const cb = onSaveCallback;
          closeBBoxEditor();
          if (cb) cb();
        } else {
          await typedCall("CharactersService.UpdateDetectionBoundingBox", UpdateDetectionBoundingBoxRequestSchema, {
            detectionId: BigInt(currentDetId),
            x0,
            y0,
            x1,
            y1,
          }, EmptySchema);
          const cb = onSaveCallback;
          closeBBoxEditor();
          if (cb) cb();
        }
      } catch (e: any) {
        showErrorAlert("Error saving bounding box:\n" + (e.message || e));
      }
    };
  }

  // Cancel / Close
  if (cancelBtn) cancelBtn.onclick = closeBBoxEditor;
  if (closeBtn) closeBtn.onclick = closeBBoxEditor;
}
