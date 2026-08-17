/**
 * Entry point for the minipaint plugin.
 *
 * Registers the "Image Editor" sidebar tab. The tab shows the installer
 * console view when the editor runtime is missing, and hot-swaps to the
 * embedded editor iframe once `CheckPluginRuntimeInstalled` reports it present.
 *
 * The settings row (Load/Unload toggle, output dir, Browse, Load Selected) is
 * ALWAYS visible. The miniPaint runtime (bundle.js + gif.js workers + layer
 * canvases) is several hundred MB of RAM once spun up, so the editor iframe is
 * parked until the user clicks Load (or sends an asset from the info modal) —
 * the toggle then becomes Unload to tear the frame back down and reclaim memory.
 *
 * A metadata renderer injects a "Send to Editor" section into the image info
 * modal. Clicking it closes the modal, navigates to this tab, mounts the
 * editor if it is still parked, and loads that specific asset.
 *
 *   cd plugins && npm run build:minipaint
 *   cd plugins && npm run watch:minipaint
 */

import { TAB_ID, state } from "./state";
import { checkInstalled } from "./ipc";
import { renderInstaller } from "./installer";
import { mountEditor, loadAssetIntoEditor, browseOutputDir } from "./editor";
import { navigateToTab, closeInfoModal, getPluginDirs } from "../../lib";

const PH = window.PluginHost;
if (!PH) {
  console.error("minipaint: PluginHost not available; aborting.");
} else {
  // The generic .view-section is display:block with no height, so a height:100%
  // editor chain collapses (iframe drops to its default 150px). Stretch the
  // section within the flex .main-panel instead of using an absolute viewport
  // calc — the section then tracks the panel's real height.
  if (!document.getElementById("minipaint-styles")) {
    const style = document.createElement("style");
    style.id = "minipaint-styles";
    style.textContent = `
      #view-extensions-minipaint.active {
        display: flex !important;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }

  const { pluginDir, workspaceRoot } = getPluginDirs();

  // Editor lifecycle is hoisted to module scope so both the tab's toggle and
  // the info-modal "Send to Editor" button share one mount/unmount path.
  let editorHost: HTMLElement | null = null;
  let toggleBtn: HTMLButtonElement | null = null;
  let editorMounted = false;
  let teardown: (() => void) | null = null;

  const updateToggle = () => {
    if (!toggleBtn) return;
    toggleBtn.innerHTML = editorMounted
      ? '<i class="bi bi-stop-circle"></i> Unload Editor'
      : '<i class="bi bi-play-circle"></i> Load Editor';
  };

  // Mount the editor if it is parked. When `initialPath` is provided and the
  // editor was already live, the asset is pushed straight in (no remount).
  const ensureEditor = (initialPath?: string): void => {
    if (editorMounted) {
      if (initialPath) loadAssetIntoEditor(initialPath);
      return;
    }
    if (!editorHost) return;
    teardown = mountEditor(pluginDir, workspaceRoot, editorHost, initialPath);
    editorMounted = true;
    updateToggle();
  };

  const unloadEditor = (): void => {
    teardown?.();
    teardown = null;
    editorMounted = false;
    updateToggle();
  };

  // ── Image info modal — "Send to Editor" section ─────────────────────────
  PH.registerMetadataRenderer("minipaint-send", (asset) => {
    if (!asset?.path) return null;

    const box = document.createElement("div");
    box.className = "group-box";
    box.style.cssText = "margin-top:8px;";
    box.innerHTML =
      '<div class="group-box-title"><i class="bi bi-palette"></i> Image Editor</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">' +
      '  <span style="font-size:11px;color:#555;flex:1;">Open this image in the miniPaint editor.</span>' +
      '  <button type="button" class="win-button" id="minipaint-send-asset">' +
      '    <i class="bi bi-brush"></i> Send to Editor' +
      "  </button>" +
      "</div>";

    box
      .querySelector<HTMLButtonElement>("#minipaint-send-asset")
      ?.addEventListener("click", () => {
        closeInfoModal();
        if (PH.loadTab) PH.loadTab(TAB_ID);
        navigateToTab(TAB_ID);
        ensureEditor(asset.path);
      });

    return box;
  });

  PH.registerTab(TAB_ID, "Image Editor", "bi bi-palette", () => {
    const rootEl = document.createElement("div");
    rootEl.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;";

    // ── Settings row (always visible) ─────────────────────────────────────
    const settingsBox = document.createElement("div");
    settingsBox.className = "group-box";
    settingsBox.style.cssText = "padding:8px;flex-shrink:0;";

    const title = document.createElement("div");
    title.className = "group-box-title";
    title.innerHTML = '<i class="bi bi-gear"></i> miniPaint Settings';

    const settingsRow = document.createElement("div");
    settingsRow.style.cssText = "display:flex;align-items:center;gap:8px;";

    const outputLabel = document.createElement("span");
    outputLabel.style.cssText = "font-size:11px;color:#555;";
    outputLabel.textContent = "Output Directory:";

    const outputInput = document.createElement("input");
    outputInput.type = "text";
    outputInput.className = "win-input";
    outputInput.value = state.outputDir || `${workspaceRoot}\\edited`;
    outputInput.style.cssText = "flex:1;font-size:11px;";
    outputInput.readOnly = true;

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "win-button";
    browseBtn.style.cssText = "font-size:11px;";
    browseBtn.innerHTML = '<i class="bi bi-folder2-open"></i> Browse';
    browseBtn.addEventListener("click", () => {
      browseOutputDir((dir) => { outputInput.value = dir; });
    });

    // Load/Unload toggle button
    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "win-button";
    toggleBtn.style.cssText = "font-size:11px;";
    updateToggle();
    toggleBtn.addEventListener("click", () => {
      if (editorMounted) {
        unloadEditor();
      } else {
        ensureEditor();
        if (installerEl) {
          installerEl.style.display = "none";
          installerEl = null;
        }
      }
    });

    settingsRow.appendChild(toggleBtn);
    settingsRow.appendChild(outputLabel);
    settingsRow.appendChild(outputInput);
    settingsRow.appendChild(browseBtn);

    settingsBox.appendChild(title);
    settingsBox.appendChild(settingsRow);

    // ── Editor host ──────────────────────────────────────────────────────
    editorHost = document.createElement("div");
    editorHost.style.cssText =
      "display:flex;flex-direction:column;width:100%;flex:1;min-height:0;";

    // When the editor runtime is missing, the installer replaces the settings
    // row. The installer lives in its own placeholder so a post-install retry
    // never wipes the editor host.
    const launcherHost = document.createElement("div");
    launcherHost.style.cssText = "display:flex;flex-direction:column;width:100%;min-height:0;";

    let installerEl: HTMLElement | null = null;

    const onInstallComplete = () => {
      launcherHost.appendChild(settingsBox);
      ensureEditor();
    };

    const loadContent = () => {
      launcherHost.innerHTML = "";
      installerEl = null;
      checkInstalled().then((installed) => {
        if (installed) {
          launcherHost.appendChild(settingsBox);
          const shouldAutoload = PH.isAutoloadEnabled ? PH.isAutoloadEnabled(TAB_ID) : true;
          if (shouldAutoload) {
            ensureEditor();
          } else {
            unloadEditor();
          }
        } else {
          installerEl = renderInstaller(onInstallComplete);
          launcherHost.appendChild(installerEl);
        }
      });
    };

    loadContent();
    rootEl.appendChild(launcherHost);
    rootEl.appendChild(editorHost);
    return rootEl;
  }, true);
}