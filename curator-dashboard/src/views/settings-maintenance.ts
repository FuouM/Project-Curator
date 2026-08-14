import { typedCall } from "../ipc";
import { setStatusMessage } from "../utils";
import { ClearThumbnailCacheResultSchema, PurgeResultSchema } from "../gen/gallery_pb";
import { BackfillResultSchema, MediaMetadataBackfillResultSchema } from "../gen/import_pb";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { clearAllCropCaches } from "../crop-cache";

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
      const resp = await typedCall("GalleryService.ClearThumbnailCache", null, null, ClearThumbnailCacheResultSchema);
      setStatusMessage(clearThumbStatus, `Done! ${resp.deletedCount} cached thumbnail(s) removed.`, "success");
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
      const resp = await typedCall("GalleryService.PurgeMissingThumbnails", null, null, PurgeResultSchema);
      setStatusMessage(purgeStatus, `Done! ${resp.deletedCount} thumbnail(s) removed.`, "success");
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
      const resp = await typedCall("ImportService.BackfillImageFolders", null, null, BackfillResultSchema);
      const count = resp.imagesBackfilled;
      setStatusMessage(backfillStatus, `Done! ${count} image(s) assigned to folders.`, "success");
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
      const resp = await typedCall("ImportService.BackfillMediaMetadata", null, null, MediaMetadataBackfillResultSchema);
      const { processed, updated } = resp;
      setStatusMessage(backfillMediaStatus, `Done! ${updated} image(s) updated (${processed} scanned).`, "success");
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
      await typedCall("CharactersService.ClearCropCache", null, null, EmptySchema);
      clearAllCropCaches();
      setStatusMessage(clearCropCacheStatus, "Crop cache cleared successfully.", "success");
    } catch (e: any) {
      setStatusMessage(clearCropCacheStatus, "Error: " + (e.message || e), "error");
    }
    clearCropCacheBtn.removeAttribute("disabled");
  });
}

