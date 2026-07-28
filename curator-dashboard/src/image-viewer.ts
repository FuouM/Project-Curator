import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { maskPath } from "./components";
import { logJS } from "./utils";
import { getImageClickAction } from "./state";

let currentViewerPath: string | null = null;

export function openImageViewer(filepath: string, _imageId?: number) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement;
  const title = document.getElementById("image-viewer-filename");

  if (!modal || !img || !title) return;

  currentViewerPath = filepath;
  title.textContent = maskPath(filepath);
  img.src = convertFileSrc(filepath);
  modal.classList.add("active");
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement | null;
  if (img) img.src = "";
  if (modal) modal.classList.remove("active");
  currentViewerPath = null;
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageViewer();
  });
}

// Re-export for use by other modules
export { getImageClickAction };
