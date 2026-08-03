# AGENTS.md

This document establishes the architecture, development rules, safety mandates, and design system specifications for **Project Curator**. All AI agents and developers operating in this repository must strictly adhere to these guidelines.

---

## 1. Project Architecture & Workspace Structure

The repository is structured as a Rust Cargo workspace coupled with a Tauri v2 desktop frontend:

```bash
project-curator/
├── curator-core/       # Core Rust engine: PNG decoding, CLIP embeddings, vector indexing, SQLite
├── curator-service/    # Background daemon: task queues, ONNX model pipeline, Named Pipe server
├── curator-cli/        # Scriptable CLI: headless indexing, batch query, agentic execution
├── curator-dashboard/  # Native-looking desktop UI (Tauri v2 + Vite + TypeScript)
│   ├── src-tauri/      # Rust backend glue for Tauri app (workspace member)
│   └── src/            # TypeScript frontend UI components, rendering, and IPC
└── .curator/           # Local runtime state: cached models, vector indexes, SQLite database
```

* **Core IPC Bus:** High-throughput, asynchronous communication between components occurs via local Windows Named Pipes (`\\.\pipe\curator_ipc`).
* **Storage Philosophy:** Relational metadata resides in SQLite; dense vector embeddings reside in an isolated dynamic vector index. Original source files are never mutated.

---

## 2. Environment Setup & Development Workflows

### PowerShell Environment Commands

Always execute commands within the project's isolated environment:

```powershell
# 1. Load local Rust toolchain environment
## Sets RUSTUP_HOME to .rust\.rustup, 
## CARGO_HOME to .rust\.cargo, 
## and prepends .rust\.cargo\bin to $env:PATH
. .\env.ps1

# 2. Fetch DirectML ONNX Runtime binary (Microsoft.ML.OnnxRuntime.DirectML v1.24.4)
.\download_ort.ps1

# 3. Launch full development server (stops background service, builds, and starts Tauri GUI)
.\dev.ps1
```

* **Python Environment**:
  Use `scripts/venv` (If already set up) or ask the User for an environment.

---

### Build & Test Verification

```powershell
# Sourcing environment first
. .\env.ps1

# Execute unit/integration tests
cargo test -p curator-core
cargo test -p curator-service

# Workspace linting
cargo clippy --all-targets

# Frontend development
cd curator-dashboard
npm install
npm run tauri dev

# Build specific workspace crates
cargo build --manifest-path curator-service/Cargo.toml
cargo build --manifest-path curator-core/Cargo.toml
```

---

## 3. Critical Technical & Runtime Constraints

### 1. Service Executable Locking (Windows)

`cargo build` on `curator-service` will fail with an access denied error if `curator-service.exe` is running in the background. Kill the process before recompiling:

```powershell
Get-Process curator-service -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 2. ONNX Runtime Dependency Management

`onnxruntime.dll` must exist in the root folder and active build target directories (`target/debug` or `target/release`). If missing, run `.\download_ort.ps1`.

### 3. CLIP Text Tokenization Rules

* Sequence input IDs **must be padded with zeros (`0`)** up to the maximum sequence length of **77**.
* **Do NOT** repeat `EOS` tokens across padded slots; doing so corrupts positional embeddings and transformer pooling outputs.

### 4. IPC Latency & Serialization

* **Indexed Pattern Search:** Autocomplete components must perform dynamic `LIKE` queries on keypress rather than pre-fetching large data arrays over IPC. Keep response payloads small to guarantee sub-10ms response times.
* **Payload Serialization:** Structure IPC parameters explicitly using key-object shapes (e.g., `{ RequestCommand: { arg: val } }`) to prevent serialization normalization failures.

---

## 4. Data Integrity & Database Mandates

1. **Database Schema & Migrations:**
   * **Never** perform ad-hoc SQL modifications or direct index additions on development databases.
   * All schema updates, new tables, and performance indexes **must** be committed as structured SQL files inside `curator-core/migrations/` (e.g., `0011_feature_name.sql`).

2. **Query Performance Verification:**
   * Always execute `EXPLAIN QUERY PLAN` on SQLite queries before finalizing refactors to verify index usage and eliminate full table scans or temporary B-trees.

3. **Vector vs. Tag Integrity:**
   * Dynamic vector similarity searches must operate purely in-memory/vector-index and **never** write auto-tags into the `image_tags` table.
   * Teaching a concept or providing training samples **only** tags explicitly selected ground-truth assets.
   * Deleting a custom concept tag must execute a clean row deletion and **never** convert user tags into AI exclusions/blacklists.

---

## 5. UI & Design System Guidelines (WinForms Desktop Control Aesthetic)

The dashboard strictly follows a modern, dark-mode **WinForms Desktop Control** aesthetic.

### Strict Design System Rules

* **Zero Web Abstractions:** **NEVER** use flashy gradients (`linear-gradient`), neon glow effects (`box-shadow: 0 0 10px...`), floating rounded web cards, or radial background blobs.
* **Icon System:** **NO Unicode Emojis** (`✨`, `●`, `▶`). **ALWAYS** use official Bootstrap Icon classes (`<i class="bi bi-stars"></i>`, `<i class="bi bi-check-lg"></i>`).
* **WinForms Layout Containers:** Section groupings must use native `.group-box` fieldset containers:

  ```html
  <div class="group-box">
    <div class="group-box-title">Section Title</div>
    <!-- Content -->
  </div>
  ```

* **Tag Taxonomy Color Mapping:**
  * Custom Concepts: `#cce5ff` background, `#b8daff` border, `#004085` text (`.tag-pill.custom-concept`).
  * Standard Tags: `#fff3cd` (`user`), `#d1ecf1` (`character`), `#ebdcf9` (`copyright`), `#e2e3e5` (`meta`).
* **Lazy DOM Rendering:** Display structural skeleton layout outlines immediately upon rendering tabs or complex view components. Defer secondary details queries and crop generation tasks using microtask delays (`setTimeout(..., 50)`) to avoid freezing the UI thread.
* **Component Sheet Reference:** Inspect the **Component Showcase Sheet view** (`index.html` -> `#view-components`) and `src/components.ts` before creating or modifying UI components.

---

## 6. Code Style & Safety Mandates

1. **No Absolute Paths:** **NEVER** write or commit absolute file paths (`C:\...`, `file:///...`). Always use repository-relative paths and portable environment resolution.
2. **NO Fallbacks Policy:** **NEVER** implement silent fallbacks (e.g., creating dummy placeholder files, silencing error responses, or copying fallback images). If a process fails, fail fast, raise a clear error, and expose the underlying issue.
3. **First-Principles Model Verification:** Before modifying inference logic in `curator-core`, create or run standalone programmatic test binaries in `curator-core/src/bin/` (e.g., `test_ort_standalone.rs`) to verify ONNX model initialization and tensor shapes step-by-step.
4. **Filesystem Safety & Binary Preservation:**
   * **NEVER** run destructive cleanup commands (`Remove-Item -Force`, `git clean -fd`) on binary runtime files (`.dll`, `.lib`, `.onnx`).
   * Preserve dependencies in isolated backup directories (e.g., `.curator_ort_dlls_backup/`) before performing directory cleanup operations.
5. **Git Workflows & Commit Guidelines:**
   * **No Automated Commits:** Do not run `git commit` or `git push` unless explicitly requested by the user.
   * **No Wildcard Staging:** Do not run `git add .` or `git add -A`. Explicitly stage target files by path.
   * **Commit Message Format:** Summarize changes with a semantic title (`type: description`), followed by detailed bullet points documenting specific file modifications.

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
