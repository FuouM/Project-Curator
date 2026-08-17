/**
 * Shared DOM/console utilities for the aria2-downloader plugin.
 *
 * Centralizes the module-scoped `PluginHost` bridge, the `el` helper, and the
 * bottom dock logger so the decomposed feature modules (`queue.ts`,
 * `history-view.ts`, `tool-status.ts`, `chips.ts`, `log-dock.ts`, `ui.ts`) do
 * not re-declare them.
 */

import { createLogger } from "../../lib";

/** Module-scoped PluginHost bridge shared by every aria2-downloader module. */
export const PH = window.PluginHost;

/** Typed `document.getElementById` helper. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Logger bound to the plugin's terminal log box (`#ad-log`). */
export const log = createLogger("ad-log");
