/**
 * Shared DOM/console utilities for the gif-maker plugin.
 *
 * Centralizes the module-scoped `PluginHost` bridge, the `el` helper, and the
 * on-screen console logger so the decomposed feature modules (`timeline.ts`,
 * `effects.ts`, `export.ts`, `history.ts`, `toolbox.ts`, `ui.ts`) do not
 * re-declare them.
 */

import { createLogger } from "../../lib";

/** Module-scoped PluginHost bridge shared by every gif-maker module. */
export const PH = window.PluginHost;

/** Typed `document.getElementById` helper. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Logger bound to the plugin's on-screen output log (`#gm-console`). */
export const logConsole = createLogger("gm-console");
