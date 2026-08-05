import { callService } from "../ipc";
import { setStatusMessage } from "../utils";

export function setupMaintenanceButtons() {
  // Clear entire thumbnail cache
  const clearThumbBtn = document.getElementById("clear-thumbnail-cache-btn");
  const clearThumbStatus = document.getElementById("clear-thumbnail-status-msg");
  clearThumbBtn?.addEventListener("click", async () => {
    if (!clearThumbStatus) return;
    if (!confirm("Are you sure you want to clear the entire thumbnail cache? Thumbnails will be regenerated on demand.")) return;
    setStatusMessage(clearThumbStatus, "Clearing thumbnail cache...", "loading");
    clearThumbBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ ClearThumbnailCache: null });
      if ("ClearThumbnailCacheResult" in resp) {
        setStatusMessage(clearThumbStatus, `Done! ${resp.ClearThumbnailCacheResult.deleted_count} cached thumbnail(s) removed.`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(clearThumbStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(clearThumbStatus, "Error: " + (e.message || e), "error");
    }
    clearThumbBtn.removeAttribute("disabled");
  });

  // Purge missing thumbnails
  const purgeBtn = document.getElementById("purge-missing-thumbs-btn");
  const purgeStatus = document.getElementById("purge-status-msg");
  purgeBtn?.addEventListener("click", async () => {
    if (!purgeStatus) return;
    if (!confirm("Remove cached thumbnails for images that no longer exist on disk?")) return;
    setStatusMessage(purgeStatus, "Purging...", "loading");
    purgeBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ PurgeMissingThumbnails: null });
      if ("PurgeResult" in resp) {
        setStatusMessage(purgeStatus, `Done! ${resp.PurgeResult.deleted_count} thumbnail(s) removed.`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(purgeStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(purgeStatus, "Error: " + (e.message || e), "error");
    }
    purgeBtn.removeAttribute("disabled");
  });

  // Backfill folders button
  const backfillBtn = document.getElementById("backfill-folders-btn");
  const backfillStatus = document.getElementById("backfill-status-msg");
  backfillBtn?.addEventListener("click", async () => {
    if (!backfillStatus) return;
    setStatusMessage(backfillStatus, "Backfilling folder assignments...", "loading");
    backfillBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ BackfillImageFolders: null });
      if ("BackfillResult" in resp) {
        const count = resp.BackfillResult.images_backfilled;
        setStatusMessage(backfillStatus, `Done! ${count} image(s) assigned to folders.`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(backfillStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(backfillStatus, "Error: " + (e.message || e), "error");
    }
    backfillBtn.removeAttribute("disabled");
  });

  // Backfill media metadata button
  const backfillMediaBtn = document.getElementById("backfill-media-metadata-btn");
  const backfillMediaStatus = document.getElementById("backfill-media-metadata-status-msg");
  backfillMediaBtn?.addEventListener("click", async () => {
    if (!backfillMediaStatus) return;
    setStatusMessage(backfillMediaStatus, "Backfilling media metadata...", "loading");
    backfillMediaBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ BackfillMediaMetadata: null });
      if ("MediaMetadataBackfillResult" in resp) {
        const { processed, updated } = resp.MediaMetadataBackfillResult;
        setStatusMessage(backfillMediaStatus, `Done! ${updated} image(s) updated (${processed} scanned).`, "success");
      } else if ("Error" in resp) {
        setStatusMessage(backfillMediaStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(backfillMediaStatus, "Error: " + (e.message || e), "error");
    }
    backfillMediaBtn.removeAttribute("disabled");
  });

  // Clear crop cache button
  const clearCropCacheBtn = document.getElementById("clear-crop-cache-btn");
  const clearCropCacheStatus = document.getElementById("clear-crop-cache-status-msg");
  clearCropCacheBtn?.addEventListener("click", async () => {
    if (!clearCropCacheStatus) return;
    if (!confirm("Are you sure you want to clear all cached bounding box crops?")) return;
    setStatusMessage(clearCropCacheStatus, "Clearing crop cache...", "loading");
    clearCropCacheBtn.setAttribute("disabled", "true");
    try {
      const resp = await callService({ ClearCropCache: null });
      if ("Success" in resp) {
        const cardsModule = await import("../cards");
        cardsModule.clearAllCropCaches();
        setStatusMessage(clearCropCacheStatus, "Crop cache cleared successfully.", "success");
      } else if ("Error" in resp) {
        setStatusMessage(clearCropCacheStatus, "Failed: " + resp.Error.message, "error");
      }
    } catch (e: any) {
      setStatusMessage(clearCropCacheStatus, "Error: " + (e.message || e), "error");
    }
    clearCropCacheBtn.removeAttribute("disabled");
  });
}
