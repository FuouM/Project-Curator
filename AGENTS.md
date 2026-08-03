# AGENTS.md

Welcome to **Project Curator**, a high-performance local AI image curation, tagging, and semantic vector search system.

---

## 1. Project Architecture & Workspace Structure

This repository is organized as a Cargo workspace alongside a Tauri v2 desktop application frontend:

* `curator-core/` – Core Rust engine containing image processing, fast PNG decoding, CLIP vector embeddings (ONNX Runtime DirectML/CPU), vector similarity indexing, and SQLite database storage.
* `curator-service/` – Background service worker managing indexing pipelines, ONNX inference, and IPC/gRPC interface.
* `curator-cli/` – Command-line interface for headless indexing, batch tagging, and debugging queries.
* `curator-dashboard/` – Desktop GUI built with Tauri v2 + Vite + TypeScript/Vanilla CSS.
  * `curator-dashboard/src-tauri/` – Rust backend glue for Tauri app (workspace member).
  * `curator-dashboard/src/` – TypeScript frontend UI components and IPC calls.
* `.curator/` – Default local cache directory holding model weights (`models/`), vector indexes, and application state.

---

## 2. Local Environment Setup & PowerShell Scripts

Always use the project's dedicated PowerShell scripts for environment configuration and launcher workflows:

### Environment Initialization

* **Load Rust Environment**: Always source `env.ps1` before running `cargo` or `rustc` commands:

  ```powershell
  . .\env.ps1
  ```

  *(Sets `RUSTUP_HOME` to `.rust\.rustup`, `CARGO_HOME` to `.rust\.cargo`, and prepends `.rust\.cargo\bin` to `$env:PATH`)*.

* **Download ONNX Runtime (DirectML)**:

  ```powershell
  .\download_ort.ps1
  ```

  *(Fetches Microsoft.ML.OnnxRuntime.DirectML v1.24.4 and copies `onnxruntime.dll` to project root)*.

* **Full Dev Mode Launcher**:

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\dev.ps1
  ```

  *(Automates stopping `curator-service`, building service binary, and launching Tauri dev server)*.

* **Python Environment (if needed for scripts or debug validation)**:
  Use portable PyTorch/CUDA environment or local ComfyUI python executable if available.

---

## 3. Common Development & Build Commands

### Rust Workspace Commands

```powershell
# Sourcing environment first
. .\env.ps1

# Run unit & integration tests
cargo test -p curator-core
cargo test -p curator-service

# Check workspace code style
cargo clippy --all-targets

# Build specific workspace crates
cargo build --manifest-path curator-service/Cargo.toml
cargo build --manifest-path curator-core/Cargo.toml
```

### Frontend / Tauri Desktop Commands

```powershell
cd curator-dashboard
npm install
npm run tauri dev
```

---

## 4. Key Rules, Solutions & Recurring Pitfalls

### 1. Service Executable Locking (Windows)

* **Problem**: `cargo build` on `curator-service` fails with access denied because `curator-service.exe` is currently running in the background.
* **Solution**: Kill running processes before rebuilding:

  ```powershell
  Get-Process curator-service -ErrorAction SilentlyContinue | Stop-Process -Force
  ```

### 2. ONNX Runtime Dynamic Library Dependency

* **Problem**: Inference errors or missing DLL crashes when running CLIP embedding models.
* **Solution**: Ensure `onnxruntime.dll` exists in project root and target directories (`target/debug` or `target/release`). Use `.\download_ort.ps1` if missing.

### 3. CLIP Text Tokenization & Padding Rules

* **Problem**: Semantic search similarity ranking yielding incorrect or uniform scores.
* **Gotcha**: CLIP text sequence input IDs **must be padded with zeros (`0`)** up to max sequence length 77.
* **Do NOT**: Repeat `EOS` tokens across padded slots, as it corrupts positional embeddings and pooling computations inside the CLIP text transformer model.

### 4. Frontend Event Handler Modularity (`curator-dashboard`)

* **Guideline**: When rendering image cards across Gallery, Search Results, and Favorites views, use shared card event handlers (`attachCardEventHandlers`) and unified card rendering functions (`renderCards`) in `main.ts` rather than duplicating element event bindings.

---

## 5. Code Style & Interaction Mandates

### Workflow & Interaction Speed Mandates

* **No Absolute Paths**: NEVER include or commit absolute file paths (e.g., `file:///K:/...`, `K:\...`, `C:\...`) in code, scripts, configuration files, or documentation (including markdown files) checked into the repository. Always use repository-relative or workspace-relative paths, and rely on portable environment-variable/executable-relative resolution at runtime.
* **No Unnecessary Build Commands**: The user keeps their local dev build (`dev.ps1` / `npm run dev`) active. DO NOT execute `npm run build` or `cargo build` on minor edits unless explicitly requested or validating backend Rust signature changes.
* **No Unprompted Feature Over-Engineering**: Implement strictly what the user requests. Never introduce automated background jobs, full-library auto-rescans, or unexpected database mutations.
* **NO FALLBACKS Policy**: NEVER implement automatic "silent fallbacks" (e.g. copying an original file, silencing errors, or falling back to a dummy placeholder) to satisfy execution or make a command run green. If a task, process, or script encounters a failure, fail fast, raise a clear error, and expose the underlying problem directly so it can be resolved properly.
* **Database Safety & Concept Integrity**:
  * **Dynamic Vector Searches**: Concept vector searches must remain 100% dynamic in memory/index search and NEVER write auto-tags into `image_tags` table.
  * **Explicit Sample Tagging**: Teaching a concept or adding samples ONLY tags the explicitly selected ground-truth sample images.
  * **User Blacklist Respect**: Deleting a custom concept tag must cleanly delete the row, and NEVER convert custom concept tags into AI exclusions/blacklists.
* **Concise & Direct Responses**: Keep answers short, direct, and actionable. Avoid unnecessary re-summaries, verbose technical disclaimers, or excessive build output.
* **Database Schema & Migrations Mandate**:
  * **ALWAYS use Migrations**: NEVER execute ad-hoc schema modifications, column creations, or performance indexes directly against local development databases using sqlite CLI or code commands.
  * **Location**: All database updates, new tables, and indexes must be written as structured SQL files inside `curator-core/migrations/` (e.g. `0011_xxxx.sql`). This guarantees that schema changes are automatically migrated and synchronized across all environments on service startup.
* **Database Explain Plan Mandate**:
  * Run `EXPLAIN QUERY PLAN` on SQLite queries before finalizing query refactors to verify index utilization and avoid table scans or temp B-trees for ordering.
* **IPC Volume & Performance Mandate**:
  * **Indexed Pattern Queries**: Avoid pre-fetching large data arrays (e.g., >1,000 items) over IPC named-pipe channels at startup. Autocomplete components must perform dynamic, index-supported pattern searches (`LIKE` queries) on keypress, keeping response payloads small and IPC latency under **10ms**.
  * **Structured IPC Serialization**: Explicitly map IPC payloads using key-object shapes (e.g. `{ RequestCommand: { arg: val } }`) instead of raw parameters to bypass formatting normalization failures in `callService`.
* **Lazy DOM Loader Mandate**:
  * Display structural layout skeletons and empty placeholder outlines instantly when rendering tabs or complex view components.
  * Defer secondary details queries, crop generation tasks, and thumbnail updates to a microtask/timer delay (`setTimeout(..., 50)`) to allow the UI to paint without freezing.
* **Git Staging & Commiting Mandate**:
  * **Never Auto-Commit**: NEVER run `git commit` or `git push` commands automatically. Only perform Git commits or pushes when the user explicitly instructs you to do so.
  * **NO Wildcard Staging**: NEVER run wildcard staging commands (`git add .`, `git add -A`, or `git add *`). Explicitly stage target files by their path to avoid committing untracked temp files, log files, or build artifacts.
  * **NO Unprompted Git Checkout**: NEVER run `git checkout` on any file to revert or recover changes unless explicitly instructed by the user. If you need to recover or inspect modifications, use `git diff` or compare histories rather than destructive resets.
  * **Semantic Commit Bodies**: Follow the repo's commit body style. Commit messages must consist of a semantic summary line (`type: description`) followed by detailed bullet points documenting the structural file modifications.

### UI & Aesthetic Rules (Modern WinForms Desktop Control Aesthetic)

* **STRICT DESIGN SYSTEM MANDATE - ALWAYS FOLLOW**:
  * **Zero Web/Glow Abstractions**: NEVER introduce flashy web gradients (`linear-gradient(...)`), neon cyan/magenta text (`#00ffff`, `#ff007f`), glowing box-shadows (`box-shadow: 0 0 6px...`), rounded floating cards, or radial background blobs.
  * **Icon System Mandate**:
    * **NO Unicode Emojis**: NEVER use raw unicode emojis or text symbols (`✨`, `●`, `○`, `▶`, `◀`, etc.) in HTML templates, tag pills, select options, or notifications.
    * **Bootstrap Icons Only**: ALWAYS use official Bootstrap Icon classes (`<i class="bi bi-stars"></i>`, `<i class="bi bi-caret-left-fill"></i>`, `<i class="bi bi-check-lg"></i>`) across the entire application.
  * **Native WinForms Control Styling**:
    * **Containers**: Always wrap sections and cards in native WinForms `.group-box` fieldset containers (`<div class="group-box"><div class="group-box-title">Title</div>...</div>`).
    * **Buttons & Inputs**: Always use standard `.win-button` (primary, danger), input fields, select dropdowns, and range sliders styled via design system CSS tokens.
    * **Tag Pills**: Custom Concept pills must strictly use `#cce5ff` background, `#b8daff` border, and `#004085` text (`.tag-pill.custom-concept`). Standard tags use `#fff3cd` (`user`), `#d1ecf1` (`character`), `#ebdcf9` (`copyright`), `#e2e3e5` (`meta`).
    * **Card & Grid Dimensions**: Image grids must always inherit standard `.image-grid` dimensions (`minmax(200px, 1fr)`). Concept grids use `minmax(460px, 1fr)`. Never force arbitrary tiny thumbnail widths (e.g., 120px).
    * **Inline Panels Over Modals**: Prefer inline collapsible `.group-box` sub-panels within parent cards over floating popups/modals for secondary details or thumbnail lists.
  * **Component Sheet Alignment**: Before creating or modifying ANY UI element, inspect the **Component Showcase Sheet view** (`index.html` -> `#view-components`) and `src/components.ts` to ensure exact design token match.

### Frontend Design Skill (`/frontend-design`) Integration

* **Mandatory Skill Alignment**: ALWAYS adhere to the principles from the **`frontend-design`** skill:
  * **Intentionality & Restraint**: Avoid generic AI-generated defaults (e.g. random gradients, acid-green highlights, cream backgrounds, scattered web effects). Spend boldness in one deliberate place and keep surrounding elements quiet, disciplined, and cohesive.
  * **Subject-Grounded Interface**: Ground every design decision in the real product context—a high-performance local AI image curation engine. Every container, label, divider, and control must serve a clear purpose.
  * **Consistent UX Vocabulary**: Use plain, active-voice verbs ("Save changes", "Teach Concept", "Rescan Library"). Keep terminology consistent through all UI flows and notifications.
  * **Design System Token Integrity**: Derive every color, padding, and font decision directly from the project's native Modern WinForms desktop token system (`styles.css` & `components.ts`).

* **Rust**:
  * Follow Rust 2021 edition idioms.
  * Use `clippy.toml` and `rustfmt.toml` configurations.
  * Prefer explicit, non-blocking asynchronous processing for heavy IO/inference pipelines using `tokio`.
* **TypeScript / CSS**:
  * Keep components modular and single-purpose.
  * Use CSS variables and dark-mode high-contrast UI design system tokens.
  * Ensure user feedback indicators (copy status, star toggle, search loaders) are explicitly updated and reactive.

---

## 6. Critical Safety & Development Mandates (ONNX & Filesystem Safety)

* **First-Principles & Standalone Verification**:
  * Do not trust legacy code or pre-existing tests when refactoring external libraries (e.g. `ort` / `pykeio`).
  * Always build standalone subprogram binaries in `curator-core/src/bin/` (e.g. `test_ort_standalone.rs`) to verify library initialization, model loading, and inference step-by-step before modifying `curator-core`.
  * **DO NOT run existing tests in `curator-core/tests`** unless explicitly requested by the user.

* **Filesystem Safety & Binary Dependency Preservation**:
  * **NEVER execute destructive deletions** (`Remove-Item -Force`, `rm -rf`, `git clean -fd`) on downloaded binary dependencies (`.dll`, `.lib`, `.onnx`, `.tar.lzma2`, CUDA/DirectML runtime files).
  * **Always move/preserve files** in dedicated backup folders (e.g. `.curator_ort_dlls_backup/`) before cleaning up workspace root folders.
  * **PowerShell File Copy Verification**: Always verify that PowerShell file search/copy filters (`Get-ChildItem -Path ".\*"`) match non-zero files and inspect destination folder contents BEFORE removing root copies.

* **Hardware Acceleration Scope**:
  * WebGPU is currently ignored/disabled. Focus on DirectML and CUDA EPs for local Windows inference.
