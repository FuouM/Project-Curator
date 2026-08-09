/**
 * Entry point for the image-converter plugin.
 *
 * Imports all modules and registers the plugin's capabilities with the
 * PluginHost. esbuild bundles this (and its imports) into the root index.js
 * IIFE when you run:
 *
 *   cd plugins && npm run build:image-converter
 *
 * For active development with auto-rebuild on save:
 *
 *   cd plugins && npm run watch:image-converter
 */

import { TAB_ID } from "./state";
import {
  addToQueue,
  closeInfoModal,
  log,
  navigateToTab,
  renderTab,
} from "./ui";

const PH = window.PluginHost;
if (!PH) {
  console.error("image-converter: PluginHost not available; aborting.");
} else {
  // ── Sidebar tab ───────────────────────────────────────────────────────────
  PH.registerTab(TAB_ID, "Image Converter", "bi bi-arrow-repeat", renderTab);

  // ── Image info modal — "Send to Converter" section ────────────────────────
  PH.registerMetadataRenderer("image-converter-send", (asset) => {
    if (!asset?.path) return null;

    const box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-arrow-repeat"></i> Image Converter</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Queue this image for batch conversion.</span>' +
      '  <button type="button" class="win-button" id="converter-send-asset">' +
      '    <i class="bi bi-send"></i> Send to Converter' +
      "  </button>" +
      "</div>";

    box
      .querySelector<HTMLButtonElement>("#converter-send-asset")
      ?.addEventListener("click", () => {
        addToQueue(asset.path);
        log(`Sent to converter: ${asset.path}`, "info");
        closeInfoModal();
        navigateToTab();
      });

    return box;
  });

  // ── Gallery toolbar — "Convert Selected" button ───────────────────────────
  PH.registerToolbarButton(
    "image-converter-selection",
    "Convert Selected",
    "bi bi-arrow-repeat",
    (selection) => {
      const paths = (selection ?? []).map((a) => a.path).filter(Boolean);
      if (paths.length === 0) return;
      paths.forEach(addToQueue);
      closeInfoModal();
      navigateToTab();
    }
  );

  // ── Right-click context menu ───────────────────────────────────────────────
  PH.registerContextMenuItem(
    "image-converter-ctx",
    "Send to Converter",
    (asset) => {
      if (!asset?.path) return;
      addToQueue(asset.path);
      closeInfoModal();
      navigateToTab();
    }
  );

  console.log(
    "image-converter: registered tab, renderer, toolbar button, and context menu item."
  );
}
