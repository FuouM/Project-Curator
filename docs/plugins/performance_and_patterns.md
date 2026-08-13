# Performance, GPU Compositing & Architectural Patterns for Plugins

To guarantee sub-10ms UI responsiveness, high-frequency interaction tools (such as image comparison sliders, croppers, or interactive canvas tools) must observe strict performance practices.

---

## 1. Performance & GPU Compositing Patterns

### 1. Zero DOM Rebuild Interaction Loops

Never recreate or replace DOM nodes during active mouse drag or wheel zoom events. Cache DOM references upon initial view creation and mutate properties inside a single `requestAnimationFrame` loop.

```javascript
var rafPending = false;

function scheduleUpdate() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(function () {
    rafPending = false;
    applyGpuTransforms();
  });
}
```

### 2. Smooth Layer Clipping (No Image Decoder Texture Flicker)

In WebKit/Chromium, applying dynamic `clip-path` mutations directly to an `<img>` element with `object-fit: contain` forces hardware decoder texture re-allocation, causing visible flickering and aspect-ratio glitching.

**Rule**: Wrap `<img>` tags inside a plain DOM `<div>` wrapper, and apply `clip-path` mutations **only** to the plain `<div>` wrapper.

```html
<!-- CORRECT: Plain <div> layer receives GPU clip-path transform -->
<div id="layer-b-wrapper" style="position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 50% 0 0); will-change: clip-path;">
  <div style="position: absolute; inset: 0; padding: 12px; display: flex; align-items: center; justify-content: center;">
    <img src="..." style="max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none;" />
  </div>
</div>
```

### 3. Screen-Space Overlay Positioning

Interactive UI handles, badges, or overlays should **never** be nested inside scaled/transformed image DOM containers. Position them in top-level viewport screen coordinates using forward matrix transformation equations:

$$\text{center} = \frac{\text{viewportWidth}}{2}$$
$$\text{localX} = \text{viewportWidth} \times \frac{\text{splitPercentage}}{100}$$
$$\text{screenX} = (\text{localX} - \text{center}) \times \text{zoom} + \text{center} + \text{panX}$$

---

## 2. Critical Lessons & Architectural Patterns Learned from Existing Core Plugins

### Pattern 1: Non-Destructive File Collision Resolution

Both `image-converter` and `ffmpeg-transcoder` process output files without overwriting existing files or corrupting library source assets.

```javascript
async function checkFileExists(path) {
  var resp = await PH.callService("PathExists", { path: path });
  return !!(resp && resp.PathExistsResult && resp.PathExistsResult.exists);
}

async function getUniqueOutputPath(sourcePath, outputDir, targetExt) {
  var base = sourcePath.split(/[\\/]/).pop();
  var stem = base.substring(0, base.lastIndexOf('.')) || base;
  var sep = outputDir.indexOf('\\') !== -1 ? '\\' : '/';
  var cleanOutDir = outputDir.replace(/[\\/]+$/, '');

  var n = 0;
  while (true) {
    var candidateName = n === 0 ? (stem + "." + targetExt) : (stem + "_" + n + "." + targetExt);
    var candidatePath = cleanOutDir + sep + candidateName;
    if (candidatePath.toLowerCase() === sourcePath.toLowerCase()) { n++; continue; }
    var exists = await checkFileExists(candidatePath);
    if (!exists) return candidatePath;
    n++;
  }
}
```

### Pattern 2: Native Folder Picker Dialog Invocation

Plugins can trigger Tauri's native OS directory selection modal directly without web input hacks:

```javascript
if (window.__TAURI__ && window.__TAURI__.core) {
  window.__TAURI__.core.invoke("select_path", { isDirectory: true }).then(function (selectedPath) {
    if (selectedPath) {
      console.log("Selected folder:", selectedPath);
    }
  });
}
```

### Pattern 3: Asynchronous Long-Running Task Polling (`GetTranscodeProgress`)

For heavy CPU/GPU operations (video transcode, model export, batch processing), spawn the task via IPC, get a `job_id`, and poll progress using `setTimeout` recursion:

```javascript
function pollTaskProgress(jobId, doneCallback) {
  var tick = async function () {
    var resp = await PH.callService("GetTranscodeProgress", { job_id: jobId });
    var progress = resp && resp.TranscodeProgressResult;
    if (!progress) return doneCallback(false);

    updateProgressBar(progress.percent);

    if (!progress.running) {
      return doneCallback(progress.percent >= 100);
    }
    setTimeout(tick, 500);
  };
  tick();
}
```

### Pattern 4: Fast Queue Deduplication & Filename Disambiguation

Maintain an array (`queue = []`) alongside a hash set (`inQueue = {}`) for $O(1)$ deduplication. If multiple queued files share identical filenames (e.g., `image.png`), display `parent_folder/image.png` in the list to prevent user ambiguity:

```javascript
var basenames = {};
queue.forEach(function (path) {
  var base = path.split(/[\\/]/).pop();
  basenames[base] = (basenames[base] || 0) + 1;
});

var displayLabel = base;
if (basenames[base] > 1) {
  var parentDir = parts[parts.length - 2];
  displayLabel = (parentDir ? parentDir + "/" : "") + base;
}
```

### Pattern 5: Embedded Diagnostic Terminal Log Box

Implement a WinForms dark diagnostic log console (`#1e1e1e` background, `'Consolas', monospace` font) that mirrors system logs (`#10b981` success, `#f87171` error, `#cccccc` info) and auto-scrolls on new log output:

```javascript
function appendLog(message, kind) {
  var box = document.getElementById("plugin-log-box");
  if (!box) return;
  var colors = { info: "#cccccc", success: "#10b981", error: "#f87171" };
  var line = document.createElement("div");
  line.style.cssText = "font-family: 'Consolas', monospace; font-size: 11px; color: " + (colors[kind] || colors.info);
  line.textContent = message;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
```

### Pattern 6: Deferred Mounting Initializer (`setTimeout(fn, 0)`)

In `renderTab()`, because the DOM node is detached while the factory function constructs it, `document.getElementById(...)` queries inside component setup subroutines will return `null`.

**Fix**: Wrap post-mount initialization inside `setTimeout(..., 0)` so it runs immediately after the Plugin Host appends the tab container to `document.body`:

```javascript
function renderTab() {
  var container = document.createElement("div");
  container.innerHTML = "<!-- Tab HTML -->";

  setTimeout(function () {
    // Runs after tab DOM node is attached to #view-extensions-my-plugin-id
    setupDropZone();
    updateQueueList();
  }, 0);

  return container;
}
```

### Pattern 7: Seamless Cross-Tab Navigation & Modal Closure

When triggering plugin actions from right-click context menus or modal action buttons, close the open modal and switch active view tab automatically:

```javascript
function navigateToPluginTab(tabId) {
  // Close active modal if open
  var modal = document.getElementById("image-info-modal");
  if (modal && modal.classList.contains("active")) {
    var closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) closeBtn.click();
    else modal.classList.remove("active");
  }

  // Click sidebar navigation item
  var navItem = document.querySelector('.nav-item[data-view="extensions-' + tabId + '"]');
  if (navItem) navItem.click();
}
```

### Pattern 8: Settings Persistence via Browser `localStorage`

Persist user preferences (such as quality modes, custom CLI arguments, or verbose toggles) across app reloads using `localStorage`:

```javascript
var savedMode = localStorage.getItem("my-plugin-mode") || "default";

function setMode(newMode) {
  savedMode = newMode;
  localStorage.setItem("my-plugin-mode", newMode);
}
```

### Pattern 9: Full-Height Plugin Tabs (`.view-section` Height Collapse)

The generic plugin container `#view-extensions-<id>` is `.view-section`, which is `display: block` with **no height** (see `curator-dashboard/src/styles/layout.css`). A `height: 100%` chain inside it therefore collapses — a plugin iframe drops to its default ~150px, and `flex: 1` children have nothing to stretch against.

**Fix**: inject a scoped stylesheet that turns the section into a stretching flex column inside the flex `.main-panel`:

```javascript
// index.ts, before registering the tab
if (!document.getElementById("my-plugin-styles")) {
  var style = document.createElement("style");
  style.id = "my-plugin-styles";
  style.textContent =
    "#view-extensions-my-plugin-id.active {" +
    "  display: flex !important;" +
    "  flex-direction: column;" +
    "  flex: 1;" +
    "  min-height: 0;" +
    "  overflow: hidden !important;" +
    "}";
  document.head.appendChild(style);
}
```

- Prefer `flex: 1; min-height: 0` over the legacy `calc(100vh - Npx)` approach — it tracks the panel's real height and avoids magic numbers.
- Reference implementations: `plugins/minipaint/src/index.ts` (minipaint styles) and `plugins/gif-maker/src/ui.ts` `injectStyles()`.

### Pattern 10: Surfacing Console Errors from a Cross-Origin iframe

A plugin that embeds a third-party editor in an `asset.localhost` iframe cannot rely on its own `console.error` being visible: the iframe console is effectively hidden and the frame is cross-origin to the host, so uncaught errors die silently. When diagnosing "it does nothing" reports from iframed tools (e.g. miniPaint GIF export), always relay errors to the host first.

**Fix** (inside the injected in-iframe bridge script):

```javascript
function reportError(message, detail) {
  try { window.parent.postMessage({ type: "minipaint:console-error", message: String(message), detail: detail ? String(detail) : "" }, "*"); }
  catch (e) { /* host unreachable */ }
}
window.addEventListener("error", function (ev) {
  var detail = ev.error && ev.error.stack ? ev.error.stack : (ev.filename + ":" + ev.lineno);
  reportError(ev.message || "Uncaught error", detail);
});
window.addEventListener("unhandledrejection", function (ev) {
  var r = ev.reason;
  reportError("Unhandled promise rejection", r && r.stack ? r.stack : String(r));
});
```

Host side receives it in the existing bridge `onMessage` handler and logs to the dashboard console:

```typescript
if (d.type === "minipaint:console-error") {
  console.error(`[minipaint iframe] ${d.message || "unknown error"}${d.detail ? "\n" + d.detail : ""}`);
  return;
}
```

- Combine with an injected `<script src="...">` for any encoder/worker library (e.g. gif.js) that the host cannot reach through module scope — load it early, poll for the global, and fail loud if it never appears.
- Reference implementation: `plugins/minipaint/curator-bridge.js` + `plugins/minipaint/src/editor.ts`.

### Pattern 11: Fixing `willReadFrequently` Canvas Readback Lag in Embedded Editors

When an iframed editor is readback-heavy (filters, blend modes, layer compositing, GIF/export pixel reads), WebView2 logs `Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true` and the app visibly lags. The warning is not cosmetic: each `getImageData` on a context that keeps a GPU-backed surface forces a slow GPU→CPU copy, and miniPaint does this constantly.

**Fix**: wrap `getContext` in the injected in-iframe bridge **before** the editor's `load`-time init creates any canvases, and force the flag for `"2d"` contexts:

```javascript
(function patchCanvasContexts() {
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    var args = arguments;
    if (type === "2d") {
      if (args.length > 1 && args[1] && typeof args[1] === "object") {
        if (!("willReadFrequently" in args[1])) {
          args = [type, Object.assign({ willReadFrequently: true }, args[1])];
        }
      } else {
        args = [type, { willReadFrequently: true }];
      }
    }
    return origGetContext.apply(this, args);
  };
})();
```

- Ordering matters: the bridge tag must be injected before the editor creates its first canvas (miniPaint's app init runs on `window.load`, and the bridge is injected before `</body>`, so the patch wins). Preserve any options object the caller already passed (`alpha`, etc.).
- Only patch `"2d"` — leave `"webgl"`/`"webgl2"` contexts untouched.
- Reference implementation: `plugins/minipaint/curator-bridge.js`.
