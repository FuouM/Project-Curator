# AGENTS.md

This document establishes the architecture, development rules, safety mandates, and design system specifications for **Project Curator**. All AI agents and developers operating in this repository must strictly adhere to these guidelines.

Detailed modular documentation is available in the [`docs/`](docs/README.md) directory.

---

## 1. Project Architecture & Workspace Structure

*Full documentation: [`docs/architecture/workspace_and_runtime.md`](docs/architecture/workspace_and_runtime.md)*

The repository is structured as a Rust Cargo workspace coupled with a Tauri v2 desktop frontend:

```bash
project-curator/
├── curator-core/       # Core aggregator/orchestrator crate: DTOs, grpc_convert, re-exports of child crates
├── curator-proto/      # Leaf contracts crate: 16 Domain Protobuf specs, generated Tonic stubs, IPC transport
├── curator-filename-parser/  # Rule & tokenizer engine: presets, token blocks, batch filename parsing
├── curator-media/      # High-performance media engine: TurboJPEG decode, WebP/GIF, video, thumbnails, CropCache
├── curator-db/         # SQLite schema, migrations, models, and HNSW vector storage
├── curator-ml/         # ONNX Runtime engine: CLIP, MobileCLIP, YOLO, OCR, taggers, safety, concepts, benchmarks
├── curator-service/    # Background daemon: task queues, ONNX model pipeline, Named Pipe server
├── curator-cli/        # Scriptable CLI: headless indexing, batch query, agentic execution over gRPC
├── curator-dashboard/  # Native-looking desktop UI (Tauri v2 + Vite + TypeScript)
└── plugins/            # Sandboxed TypeScript/JavaScript desktop extensions
```

* **Core IPC Bus:** Strongly-typed gRPC services (Tonic in Rust, `@bufbuild/protobuf` in TS) over Windows Named Pipe (`\\.\pipe\curator_ipc`) for service calls, and Tauri `invoke("send_to_service_typed")` for raw Protobuf binary bytes (`.toBinary()` / `.fromBinary()`).
* **Storage Philosophy:** Relational metadata in SQLite; dense 512-d embeddings in dynamic vector index (`usearch`). Original source files are never mutated.

---

## 2. Environment Setup & Development Workflows

*Full documentation: [`docs/development/workflows_and_constraints.md`](docs/development/workflows_and_constraints.md)*

```powershell
# 1. Load local toolchain (.rust\.cargo & sccache)
. .\env.ps1

# 2. Fetch DirectML ONNX Runtime binary (if missing)
.\download_ort.ps1

# 3. Launch development server (daemon + Tauri GUI)
.\dev.ps1
```

* **Protobuf Code Generation**:
  * **Rust**: Compiled automatically by `curator-proto/build.rs` on `cargo build`.
  * **TypeScript**: `npm run gen` in `curator-dashboard` emits stubs to `src/gen/`.

---

## 3. Critical Technical & Runtime Constraints

*Full documentation: [`docs/development/workflows_and_constraints.md`](docs/development/workflows_and_constraints.md)*

1. **Service Executable Locking**: Kill `curator-service` (`Get-Process curator-service | Stop-Process -Force`) before compiling backend crates.
2. **ONNX Runtime DLL Management**: Check for `onnxruntime.dll` and `DirectML.dll` before running `download_ort.ps1`.
3. **Typed Protobuf Binary Transport**: Always use typed domain calls (`callSystem`, `callSearch`, `callGallery`, etc. in `src/ipc.ts`). No raw untyped JSON strings.
4. **Cargo Workspace Feature Alignment**: Declare shared dependencies in root `Cargo.toml` `[workspace.dependencies]` to prevent double compilation.

---

## 4. Machine Learning & Inference Pipelines

*Full documentation: [`docs/ml/inference_pipelines.md`](docs/ml/inference_pipelines.md)*

1. **CLIP Text Tokenization**: Sequence input IDs must be zero-padded to length 77; do not repeat EOS tokens across padded slots.
2. **Tensor Preprocessing**: Respect exact channel ordering (BGR for PaddleOCR det, RGB for CLIP/taggers/safety) and dynamic dimension contracts.
3. **Hardware Acceleration**: Primary DirectML provider on Windows with fallback to CPU; verify new inference graphs with standalone binaries in `curator-ml/src/bin/`.

---

## 5. Data Integrity & Database Mandates

*Full documentation: [`docs/rules/data_integrity_and_design_system.md`](docs/rules/data_integrity_and_design_system.md)*

1. **Database Schema & Migrations**: Never run ad-hoc SQL modifications on dev DBs. All changes must be structured SQL migrations in `curator-db/migrations/`.
2. **Query Performance**: Verify SQLite queries with `EXPLAIN QUERY PLAN` to eliminate full table scans.
3. **Vector vs. Tag Integrity**: Dynamic vector searches must never write auto-tags into `image_tags`. Deleting a custom concept must execute a clean row deletion without creating auto-exclusions.

---

## 6. UI & Design System Guidelines (WinForms Desktop Control Aesthetic)

*Full documentation: [`docs/rules/data_integrity_and_design_system.md`](docs/rules/data_integrity_and_design_system.md)*

* **Zero Web Abstractions**: No flashy gradients, neon glows, rounded web cards, or radial blobs.
* **Icon System**: No Unicode emojis. Always use official Bootstrap Icon classes (`<i class="bi bi-stars"></i>`).
* **WinForms Layout Containers**: Section groupings must use native `.group-box` fieldsets.
* **Tag Taxonomy**: Custom Concepts (`.tag-pill.custom-concept`), Character (`.tag-pill.tag-character`), Copyright (`.tag-pill.tag-copyright`), Meta (`.tag-pill.tag-meta`).
* **Frontend Design Skill Integration**: Intentionality & restraint, subject-grounded UI, active-voice UX vocabulary, token integrity.

---

## 7. Code Style & Safety Mandates

*Full documentation: [`docs/rules/code_style_and_safety_mandates.md`](docs/rules/code_style_and_safety_mandates.md)*

1. **No Absolute Paths**: Always use relative paths (`plugins/...`, `.curator/...`) or dynamic environment variables (`WINDIR`).
2. **NO Fallbacks / Feature Removal**: Fix root causes cleanly. Never comment out broken features or suppress tools to dodge errors.
3. **First-Principles Model Verification**: Run standalone verification binaries (`curator-ml/src/bin/`, `curator-core/src/bin/`) when modifying inference logic.
4. **Filesystem Safety**: Deletions are banned (`Remove-Item`, `rm`, `git rm`). Deprecated files must be moved to `.deprecated/`.
5. **Git Workflows**: Never commit or push without explicit user instruction in the current turn. Verify diffs with `git diff` before staging. Never commit plan files (`PLAN_*.md`).
6. **Analytical Grounding**: No magic numbers or hardcoded approximations. Derive calculations from specs and duration metrics.
7. **Research Before Command Loops**: Stop and use `search_web` after 2 failing variations.
8. **Root Implementation Plans**: Maintain authoritative plan files in the workspace root, not local agent directories.
9. **System Architecture Conformity**: Conform strictly to existing Protobuf contracts, domain services, and manager classes.
10. **Targeted Debugging**: Fix actual end-to-end pipelines; never fake state or bypass broken features.
11. **No Silent Failures**: Log explicit errors with `tracing::error!` / `console.error` and show clear UI banners.
12. **Deterministic Dependencies**: Use native package dumps (`pip freeze`, `cargo tree`, `npm ls`) when editing environment specs.
13. **Strict Scope Discipline**: Only build what was explicitly requested; no unrequested variants or modes.
14. **No Temporary Band-Aids**: Implement production-grade first-principles solutions.
15. **No False Assumptions**: Inspect source code and signatures analytically when diagnosing issues.
16. **Action First**: Apply code fixes in files before providing explanatory text.
