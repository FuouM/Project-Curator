/**
 * Generic Tauri v2 native drag-and-drop zone setup.
 *
 * All four plugins (image-converter, ffmpeg-transcoder, image-compare,
 * gif-maker) implemented near-identical `onDragDropEvent` listeners. The
 * key differences were:
 *   - image-compare has TWO drop zones (Slot A, Slot B) and needs to know
 *     which zone received the drop.
 *   - image-compare used a `tauriDropBound` guard against duplicate attachment.
 *
 * This implementation handles both cases via:
 *   - `dropZoneIds` accepts a single string or an array for multi-zone support.
 *   - `onFiles` receives the hit zone's ID so callers can route accordingly.
 *   - A module-level `boundTabs` set prevents duplicate listener registration.
 *
 * Standard HTML5 `e.dataTransfer.files` is suppressed by Windows WebView2
 * security policies; all plugins must use this Tauri-native API instead.
 *
 * Used by: image-converter, ffmpeg-transcoder, image-compare, gif-maker
 *
 * @example
 * // Single drop zone (image-converter, ffmpeg-transcoder, gif-maker):
 * setupDropZone(TAB_ID, "converter-drop-zone", (paths) => {
 *   paths.forEach(addToQueue);
 * });
 *
 * @example
 * // Two drop zones (image-compare):
 * setupDropZone(TAB_ID, ["compare-slot-a", "compare-slot-b"], (paths, hitId) => {
 *   if (hitId === "compare-slot-a") setSlotA(paths[0]);
 *   else if (hitId === "compare-slot-b") setSlotB(paths[0]);
 * });
 */

/** Track tabs that already have a listener to prevent duplicate attachment. */
const boundTabs = new Set<string>();

export function setupDropZone(
  tabId: string,
  dropZoneIds: string | string[],
  onFiles: (paths: string[], hitZoneId: string | null) => void,
): void {
  const api = window.__TAURI__;
  if (!api?.webview?.getCurrentWebview) return;

  // Guard against duplicate listener registration (e.g. if renderTab is
  // called more than once during a plugin re-init cycle).
  if (boundTabs.has(tabId)) return;
  boundTabs.add(tabId);

  const ids = Array.isArray(dropZoneIds) ? dropZoneIds : [dropZoneIds];

  api.webview.getCurrentWebview().onDragDropEvent((event) => {
    // Ignore events while this plugin's tab is not the active view.
    const tabEl = document.getElementById(`view-extensions-${tabId}`);
    if (!tabEl?.classList.contains("active")) return;

    const drop = event.payload;

    /** Return the ID of whichever registered drop zone the cursor is over. */
    const getHitZoneId = (): string | null => {
      const pos = drop.position;
      if (!pos || typeof pos.x !== "number") return null;
      const cx = pos.x / window.devicePixelRatio;
      const cy = pos.y / window.devicePixelRatio;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit) return null;
      for (const id of ids) {
        const zone = document.getElementById(id);
        if (zone && (zone === hit || zone.contains(hit))) return id;
      }
      return null;
    };

    if (drop.type === "enter" || drop.type === "over") {
      const hitId = getHitZoneId();
      for (const id of ids) {
        const zone = document.getElementById(id);
        if (!zone) continue;
        if (id === hitId) zone.classList.add("toolbox-drop-active");
        else zone.classList.remove("toolbox-drop-active");
      }
    } else if (drop.type === "leave") {
      for (const id of ids) {
        document.getElementById(id)?.classList.remove("toolbox-drop-active");
      }
    } else if (drop.type === "drop") {
      const hitId = getHitZoneId();
      for (const id of ids) {
        document.getElementById(id)?.classList.remove("toolbox-drop-active");
      }
      const paths = drop.paths ?? [];
      if (paths.length > 0) {
        onFiles(paths, hitId);
      }
    }
  });
}
