# PLUGINS_FOR_AGENTS.MD

> **Authoritative Technical Blueprint & Quickstart for Building Project Curator Plugins**
> *This document provides a concise architectural overview and quickstart for developing desktop plugins, linking to modularized, deep-dive specifications in [`docs/plugins/`](docs/plugins/).*

---

## Documentation Index

1. [**Plugin Architecture & System Overview**](docs/plugins/overview.md)
   - Architecture constraints, portable distribution, directory resolution, security hardening, and development philosophy.
2. [**Directory, Workspace & Manifest Specification**](docs/plugins/workspace_and_manifest.md)
   - Single-file vs multi-file TypeScript plugins, on-demand `install.json` web app runtimes, esbuild tooling, and `manifest.json` schema.
3. [**PluginHost API Reference (`window.PluginHost`)**](docs/plugins/plugin_host_api.md)
   - Full TypeScript interface specification, sidebar tab registration (`registerTab`), `convertFileSrc` multi-segment URL handling, service calls (`callService`), selection contexts, and modal/toolbar injection.
4. [**UI Guidelines & Native Tauri v2 Events**](docs/plugins/ui_and_native_events.md)
   - WinForms Desktop Control styling, Bootstrap Icons, group boxes, and native `onDragDropEvent` integration.
5. [**Performance, GPU Compositing & Architectural Patterns**](docs/plugins/performance_and_patterns.md)
   - GPU compositing & RAF loops, flicker-free layer clipping, screen-space overlay math, and Patterns 1–11 (non-destructive collision, folder picker, async progress polling, deduplication, log consoles, deferred mount, cross-tab navigation, localStorage, full-height `.view-section`, cross-origin iframe console error relays, and `willReadFrequently` canvas fixes).
6. [**Reference Implementation & Pre-Commit Checklist**](docs/plugins/example_plugin.md)
   - Self-contained example plugin template and pre-commit verification checklist.

---

## Quick Reference: Plugin Manifest

Every plugin requires a `manifest.json` in its root folder:

```json
{
  "name": "my-plugin-name",
  "version": "1.0.0",
  "description": "Concise summary of plugin capabilities.",
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

---

## Quick Reference: Minimal Plugin Script (`index.js`)

```javascript
(function () {
  "use strict";
  var PH = window.PluginHost;
  if (!PH) return;

  PH.registerTab("my-plugin", "My Plugin", "bi bi-tools", function () {
    var container = document.createElement("div");
    container.innerHTML = '<div class="group-box"><div class="group-box-title">Plugin View</div></div>';
    return container;
  });
})();
```

For building complex TypeScript plugins or embedding third-party web apps (e.g. `miniPaint`), refer to the full guides in [`docs/plugins/`](docs/plugins/).
