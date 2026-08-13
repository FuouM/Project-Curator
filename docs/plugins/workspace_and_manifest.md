# Plugin Directory, Workspace Structure & Manifest Declaration

All plugins reside in the `plugins/` directory at the repository root.

---

## 1. Directory & Workspace Structure

### Single-File Plugins (Legacy / Simple)

```bash
project-curator/
└── plugins/
    └── <my-plugin-name>/
        ├── manifest.json    # Plugin declaration & permission manifest
        └── index.js         # Hand-authored IIFE (no build step)
```

### Multi-File TypeScript Plugins (Preferred for New Work)

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

### Downloaded/On-Demand Runtime Plugins (`install.json` Variant)

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

### Build Commands

```powershell
cd plugins
npm install                          # first time only — installs esbuild
 
npm run build:image-converter        # build one plugin
npm run watch:image-converter        # rebuild on every src/ save (dev mode)
npm run build                        # rebuild all multi-file plugins at once
```

Plugins with no `src/index.ts` are silently skipped by the build scripts, so existing single-file plugins (`ffmpeg-transcoder`, `image-compare`, `gif-maker`) continue to work without any changes.

---

## 2. Manifest Declaration (`manifest.json`)

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
