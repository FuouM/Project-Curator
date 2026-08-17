/**
 * Entry point for the gif-maker plugin.
 */

import { TAB_ID, state } from "./state";
import { logConsole, renderDroppedFrames, pushHistoryState, renderGifMakerTab } from "./ui";

const PH = window.PluginHost;
if (!PH) {
  console.error("gif-maker: PluginHost not available; aborting.");
} else {
  // Register main tab
  PH.registerTab(TAB_ID, "GIF Maker", "bi bi-film", renderGifMakerTab);

  // Register Toolbar Button in main Gallery
  PH.registerToolbarButton("gif-maker-create", "Create GIF", "bi bi-film", (selection) => {
    if (!selection || selection.length === 0) return;
    const tab = document.getElementById("tab-view-extensions-" + TAB_ID);
    if (tab) {
      tab.click();
    }
    if (state.currentTool === "maker") {
      state.droppedFrames = selection.map((asset) => asset.path);
      logConsole(`Loaded ${state.droppedFrames.length} frames from selection.`, "success");
      renderDroppedFrames();
    } else {
      void pushHistoryState(selection[0].path, "Imported selected file");
    }
  });

  console.log("gif-maker plugin initialized successfully.");
}
