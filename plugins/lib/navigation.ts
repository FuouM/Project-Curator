/**
 * Navigation helpers for cross-tab routing and modal management.
 *
 * Every plugin that integrates with the image info modal and the sidebar
 * tab system carried identical copies of these two helpers. This is the
 * canonical shared version.
 *
 * Used by: image-converter, ffmpeg-transcoder, image-compare, gif-maker
 */

/**
 * Switches the UI to the plugin's extension tab by programmatically clicking
 * its sidebar nav item.
 *
 * @param tabId - The tab ID passed to `PluginHost.registerTab()` (e.g.
 *                `"image-converter"`). The nav item is looked up via the
 *                selector `.nav-item[data-view="extensions-<tabId>"]`.
 */
export function navigateToTab(tabId: string): void {
  const item = document.querySelector<HTMLElement>(
    `.nav-item[data-view="extensions-${tabId}"]`
  );
  if (item) item.click();
}

/**
 * Closes the image info modal if it is currently open.
 *
 * Prefers the modal's own `.modal-close` button so any registered close
 * handlers fire correctly. Falls back to removing the `active` class
 * directly if no close button is found.
 */
export function closeInfoModal(): void {
  const modal = document.getElementById("image-info-modal");
  if (!modal?.classList.contains("active")) return;
  const closeBtn = modal.querySelector<HTMLElement>(".modal-close");
  if (closeBtn) closeBtn.click();
  else modal.classList.remove("active");
}
