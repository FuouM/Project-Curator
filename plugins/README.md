# Project Curator Plugins Workspace

This directory is structured as a TypeScript workspace. Each plugin has its own source directory (`src/`) that compiles and bundles into a single self-contained `index.js` file using `esbuild`.

> [!NOTE]
> **AI Coding Assistant Guidelines**:
> All AI agents operating in this directory must strictly comply with the workspace guidelines, architecture conventions, database schemas, and design constraints defined in [AGENTS.md](../AGENTS.md) and [PLUGINS_FOR_AGENTS.md](../PLUGINS_FOR_AGENTS.md) in the project root.

---

## Workspace Structure

```bash
plugins/
├── lib/               # Shared library modules (barrel exported)
│   ├── log.ts         # Standard console logger generator
│   ├── format.ts      # Byte and duration formatting helpers
│   ├── ipc-utils.ts   # Common IPC commands (e.g. checkFileExists)
│   ├── navigation.ts  # Sidebar panel tab navigation triggers
│   ├── drop-zone.ts   # Multi-zone Tauri drag-and-drop listener adapter
│   ├── poll.ts        # Long-running task progress polling helper
│   └── index.ts       # Shared library entry barrel
├── image-converter/   # Image format conversion panel
│   ├── src/
│   └── index.js       # Bundled build output
├── ffmpeg-transcoder/ # FFmpeg video encoding queue
│   ├── src/
│   └── index.js       # Bundled build output
├── image-compare/     # Side-by-side / overlay visual analysis
│   ├── src/
│   └── index.js       # Bundled build output
├── gif-maker/         # WYSIWYG timeline GIF compiler and editor
│   ├── src/
│   └── index.js       # Bundled build output
├── minipaint/         # Full raster photo editor (offline iframe runtime)
│   ├── src/
│   └── index.js       # Bundled build output
├── plugin-types.d.ts  # Ambient global definitions for PluginHost API
├── package.json       # Workspace npm package definitions
├── build.js           # esbuild bundler script
└── tsconfig.json      # Shared TypeScript compiler config
```

---

## Development Guide

### 1. Pre-requisites & Setup
Ensure you load the Rust toolchain environment first and install workspace dependencies:
```powershell
# Load cargo environments
. ..\env.ps1

# Install node dependencies
npm install
```

### 2. Building Plugins
To compile TypeScript modules into bundled JS plugins:
```powershell
# Build a specific plugin
node build.js --plugin image-converter

# Build all workspace plugins
npm run build
```

### 3. Type Checking
Validate type safety across all files:
```powershell
npx tsc --project tsconfig.json
```

---

## Coding Best Practices

1. **Accessing Local Binary Assets (Fonts, Images, etc.)**:
   Always use `window.__curator_plugin_dir__` to retrieve the absolute path to your plugin's runtime directory before calling `PluginHost.convertFileSrc`:
   ```typescript
   const fontUrl = PluginHost.convertFileSrc(
     (window.__curator_plugin_dir__ ?? "") + "\\Roboto_Condensed_Bold.otf"
   );
   ```

2. **Resolving Relative Temporary Paths**:
   If your plugin outputs temporary files inside `.curator/`, prepend the absolute workspace directory `window.__curator_workspace_root__` to avoid WebView asset loading protocol 404 errors:
   ```typescript
   let absolutePath = filePath;
   if (filePath && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
     absolutePath = (window.__curator_workspace_root__ ?? "") + "\\" + filePath;
   }
   const safeUrl = PluginHost.convertFileSrc(absolutePath);
   ```

3. **Shared Utilities**:
   Opt-in to reuse common code patterns from the local shared library:
   ```typescript
   import { formatBytes, setupDropZone } from "../lib";
   ```
