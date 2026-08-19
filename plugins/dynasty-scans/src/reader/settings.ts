/**
 * Reader session settings persisted to localStorage.
 *
 * Extracted out of `reader-controller.ts` so `reader-viewport.ts` (which also
 * reads these during render) does not need to import from the controller,
 * breaking the controller ↔ viewport import cycle.
 */

export function isAutoCacheChapterEnabled(): boolean {
  const val = localStorage.getItem("ds-auto-cache-chapter");
  return val === null || val === "1" || val === "true";
}

export function setAutoCacheChapterEnabled(enabled: boolean): void {
  localStorage.setItem("ds-auto-cache-chapter", enabled ? "1" : "0");
}

export function getPrefetchBuffer(): number {
  const val = localStorage.getItem("ds-reader-prefetch");
  if (val === null) return 0;
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : Math.max(0, Math.min(10, num));
}

export function setPrefetchBuffer(count: number): void {
  const clamped = Math.max(0, Math.min(10, count));
  localStorage.setItem("ds-reader-prefetch", String(clamped));
}