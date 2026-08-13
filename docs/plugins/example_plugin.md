# Complete Working Reference Implementation & Verification Checklist

## 1. Complete Working Reference Implementation (`plugins/example-plugin/index.js`)

Below is a complete, self-contained template for creating a new Project Curator plugin:

```javascript
(function () {
  "use strict";

  var PH = window.PluginHost;
  if (!PH) {
    console.error("My Plugin: PluginHost API unavailable.");
    return;
  }

  var TAB_ID = "my-sample-plugin";

  function renderPluginTab() {
    var wrapper = document.createElement("div");
    wrapper.style.cssText = "display: flex; flex-direction: column; height: calc(100vh - 130px); gap: 10px; box-sizing: border-box;";

    wrapper.innerHTML = `
      <div class="group-box" style="margin-bottom: 0; padding: 8px 12px;">
        <div class="group-box-title"><i class="bi bi-tools"></i> Sample Plugin Toolbar</div>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
          <button type="button" class="win-button primary" id="sample-action-btn">
            <i class="bi bi-play-fill"></i> Process Selection
          </button>
        </div>
      </div>

      <div id="sample-canvas-area" style="flex: 1; position: relative; background: var(--sys-window-bg, #ffffff); border: 1px solid var(--sys-border-dark, #b0b0b0); border-radius: 2px; overflow: hidden;">
        <div class="toolbox-drop-zone" style="height: 100%; margin: 12px;">
          <div class="toolbox-drop-icon"><i class="bi bi-cloud-arrow-up"></i></div>
          <span>Drag & Drop File Here</span>
        </div>
      </div>
    `;

    setTimeout(function () {
      var actionBtn = wrapper.querySelector("#sample-action-btn");
      if (actionBtn) {
        actionBtn.addEventListener("click", function () {
          PH.getSelectionAssetContexts().then(function (selection) {
            alert("Loaded " + selection.length + " selected assets.");
          });
        });
      }
    }, 0);

    return wrapper;
  }

  // Register Capabilities
  PH.registerTab(TAB_ID, "Sample Plugin", "bi bi-tools", renderPluginTab);

  PH.registerContextMenuItem("sample-ctx-action", "Sample Plugin Action", function (asset) {
    alert("Target asset path: " + asset.path);
  });

  console.log("Sample Plugin initialized.");
})();
```

---

## 2. Verification Checklist Before Committing

When authoring or modifying a plugin, verify the following points:

- [ ] `manifest.json` specifies `"ui:inject"` under `permissions` and points to `"index.js"`.
- [ ] Script bundle is wrapped in a self-executing IIFE `(function () { ... })();`.
- [ ] Local asset file paths are converted using `PluginHost.convertFileSrc(path)` before assignment to `src`.
- [ ] Interface strictly uses WinForms Desktop Control controls (`.group-box`, `.win-button`, `.toolbox-drop-zone`).
- [ ] No emojis are present; official Bootstrap Icon markup `<i class="bi bi-..."></i>` is used throughout.
- [ ] Drag-and-drop handles Tauri v2 native drops via `window.__TAURI__.webview.getCurrentWebview().onDragDropEvent`.
- [ ] High-frequency interactions (zooming, panning, sliding) run via `requestAnimationFrame` with zero DOM reconstruction.
- [ ] Long-running background jobs use non-destructive collision resolution (`getUniqueOutputPath`) and async status polling.
- [ ] Post-mount DOM initializers run inside `setTimeout(fn, 0)`.
- [ ] Frontend build test passes (`cd curator-dashboard; npm run build` exits with code 0).
