# PLUGINS_FOR_AGENTS.MD

> **Authoritative Technical Blueprint & Design Mandate for Building Project Curator Plugins**
> *This document provides AI agents and human developers with the complete architecture, API reference, performance patterns, design system rules, and architectural insights extracted from official core plugins.*

- [PLUGINS\_FOR\_AGENTS.MD](#plugins_for_agentsmd)
  - [1. Plugin Architecture \& System Overview](#1-plugin-architecture--system-overview)
    - [Key Architectural Constraints](#key-architectural-constraints)
    - [1.1. Portable Distribution \& Directory Resolution](#11-portable-distribution--directory-resolution)
    - [1.2. Core Plugin Development Philosophy](#12-core-plugin-development-philosophy)
  - [2. Directory \& Workspace Structure](#2-directory--workspace-structure)
    - [Single-file plugins (legacy / simple)](#single-file-plugins-legacy--simple)
    - [Multi-file TypeScript plugins (preferred for new work)](#multi-file-typescript-plugins-preferred-for-new-work)
    - [Downloaded/On-Demand Runtime Plugins (`install.json` variant)](#downloadedon-demand-runtime-plugins-installjson-variant)
    - [Build commands](#build-commands)
  - [3. Manifest Declaration (`manifest.json`)](#3-manifest-declaration-manifestjson)
    - [Field Specifications](#field-specifications)
  - [4. PluginHost API Reference (`window.PluginHost`)](#4-pluginhost-api-reference-windowpluginhost)
    - [TypeScript Interface Specification](#typescript-interface-specification)
    - [API Capabilities Breakdown](#api-capabilities-breakdown)
      - [1. Sidebar Navigation Tab Registration (`registerTab`)](#1-sidebar-navigation-tab-registration-registertab)
      - [2. Local Asset Path Conversion (`convertFileSrc`)](#2-local-asset-path-conversion-convertfilesrc)
      - [3. IPC Core Service Requests (`callService`)](#3-ipc-core-service-requests-callservice)
      - [4. Selection Context Queries (`getSelectionAssetContexts`)](#4-selection-context-queries-getselectionassetcontexts)
      - [5. Image Info Modal Section Injector (`registerMetadataRenderer`)](#5-image-info-modal-section-injector-registermetadatarenderer)
      - [6. Grid Toolbar \& Context Menu Actions](#6-grid-toolbar--context-menu-actions)
  - [5. UI \& Design System Guidelines (WinForms Desktop Control Mandate)](#5-ui--design-system-guidelines-winforms-desktop-control-mandate)
    - [Strict Design Rules](#strict-design-rules)
  - [6. Native Tauri v2 Drag \& Drop Integration](#6-native-tauri-v2-drag--drop-integration)
    - [Recommended Native Drop Listener Template](#recommended-native-drop-listener-template)
  - [7. Performance \& GPU Compositing Patterns](#7-performance--gpu-compositing-patterns)
    - [1. Zero DOM Rebuild Interaction Loops](#1-zero-dom-rebuild-interaction-loops)
    - [2. Smooth Layer Clipping (No Image Decoder Texture Flicker)](#2-smooth-layer-clipping-no-image-decoder-texture-flicker)
    - [3. Screen-Space Overlay Positioning](#3-screen-space-overlay-positioning)
  - [8. Critical Lessons \& Architectural Patterns Learned from Existing Core Plugins](#8-critical-lessons--architectural-patterns-learned-from-existing-core-plugins)
    - [Pattern 1: Non-Destructive File Collision Resolution](#pattern-1-non-destructive-file-collision-resolution)
    - [Pattern 2: Native Folder Picker Dialog Invocation](#pattern-2-native-folder-picker-dialog-invocation)
    - [Pattern 3: Asynchronous Long-Running Task Polling (`GetTranscodeProgress`)](#pattern-3-asynchronous-long-running-task-polling-gettranscodeprogress)
    - [Pattern 4: Fast Queue Deduplication \& Filename Disambiguation](#pattern-4-fast-queue-deduplication--filename-disambiguation)
    - [Pattern 5: Embedded Diagnostic Terminal Log Box](#pattern-5-embedded-diagnostic-terminal-log-box)
    - [Pattern 6: Deferred Mounting Initializer (`setTimeout(fn, 0)`)](#pattern-6-deferred-mounting-initializer-settimeoutfn-0)
    - [Pattern 7: Seamless Cross-Tab Navigation \& Modal Closure](#pattern-7-seamless-cross-tab-navigation--modal-closure)
    - [Pattern 8: Settings Persistence via Browser `localStorage`](#pattern-8-settings-persistence-via-browser-localstorage)
    - [Pattern 9: Full-Height Plugin Tabs (`.view-section` Height Collapse)](#pattern-9-full-height-plugin-tabs-view-section-height-collapse)
    - [Pattern 10: Surfacing Console Errors from a Cross-Origin iframe](#pattern-10-surfacing-console-errors-from-a-cross-origin-iframe)
    - [Pattern 11: Fixing `willReadFrequently` Canvas Readback Lag in Embedded Editors](#pattern-11-fixing-willreadfrequently-canvas-readback-lag-in-embedded-editors)
  - [9. Complete Working Reference Implementation (`plugins/example-plugin/index.js`)](#9-complete-working-reference-implementation-pluginsexample-pluginindexjs)
  - [10. Verification Checklist Before Committing](#10-verification-checklist-before-committing)

---

## 1. Plugin Architecture & System Overview

Project Curator uses a modular, decoupled plugin system. The application consists of a **Rust Core Engine** coupled with a **Tauri v2 Desktop Frontend** (Vite + TypeScript).

```bash
Project Curator Runtime
├── Desktop Frontend (Tauri v2 WebView2)
│   └── PluginHost API (window.PluginHost)
│       └── Plugin Execution Context (Isolated IIFE JavaScript)
└── Background Core Engine (Rust Named Pipe Server \\.\pipe\curator_ipc)
    └── IPC Service Dispatcher (callService)
```

### Key Architectural Constraints

- **Isolated Script Execution**: Plugins are authored as zero-dependency ES5/ES6 JavaScript IIFEs (`index.js`). They are read via IPC (`ReadPluginFile`) and executed in global webview scope via script tags.
- **No Direct File Mutations**: Source media files must **never** be overwritten or mutated. Generated or converted artifacts are exported to specified output folders.
- **Core API Gateway**: All interactions with the library, SQLite database, ONNX inference engine, and asset file conversion occur via `window.PluginHost`.

### 1.1. Portable Distribution & Directory Resolution

Because Project Curator is packaged as a **portable desktop application**, the Rust binaries are statically compiled and cannot be modified at runtime. Dynamic plugin integration is achieved as follows:

- **Adjacent Directory Layout**: In both development and production portable releases, the `plugins/` folder must reside **adjacent** to the `.curator/` data directory.
- **Runtime Resolution**: The backend service resolves the root of the plugins directory portably using:
  `plugin_root = data_dir.parent().join("plugins")`
  This dynamically resolves by seeking developer workspace markers (`Cargo.toml` or `.git` up the folder tree), respecting the `CURATOR_DATA_DIR` override, or falling back directly to the folder adjacent to the running executable. This ensures portable releases run immediately on double-click without requiring any environment variables or developer files.
- **Portable Release Structure**: A distributed portable package consists of:

  ```bash
  ProjectCurator/
  ├── curator-dashboard.exe
  ├── curator-service.exe
  ├── Cargo.toml (or workspace root marker)
  ├── .curator/             # SQLite, vector index, and ONNX models
  └── plugins/              # Dynamic JS/TS plugins (git-ignored runtimes)
  ```

- **Implication**: Developers and users do not recompile Rust to install plugins. They simply drop the plugin's folder containing `manifest.json` into the `plugins/` directory. The static Rust backend handles manifest validation, file reading, and serves the UI scripts dynamically into the webview.

### 1.2. Core Plugin Development Philosophy

To maintain a secure, stable, and highly performant desktop ecosystem, Project Curator enforces a strict plugin design philosophy:

1. **First-Party Integration**: Pinned first-party or canonical contributor plugins are integrated directly into the workspace codebase for maximum compiler optimization and stability. These first-party implementations (such as `image-converter`, `ffmpeg-transcoder`, and `minipaint`) serve as the authoritative reference designs and structural templates for future developers.
2. **Security Hardening (Static Backend Engine)**: Unlike nodes-based applications like ComfyUI (which compile and load custom Python/C++ modules directly into the host process at runtime), Project Curator utilizes a strictly static Rust backend. Plugins are not permitted to load, compile, or inject arbitrary backend code at runtime. Instead, plugins run entirely as sandboxed frontend scripts inside the WebView, and can only perform backend tasks by calling the host's predefined, secure Rust endpoints.
   - *Planned Subprocess Scripting*: To support custom Python operations, we plan to allow plugins to invoke external Python scripts. Similar to how model conversion and quantization are implemented, these scripts will be executed out-of-process by spawning subprocesses using the project's isolated virtual environment (`scripts/venv/Scripts/python.exe`), maintaining container safety.
3. **Generic Backend Reuse**: To allow frontend flexibility without custom Rust changes, the backend exposes rich, **general-purpose helper endpoints** (e.g., `PathExists`, `EphemeralConvertImages`, directory pickers, file-size queries). We deliberately tackle the most complex/difficult plugin use-cases early in first-party development so that these generic handlers are designed and exposed in the core system early on, paving the way for future plugin creators to work purely in JavaScript/TypeScript.
4. **Minimal Rust Footprint**: Custom additions to the Rust backend must be kept to an absolute minimum. Ideally, a plugin creator should not touch Rust at all, implementing 100% of their plugin in front-end TypeScript/JavaScript.
5. **Bare-Metal Exceptions**: New Rust/Tauri commands should only be introduced when raw bare-metal execution performance is strictly required. Examples include writing multi-megabyte canvas buffers directly to disk (bypassing Named Pipe sockets), performing video stream analysis, or scheduling neural network tasks.

---

## 2. Directory & Workspace Structure

All plugins reside in the `plugins/` directory at the repository root.

### Single-file plugins (legacy / simple)

```bash
project-curator/
└── plugins/
    └── <my-plugin-name>/
        ├── manifest.json    # Plugin declaration & permission manifest
        └── index.js         # Hand-authored IIFE (no build step)
```

### Multi-file TypeScript plugins (preferred for new work)

Plugins with non-trivial logic should be authored as TypeScript modules under a `src/` directory. The build tooling in `plugins/` compiles them into the single `index.js` IIFE that the Plugin Host loads.

```bash
project-curator/
└── plugins/
    ├── build.js             # esbuild bundle script: node build.js --plugin <name> | --all
    ├── watch.js             # Dev watcher:           node watch.js --plugin <name>
    ├── package.json         # npm manifest + convenience scripts
    ├── tsconfig.json        # TS config (noEmit — esbuild handles transpilation)
    ├── plugin-types.d.ts    # Ambient globals: window.PluginHost, window.__TAURI__
    └── <my-plugin-name>/
        ├── manifest.json    # Points to index.js
        ├── index.js         # AUTO-GENERATED bundle (kept in git; do not edit)
        └── src/
            ├── index.ts     # Entry point: imports modules, calls PH.register*()
            ├── state.ts     # Shared mutable state object
            ├── ipc.ts       # Pure IPC helpers (no DOM)
            └── ui.ts        # All DOM rendering & event logic
```

### Downloaded/On-Demand Runtime Plugins (`install.json` variant)

For plugins that incorporate massive precompiled third-party web apps or editor assets (such as `miniPaint`), we separate the git-tracked wrapper code from the large binary runtime files. The plugin provides a spec file named `install.json` which the host's generic plugin runtime installer reads to download, verify, and inject the static files into a git-ignored subdirectory.

```bash
project-curator/
└── plugins/
    └── <my-plugin-name>/
        ├── .gitignore       # Ignores the downloaded runtime folder (e.g. editor/)
        ├── manifest.json    # Standard metadata pointing to index.js
        ├── install.json     # Installation spec (URLs, files, SHA-256 validation, script injections)
        ├── curator-bridge.js# Script injected into the third-party runtime iframe
        ├── index.js         # AUTO-GENERATED bundle
        └── src/
            ├── index.ts     # Mounts UI: checks if installed, displays console installer if missing, mounts iframe if ready
            ├── installer.ts # Directs console logging installation panel
            └── editor.ts    # Renders settings & wraps the same-origin postMessage iframe bridge
```

### Build commands

```powershell
cd plugins
npm install                          # first time only — installs esbuild
 
npm run build:image-converter        # build one plugin
npm run watch:image-converter        # rebuild on every src/ save (dev mode)
npm run build                        # rebuild all multi-file plugins at once
```

Plugins with no `src/index.ts` are silently skipped by the build scripts, so existing single-file plugins (`ffmpeg-transcoder`, `image-compare`, `gif-maker`) continue to work without any changes.

---

## 3. Manifest Declaration (`manifest.json`)

Every plugin **must** include a valid `manifest.json` file in its root directory.

```json
{
  "name": "my-plugin-name",
  "version": "1.0.0",
  "description": "Clear single-sentence explanation of what this plugin accomplishes.",
  "author": "Project Curator",
  "permissions": [
    "ui:inject"
  ],
  "components": {
    "ui": "index.js",
    "type": "javascript"
  },
  "hooks": []
}
```

### Field Specifications

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | Unique kebab-case identifier matching the directory name (e.g. `image-compare`). |
| `version` | `string` | **Yes** | Semantic version string (`1.0.0`). |
| `description` | `string` | **Yes** | Concise summary displayed in the Extension Hub. |
| `permissions` | `string[]` | **Yes** | Must include `"ui:inject"` to allow injection into the frontend. |
| `components.ui` | `string` | **Yes** | Relative path to the entry script (`index.js`). |
| `components.type` | `string` | **Yes** | Must be `"javascript"`. |

---

## 4. PluginHost API Reference (`window.PluginHost`)

Plugins register capabilities via the `window.PluginHost` global interface.

### TypeScript Interface Specification

```typescript
export interface AssetContext {
  asset_id: number;
  path: string;
  hash: string;
  tags: Array<{
    name: string;
    category: string;
    source_id: string;
    confidence: number | null;
  }>;
}

export interface PluginHostApi {
  // Capability Registration
  registerTab(id: string, label: string, iconClass: string, render: () => HTMLElement): void;
  registerMetadataRenderer(id: string, fn: (asset: AssetContext) => HTMLElement | null): void;
  registerToolbarButton(id: string, label: string, iconClass: string, fn: (selection: AssetContext[]) => void): void;
  registerContextMenuItem(id: string, label: string, fn: (asset: AssetContext) => void): void;

  // IPC Bridge & System Utilities
  callService(method: string, params: object): Promise<any>;
  convertFileSrc(filePath: string): string;

  // Asset Context Helpers
  fetchAssetContext(imageId: number): Promise<AssetContext>;
  getSelectionAssetContexts(): Promise<AssetContext[]>;
  getAssetContextFromCard(card: HTMLElement): AssetContext;
}
```

---

### API Capabilities Breakdown

#### 1. Sidebar Navigation Tab Registration (`registerTab`)

Registers a dedicated full-view extension tab in the application sidebar.

```javascript
PluginHost.registerTab(
  "my-extension-id",           // Tab ID (creates view container #view-extensions-my-extension-id)
  "My Extension",              // Display Label
  "bi bi-tools",               // Bootstrap Icon Class
  function renderTab() {       // DOM Factory Function (called lazily on tab activation)
    var container = document.createElement("div");
    container.innerHTML = "<!-- Plugin UI HTML -->";
    return container;
  }
);
```

#### 2. Local Asset Path Conversion (`convertFileSrc`)

Converts absolute Windows disk paths (`C:\...` or `K:\...`) into browser-safe asset protocol URLs (`http://asset.localhost/...`). **ALWAYS** use this function before assigning local file paths to `<img>` or `<video>` `src` attributes.

```javascript
var safeUrl = PluginHost.convertFileSrc("K:\\Pictures\\sample.png");
// Real output: "http://asset.localhost/K%3A%5CPictures%5Csample.png"
```

> **⚠ Critical Gotcha — Single-Segment URL:** On Windows, `convertFileSrc` percent-encodes the **entire** path (`\` → `%5C`, `:` → `%3A`), collapsing it into **one URL path segment**. Tauri's asset handler (`src/protocol/asset.rs`) decodes the URL path and `File::open`s it, so a **direct** absolute request works — but any **relative** `src`/`href` inside a document served from that URL resolves against the protocol root and 404s (`dist/bundle.js` → `http://asset.localhost/dist/bundle.js` → file not found). This breaks any embedded HTML editor / iframe that loads sibling scripts, styles, or images with relative paths.
>
> **Fix — build a multi-segment URL manually.** Split on `\`, `encodeURIComponent` each segment, join with `/` (Tauri decodes the path and Windows accepts `/` separators):
>
> ```javascript
> function assetDirUrl(absPath) {
>   var origin = PH.convertFileSrc("");            // "http://asset.localhost/"
>   var encoded = absPath.split("\\").map(encodeURIComponent).join("/");
>   return origin + encoded;
> }
> // → "http://asset.localhost/K%3A/<workspace>/plugins/minipaint/editor/index.html"
> // relative "dist/bundle.js" now resolves to ".../editor/dist/bundle.js" ✓
> ```
>
> Reference implementation: `plugins/minipaint/src/editor.ts` (`assetDirUrl`). Do **not** pass an initial asset through a `?image=` query param either — downstream apps (e.g. miniPaint) often read query values without URL-decoding; relay it instead via `postMessage` (`minipaint:load-image`) after the iframe's `load` event.

#### 3. IPC Core Service Requests (`callService`)

Executes asynchronous commands against the Rust backend engine over Named Pipes.

```javascript
// Example: Requesting image metadata from core
PluginHost.callService("GetImage", { image_id: 42 }).then(function(response) {
  if ("ImageResult" in response) {
    console.log(response.ImageResult.image);
  }
});
```

#### 4. Selection Context Queries (`getSelectionAssetContexts`)

Fetches detailed metadata for all assets currently selected in the main gallery/search grid.

```javascript
PluginHost.getSelectionAssetContexts().then(function(selection) {
  if (selection.length > 0) {
    console.log("Selected asset path:", selection[0].path);
  }
});
```

#### 5. Image Info Modal Section Injector (`registerMetadataRenderer`)

Injects a custom section inside the detail modal when inspecting an asset.

```javascript
PluginHost.registerMetadataRenderer("my-modal-section", function(asset) {
  if (!asset || !asset.path) return null;
  var box = document.createElement("div");
  box.className = "group-box";
  box.innerHTML = '<div class="group-box-title">My Plugin Controls</div>';
  return box;
});
```

#### 6. Grid Toolbar & Context Menu Actions

Adds global action buttons to grid toolbars and right-click context menus.

```javascript
// Grid Toolbar Button
PluginHost.registerToolbarButton("my-tool-action", "Run Action", "bi bi-play-fill", function(selection) {
  console.log("Executing action on", selection.length, "assets");
});

// Right-Click Context Menu Item
PluginHost.registerContextMenuItem("my-ctx-item", "Process with Plugin", function(asset) {
  console.log("Processing asset:", asset.path);
});
```

---

## 5. UI & Design System Guidelines (WinForms Desktop Control Mandate)

All plugin interfaces **must strictly adhere to Section 5 of `AGENTS.md`**.

### Strict Design Rules

1. **Zero Web Abstractions**:
   - **NEVER** use flashy gradients (`linear-gradient`), neon glows (`box-shadow: 0 0 10px...`), floating rounded web cards, or radial background blobs.
   - **NEVER** override system window backgrounds with ad-hoc colors when displaying empty state containers.
2. **Official Bootstrap Icons Exclusively**:
   - **NO Unicode Emojis** (`✨`, `●`, `▶`, `📁`).
   - **ALWAYS** use official Bootstrap Icon markup (`<i class="bi bi-folder2-open"></i>`, `<i class="bi bi-stars"></i>`).
3. **Native Control Classes**:
   - Buttons: `.win-button`, `.win-button.primary`, `.win-button.danger`.
   - Group Boxes: Native fieldset grouping containers with titles:

     ```html
     <div class="group-box">
       <div class="group-box-title">Section Title</div>
       <!-- Content -->
     </div>
     ```

   - Tag Pills: Standard rank taxonomy classes: `.tag-pill.custom-concept` (Custom Concept), `.tag-pill.tag-character` (Character), `.tag-pill.tag-copyright` (Copyright), `.tag-pill.tag-meta` (Meta).
4. **App Drop Zones**:
   - Use native `.toolbox-drop-zone`, `.toolbox-drop-icon`, and `.toolbox-drop-active` classes directly from `layout.css`.

---

## 6. Native Tauri v2 Drag & Drop Integration

Standard HTML5 drag-and-drop `e.dataTransfer.files` can be suppressed by Windows WebView2 security policies. Plugins **must** integrate Tauri v2's native window drop events.

### Recommended Native Drop Listener Template

```javascript
function setupNativeTauriDropZone(canvasArea, onFilesDropped) {
  var api = window.__TAURI__;
  if (!api || !api.webview || !api.webview.getCurrentWebview) return;

  api.webview.getCurrentWebview().onDragDropEvent(function (event) {
    // Only handle drops when plugin view is active
    var tabActive = document.getElementById("view-extensions-my-plugin-id");
    if (!tabActive || !tabActive.classList.contains("active")) return;

    var drop = event.payload;
    var dropZones = document.querySelectorAll(".toolbox-drop-zone");

    // Device Pixel Ratio Hit-Testing
    var getHitDropZone = function () {
      var pos = drop.position;
      if (!pos || typeof pos.x !== "number") return null;
      var cx = pos.x / window.devicePixelRatio;
      var cy = pos.y / window.devicePixelRatio;
      var hit = document.elementFromPoint(cx, cy);
      return hit ? hit.closest(".toolbox-drop-zone") : null;
    };

    var activeZone = getHitDropZone();

    if (drop.type === "enter" || drop.type === "over") {
      dropZones.forEach(function (dz) {
        if (dz === activeZone) dz.classList.add("toolbox-drop-active");
        else dz.classList.remove("toolbox-drop-active");
      });
    } else if (drop.type === "leave" || drop.type === "drop") {
      dropZones.forEach(function (dz) {
        dz.classList.remove("toolbox-drop-active");
      });
    }

    if (drop.type === "drop" && drop.paths && drop.paths.length > 0) {
      onFilesDropped(drop.paths, activeZone);
    }
  });
}
```

---

## 7. Performance & GPU Compositing Patterns

To guarantee sub-10ms UI responsiveness, high-frequency interaction tools (such as image comparison sliders, croppers, or interactive canvas tools) must observe strict performance practices:

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

## 8. Critical Lessons & Architectural Patterns Learned from Existing Core Plugins

Inspecting official core plugins (`image-converter`, `ffmpeg-transcoder`, and `image-compare`) reveals key patterns every AI agent must adopt:

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

- Prefer `flex: 1; min-height: 0` over the legacy `calc(100vh - Npx)` approach — it tracks the panel's real height and avoids magic numbers (AGENTS.md §6.6).
- Reference implementations: `plugins/minipaint/src/index.ts` (minipaint styles) and `plugins/gif-maker/src/ui.ts` `injectStyles()`.

---

### Pattern 10: Surfacing Console Errors from a Cross-Origin iframe

A plugin that embeds a third-party editor in an `asset.localhost` iframe cannot rely on its own
`console.error` being visible: the iframe console is effectively hidden and the frame is
cross-origin to the host, so uncaught errors die silently. When diagnosing "it does nothing"
reports from iframed tools (e.g. miniPaint GIF export), always relay errors to the host first.

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

Host side receives it in the existing bridge `onMessage` handler and logs to the dashboard
console:

```typescript
if (d.type === "minipaint:console-error") {
  console.error(`[minipaint iframe] ${d.message || "unknown error"}${d.detail ? "\n" + d.detail : ""}`);
  return;
}
```

- Combine with an injected `<script src="...">` for any encoder/worker library (e.g. gif.js) that
  the host cannot reach through module scope — load it early, poll for the global, and fail loud
  if it never appears.
- Reference implementation: `plugins/minipaint/curator-bridge.js` +
  `plugins/minipaint/src/editor.ts`.

---

### Pattern 11: Fixing `willReadFrequently` Canvas Readback Lag in Embedded Editors

When an iframed editor is readback-heavy (filters, blend modes, layer compositing, GIF/export
pixel reads), WebView2 logs `Canvas2D: Multiple readback operations using getImageData are
faster with the willReadFrequently attribute set to true` and the app visibly lags. The warning
is not cosmetic: each `getImageData` on a context that keeps a GPU-backed surface forces a slow
GPU→CPU copy, and miniPaint does this constantly.

**Fix**: wrap `getContext` in the injected in-iframe bridge **before** the editor's `load`-time
init creates any canvases, and force the flag for `"2d"` contexts:

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

- Ordering matters: the bridge tag must be injected before the editor creates its first canvas
  (miniPaint's app init runs on `window.load`, and the bridge is injected before `</body>`, so
  the patch wins). Preserve any options object the caller already passed (`alpha`, etc.).
- Only patch `"2d"` — leave `"webgl"`/`"webgl2"` contexts untouched.
- Reference implementation: `plugins/minipaint/curator-bridge.js`.

---

## 9. Complete Working Reference Implementation (`plugins/example-plugin/index.js`)

Below is a complete, self-contained template for creating a new plugin:

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

## 10. Verification Checklist Before Committing

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
