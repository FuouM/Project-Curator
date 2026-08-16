/**
 * Entry point for the aria2-downloader plugin.
 *
 * Registers the "Aria2 Downloader" tab and boots the plugin's state,
 * tool check, and download history. All commands it issues go through the
 * curator-provided generic IPC surface (§3.4 of PLAN_ARIA2_DOWNLOADER.md);
 * the plugin never registers its own gRPC services.
 */

import { TAB_ID } from "./state";
import { bootstrap, renderTab } from "./ui";

const PH = window.PluginHost;
if (!PH) {
  console.error("aria2-downloader: PluginHost not available; aborting.");
} else {
  PH.registerTab(TAB_ID, "Aria2 Downloader", "bi bi-cloud-arrow-down", renderTab);
  void bootstrap();
  console.log("aria2-downloader: registered tab and bootstrapped.");
}
