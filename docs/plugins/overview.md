# Plugin Architecture & System Overview

Project Curator uses a modular, decoupled plugin system. The application consists of a **Rust Core Engine** coupled with a **Tauri v2 Desktop Frontend** (Vite + TypeScript).

```bash
Project Curator Runtime
├── Desktop Frontend (Tauri v2 WebView2)
│   └── PluginHost API (window.PluginHost)
│       └── Plugin Execution Context (Isolated IIFE JavaScript)
└── Background Core Engine (Rust Named Pipe Server \\.\pipe\curator_ipc)
    └── IPC Service Dispatcher (callService)
```

---

## Key Architectural Constraints

- **Isolated Script Execution**: Plugins are authored as zero-dependency ES5/ES6 JavaScript IIFEs (`index.js`). They are read via IPC (`ReadPluginFile`) and executed in global webview scope via script tags.
- **No Direct File Mutations**: Source media files must **never** be overwritten or mutated. Generated or converted artifacts are exported to specified output folders.
- **Core API Gateway**: All interactions with the library, SQLite database, ONNX inference engine, and asset file conversion occur via `window.PluginHost`.

---

## 1. Portable Distribution & Directory Resolution

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

---

## 2. Core Plugin Development Philosophy

To maintain a secure, stable, and highly performant desktop ecosystem, Project Curator enforces a strict plugin design philosophy:

1. **First-Party Integration**: Pinned first-party or canonical contributor plugins are integrated directly into the workspace codebase for maximum compiler optimization and stability. These first-party implementations (such as `image-converter`, `ffmpeg-transcoder`, and `minipaint`) serve as the authoritative reference designs and structural templates for future developers.
2. **Security Hardening (Static Backend Engine)**: Unlike nodes-based applications like ComfyUI (which compile and load custom Python/C++ modules directly into the host process at runtime), Project Curator utilizes a strictly static Rust backend. Plugins are not permitted to load, compile, or inject arbitrary backend code at runtime. Instead, plugins run entirely as sandboxed frontend scripts inside the WebView, and can only perform backend tasks by calling the host's predefined, secure Rust endpoints.
   - *Planned Subprocess Scripting*: To support custom Python operations, we plan to allow plugins to invoke external Python scripts. Similar to how model conversion and quantization are implemented, these scripts will be executed out-of-process by spawning subprocesses using the project's isolated virtual environment (`scripts/venv/Scripts/python.exe`), maintaining container safety.
3. **Generic Backend Reuse**: To allow frontend flexibility without custom Rust changes, the backend exposes rich, **general-purpose helper endpoints** (e.g., `PathExists`, `EphemeralConvertImages`, directory pickers, file-size queries). We deliberately tackle the most complex/difficult plugin use-cases early in first-party development so that these generic handlers are designed and exposed in the core system early on, paving the way for future plugin creators to work purely in JavaScript/TypeScript.
4. **Minimal Rust Footprint**: Custom additions to the Rust backend must be kept to an absolute minimum. Ideally, a plugin creator should not touch Rust at all, implementing 100% of their plugin in front-end TypeScript/JavaScript.
5. **Bare-Metal Exceptions**: New Rust/Tauri commands should only be introduced when raw bare-metal execution performance is strictly required. Examples include writing multi-megabyte canvas buffers directly to disk (bypassing Named Pipe sockets), performing video stream analysis, or scheduling neural network tasks.
