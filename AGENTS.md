# AGENTS.md

This document establishes the architecture, development rules, safety mandates, and design system specifications for **Project Curator**. All AI agents and developers operating in this repository must strictly adhere to these guidelines.

---

## 1. Project Architecture & Workspace Structure

The repository is structured as a Rust Cargo workspace coupled with a Tauri v2 desktop frontend:

```bash
project-curator/
├── curator-core/       # Core Rust engine: PNG decoding, CLIP embeddings, vector indexing, SQLite, proto files
│   └── proto/          # Domain Protobuf specifications (15 services: system, search, gallery, etc.)
├── curator-service/    # Background daemon: task queues, ONNX model pipeline, Named Pipe server
│   └── src/server/     # Domain gRPC service implementations (SystemServiceClient, SearchServiceClient, etc.)
├── curator-cli/        # Scriptable CLI: headless indexing, batch query, agentic execution over gRPC
├── curator-dashboard/  # Native-looking desktop UI (Tauri v2 + Vite + TypeScript)
│   ├── src-tauri/      # Rust backend glue & typed binary IPC bridge (send_to_service_typed)
│   └── src/            # TypeScript UI components, RPC clients (callSearch, callGallery), and gen/ stubs
└── .curator/           # Local runtime state: cached models, vector indexes, SQLite database
```

* **Core IPC Bus:** Strongly-typed gRPC services (Tonic in Rust, `@bufbuild/protobuf` in TS) over Windows Named Pipe (`\\.\pipe\curator_ipc`) for service calls, and Tauri `invoke("send_to_service_typed")` for raw Protobuf binary bytes (`.toBinary()` / `.fromBinary()`) between frontend and daemon.
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

# 3. Launch full development server (stops background service, generates protobuf types, builds, and starts Tauri GUI)
.\dev.ps1
```

* **Protobuf Code Generation**:
  * **Rust**: `curator-core/build.rs` compiles `curator-core/proto/*.proto` automatically during `cargo build` / `cargo check`.
  * **TypeScript**: `npm run build:proto` (runs `npx buf generate`) emits TS stubs to `curator-dashboard/src/gen/`. Triggered automatically by `dev.ps1` and `npm run dev`.

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

### 4. IPC Latency & Protobuf Architecture

* **Typed Protobuf Binary Transport**: Do NOT use legacy untyped `Request`/`Response` JSON strings or `callService`. All frontend-backend communication uses domain-specific call functions (`callSystem`, `callSearch`, `callGallery`, `callImport`, `callTags`, etc. in `src/ipc.ts`) that serialize Protobuf messages to raw binary bytes (`.toBinary()`) sent through Tauri's `send_to_service_typed` IPC command.
* **Adding New RPCs / Types**:
  1. Add/modify the message or RPC definition in `curator-core/proto/<domain>.proto`.
  2. Implement the gRPC trait handler in `curator-service/src/server/<domain>.rs`.
  3. Re-run `dev.ps1` (or `cargo check` + `npm run build:proto` in `curator-dashboard`).
  4. Import generated TS classes from `./gen/<domain>_pb` and use domain helper `call<Domain>`.
* **Indexed Pattern Search:** Autocomplete components must perform dynamic `LIKE` queries on keypress rather than pre-fetching large data arrays over IPC. Keep response payloads small to guarantee sub-10ms response times.

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
* **Layout Stretching & Centering**: Flex-child components like `.toolbox-drop-zone` must specify `align-self: stretch; width: 100%; height: 100%` when nested within centered container layouts (e.g. `align-items: center`), preventing them from collapsing to the width of their inner text.
* **Pointer Events on Interactive Media**: When rendering media elements with browser controls (such as `<video controls>`), ensure they are not blocked by overlay containers or blanket parent classes; set `pointer-events: auto;` specifically on interactive media elements so seeking and playback work normally.

---

## 6. Code Style & Safety Mandates

1. **No Absolute Paths:** **NEVER** write or commit absolute file paths (`C:\...`, `file:///...`, `K:\...`). Always use repository-relative paths and portable environment resolution:
   * **JavaScript/Frontend**: Always use relative paths (`plugins/gif-maker/...` or `.curator/...`) for assets resolved by `convertFileSrc`. Do not write system path fallbacks like `"C:\\Windows\\Temp"` or invoke server-side APIs (like `std.env.temp_dir`) in frontend JS contexts.
   * **Rust/Backend**: For OS system paths (e.g. system fonts), dynamically query environment variables such as `std::env::var("WINDIR")` instead of hardcoding absolute system paths.
2. **NO Fallbacks / Feature Removal Policy:** **NEVER** implement silent fallbacks, comment out broken logic, or strip out features (such as `sccache`, test suites, or performance configurations) simply to bypass or dodge an error. When an error or warning occurs, diagnose and fix the root cause properly. Fail fast, preserve required tooling, and expose underlying issues cleanly.

3. **First-Principles Model Verification:** Before modifying inference logic in `curator-core`, create or run standalone programmatic test binaries in `curator-core/src/bin/` (e.g., `test_ort_standalone.rs`) to verify ONNX model initialization and tensor shapes step-by-step.
4. **Filesystem Safety & Preservation Mandate:**
   * **Deletion Banned:** **NEVER** delete files using `Remove-Item`, `git rm`, `rm`, or `Remove-Item -Force`.
   * **Deprecation Protocol:** Any file, document, plan (`PLAN_*.md`), or component designated for removal **must** be moved into a `.deprecated/` folder instead of being deleted.
   * **Binary Preservation:** Preserve binary runtime dependencies (`.dll`, `.lib`, `.onnx`) in isolated directories (`.curator_ort_dlls_backup/`). Do not clean or wipe them.
5. **Git Workflows & Commit Guidelines:**
   * **No Automated Commits:** **NEVER** run `git commit` or `git push` unless the user explicitly requests it in the *current turn's conversation*. Do not assume a prior commit request applies to subsequent changes, and never preemptively commit new edits.
   * **Verify Diff Before Committing:** When requested to commit, **always** run and inspect `git diff` first to verify the exact changes. This ensures you do not stage unintended modifications or accidentally overwrite the work of other concurrent agents operating outside of your context.
   * **No Wildcard Staging:** Do not run `git add .` or `git add -A`. Explicitly stage target files by path.
   * **Commit Message Format:** Summarize changes with a semantic title (`type: description`), followed by detailed bullet points documenting specific file modifications.
6. **No Lazy Implementations / Strict Analytical Grounding:**
   * **NEVER** use hardcoded approximations, generic magic numbers, or static defaults (such as a hardcoded frame rate fallback or dummy overhead percentage) when the actual parameters can be probed or calculated.
   * Refactor resource pipelines to fetch required metadata once at logical boundaries. Avoid duplicate process spawning (e.g. running multiple `ffprobe` operations on the same asset).
   * Derive calculations, allocations, and constraints mathematically from format specifications, track counts, and duration metrics.
   * **Self-Adversarial Verification:** Before finalizing any task, the agent must perform an explicit meta-cognitive self-audit. Inspect your own implementation plan and output code for hidden laziness, magic safety numbers, or unresolved assumptions. Force yourself to outline and justify these decisions, and refactor any shortcut into a mathematically sound, first-principles solution.
7. **Research Before Attempting / No Blind Command Loops:**
   * **NEVER** attempt more than 2 variations of the same failing command without first stopping to research why it is failing. Repeating the same command with minor flag changes is not debugging — it is noise.
   * When a command, tool, or library fails in an unexpected or persistent way, **immediately use `search_web`** to determine whether the failure is caused by a version limitation, a known bug, or a fundamental capability gap — before writing any code or running any more commands.
   * **Version limitations are blockers, not configuration problems.** If a tool version does not support a feature (e.g., FFmpeg < 9.0 cannot decode animated WebPs), no amount of flag tweaking will fix it. Identify the version requirement first, then escalate to updating the tool or choosing an alternative approach.
   * When a tool needs to be updated to resolve a capability gap, do it — do not loop on workarounds that cannot work.

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
