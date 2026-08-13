# PluginHost API Reference (`window.PluginHost`)

Plugins register capabilities via the `window.PluginHost` global interface.

---

## 1. TypeScript Interface Specification

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

## 2. API Capabilities Breakdown

### 1. Sidebar Navigation Tab Registration (`registerTab`)

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

### 2. Local Asset Path Conversion (`convertFileSrc`)

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

### 3. IPC Core Service Requests (`callService`)

Executes asynchronous commands against the Rust backend engine over Named Pipes.

```javascript
// Example: Requesting image metadata from core
PluginHost.callService("GetImage", { image_id: 42 }).then(function(response) {
  if ("ImageResult" in response) {
    console.log(response.ImageResult.image);
  }
});
```

### 4. Selection Context Queries (`getSelectionAssetContexts`)

Fetches detailed metadata for all assets currently selected in the main gallery/search grid.

```javascript
PluginHost.getSelectionAssetContexts().then(function(selection) {
  if (selection.length > 0) {
    console.log("Selected asset path:", selection[0].path);
  }
});
```

### 5. Image Info Modal Section Injector (`registerMetadataRenderer`)

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

### 6. Grid Toolbar & Context Menu Actions

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
