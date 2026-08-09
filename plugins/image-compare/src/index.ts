/**
 * Entry point for the image-compare plugin.
 */

import { TAB_ID } from "./state";
import {
  loadAssetIntoSlot,
  closeInfoModal,
  navigateToTab,
  renderCompareTab,
} from "./ui";

const PH = window.PluginHost;
if (!PH) {
  console.error("image-compare: PluginHost not available; aborting.");
} else {
  // Register Capabilities
  PH.registerTab(TAB_ID, "Image Compare", "bi bi-layout-split", renderCompareTab);

  // Metadata Section Buttons inside Image Info Modal
  PH.registerMetadataRenderer("image-compare-modal-section", (asset) => {
    if (!asset || !asset.path) return null;
    const box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-layout-split"></i> Image Compare</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Send image to Image Compare tool.</span>' +
      '  <button type="button" class="win-button" id="cmp-send-slot-a">' +
      '    <i class="bi bi-arrow-left-square"></i> Set as Image A' +
      '  </button>' +
      '  <button type="button" class="win-button" id="cmp-send-slot-b">' +
      '    <i class="bi bi-arrow-right-square"></i> Set as Image B' +
      '  </button>' +
      '</div>';

    const btnA = box.querySelector("#cmp-send-slot-a");
    btnA?.addEventListener("click", () => {
      loadAssetIntoSlot("A", asset);
      closeInfoModal();
      navigateToTab();
    });

    const btnB = box.querySelector("#cmp-send-slot-b");
    btnB?.addEventListener("click", () => {
      loadAssetIntoSlot("B", asset);
      closeInfoModal();
      navigateToTab();
    });

    return box;
  });

  // Toolbar Button ("Compare Selected") for grid toolbars
  PH.registerToolbarButton("compare-selected", "Compare Selected", "bi bi-layout-split", (selection) => {
    if (!selection || selection.length === 0) {
      alert("No images selected.");
      return;
    }
    if (selection.length >= 2) {
      loadAssetIntoSlot("A", selection[0]);
      loadAssetIntoSlot("B", selection[1]);
    } else {
      loadAssetIntoSlot("A", selection[0]);
    }
    closeInfoModal();
    navigateToTab();
  });

  // Context Menu Items
  PH.registerContextMenuItem("send-to-compare-a", "Compare: Set as Image A", (asset) => {
    if (!asset) return;
    loadAssetIntoSlot("A", asset);
    closeInfoModal();
    navigateToTab();
  });

  PH.registerContextMenuItem("send-to-compare-b", "Compare: Set as Image B", (asset) => {
    if (!asset) return;
    loadAssetIntoSlot("B", asset);
    closeInfoModal();
    navigateToTab();
  });

  console.log("Image Compare plugin initialized successfully.");
}
