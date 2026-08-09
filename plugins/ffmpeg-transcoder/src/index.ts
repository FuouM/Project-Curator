/**
 * Entry point for the ffmpeg-transcoder plugin.
 */

import { TAB_ID, VIDEO_RE } from "./state";
import {
  addToQueue,
  closeInfoModal,
  log,
  navigateToTab,
  renderTab,
} from "./ui";

const PH = window.PluginHost;
if (!PH) {
  console.error("ffmpeg-transcoder: PluginHost not available; aborting.");
} else {
  PH.registerTab(TAB_ID, "FFmpeg Transcoder", "bi bi-collection-play", renderTab);

  PH.registerMetadataRenderer("ffmpeg-transcoder-send", (asset) => {
    if (!asset || !asset.path || !VIDEO_RE.test(asset.path)) return null;

    const box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-collection-play"></i> FFmpeg Transcoder</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Queue this video for transcoding.</span>' +
      '  <button type="button" class="win-button" id="transcoder-send-asset">' +
      '    <i class="bi bi-send"></i> Send to Transcoder' +
      '  </button>' +
      '</div>';

    const sendBtn = box.querySelector("#transcoder-send-asset");
    sendBtn?.addEventListener("click", () => {
      addToQueue(asset.path);
      log("Sent to transcoder: " + asset.path, "info");
      closeInfoModal();
      navigateToTab();
    });
    return box;
  });

  PH.registerToolbarButton("ffmpeg-transcoder-selection", "Transcode Selected", "bi bi-collection-play", (selection) => {
    const paths = (selection || []).map((a) => a.path).filter(Boolean);
    if (paths.length === 0) return;
    paths.forEach(addToQueue);
    closeInfoModal();
    navigateToTab();
  });

  PH.registerContextMenuItem("ffmpeg-transcoder-ctx", "Send to Transcoder", (asset) => {
    if (!asset || !asset.path) return;
    addToQueue(asset.path);
    closeInfoModal();
    navigateToTab();
  });

  console.log("ffmpeg-transcoder: registered tab, renderer, toolbar button, and context menu item.");
}
