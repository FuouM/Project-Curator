import { LruCache } from "./lru-cache";

// --- Crop Cache (LRU, limited to 2000 entries) ---
const cropCache = new LruCache<string>(2000);
// Generation guard so stale async crop responses (started before an edit)
// can never overwrite a freshly invalidated/refetched cache entry.
const cropRevision = new Map<number, number>();

function cacheCrop(detectionId: number, url: string) {
  cropCache.set(detectionId, url);
}

export function hasCachedCrop(detectionId: number): boolean {
  return cropCache.has(detectionId);
}

export function getCropRevision(detectionId: number): number {
  return cropRevision.get(detectionId) || 0;
}

export function getCachedCrop(detectionId: number): string | undefined {
  return cropCache.get(detectionId);
}

export function setCachedCrop(detectionId: number, url: string) {
  cacheCrop(detectionId, url);
}

export function invalidateCropCache(detectionId: number) {
  cropCache.delete(detectionId);
  cropRevision.set(detectionId, (cropRevision.get(detectionId) || 0) + 1);
}

export function clearAllCropCaches() {
  cropCache.clear();
  cropRevision.clear();
}