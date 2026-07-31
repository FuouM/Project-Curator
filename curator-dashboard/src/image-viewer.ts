import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { maskPath } from "./components";
import { logJS } from "./utils";
import { getImageClickAction } from "./state";
import { callService } from "./ipc";

let currentViewerPath: string | null = null;
let currentViewerImageId: number | null = null;
let detectionsVisible = false;

const IDENTITY_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
  "#1abc9c", "#e67e22", "#34495e", "#e91e63", "#00bcd4",
];

export function openImageViewer(filepath: string, _imageId?: number) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement;
  const title = document.getElementById("image-viewer-filename");
  const overlay = document.getElementById("image-viewer-detections-overlay");

  if (!modal || !img || !title) return;

  currentViewerPath = filepath;
  currentViewerImageId = _imageId ?? null;
  title.textContent = maskPath(filepath);
  img.src = convertFileSrc(filepath);
  modal.classList.add("active");

  // Reset detections
  detectionsVisible = false;
  if (overlay) overlay.style.display = "none";
  updateDetectionButton(false);
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement | null;
  if (img) img.src = "";
  if (modal) modal.classList.remove("active");
  currentViewerPath = null;
  currentViewerImageId = null;
  detectionsVisible = false;
}

function updateDetectionButton(active: boolean) {
  const btn = document.getElementById("image-viewer-toggle-detections");
  if (!btn) return;
  if (active) {
    btn.classList.add("active");
    btn.style.background = "var(--sys-accent-light, #cce5ff)";
  } else {
    btn.classList.remove("active");
    btn.style.background = "";
  }
}

async function toggleDetections() {
  if (!currentViewerImageId) return;

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
    if (!target.closest("button") && !target.closest(".image-viewer-close") && target.tagName !== "IMG") {
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
        alert("Failed to open file: " + (err?.message || err));
      }
    }
  });

  document.getElementById("image-viewer-toggle-detections")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetections();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageViewer();
  });
}

// Re-export for use by other modules
export { getImageClickAction };
