# Environment Setup, Development Workflows & Runtime Constraints

## 1. Environment Setup & Development Commands

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

### Protobuf Code Generation

- **Rust**: `curator-proto/build.rs` compiles `curator-proto/proto/*.proto` automatically during `cargo build` / `cargo check`.
- **TypeScript**: `npm run gen` (runs `npx buf generate ../curator-proto/proto`) emits TS stubs to `curator-dashboard/src/gen/`. Triggered automatically by `dev.ps1` and `npm run dev`.

---

## 2. Build & Test Verification

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

Before running `.\download_ort.ps1`, **ALWAYS** check if `onnxruntime.dll` and `DirectML.dll` already exist in the repository root or target directories (`target/debug` / `target/release`).

- Ensure the workspace root is added to `$env:PATH` (e.g. `$env:PATH = "$PWD;$env:PATH"`) or the DLLs exist in the active target build folder so `ort` can bind to them.
- **Only** execute `.\download_ort.ps1` if the DLL files are completely missing from the project workspace.

### 3. ML Inference & Tokenization Rules

All model preprocessing, tensor shapes, and tokenization constraints (including CLIP fixed length 77 zero-padding without EOS repetition, BGR/RGB channel ordering, and dynamic OCR dimensions) are documented in [`docs/ml/inference_pipelines.md`](../ml/inference_pipelines.md).

### 4. IPC Latency & Protobuf Architecture

- **Typed Protobuf Binary Transport**: Do NOT use legacy untyped `Request`/`Response` JSON strings or `callService`. All frontend-backend communication uses domain-specific call functions (`callSystem`, `callSearch`, `callGallery`, `callImport`, `callTags`, etc. in `src/ipc.ts`) that serialize Protobuf messages to raw binary bytes (`.toBinary()`) sent through Tauri's `send_to_service_typed` IPC command.
- **Adding New RPCs / Types**:
  1. Add/modify the message or RPC definition in `curator-proto/proto/<domain>.proto`.
  2. Implement the gRPC trait handler in `curator-service/src/server/<domain>.rs`.
  3. Re-run `dev.ps1` (or `cargo check` + `npm run gen` in `curator-dashboard`).
  4. Import generated TS classes from `./gen/<domain>_pb` and use domain helper `call<Domain>`.
- **Indexed Pattern Search:** Autocomplete components must perform dynamic `LIKE` queries on keypress rather than pre-fetching large data arrays over IPC. Keep response payloads small to guarantee sub-10ms response times.

### 5. Workspace Dependency & Feature Alignment (Double Compilation Prevention)

- **Workspace Centralization**: All new third-party crates added to child packages **MUST** first be defined in the root `Cargo.toml` `[workspace.dependencies]` table (specifying versions and baseline features) and inherited in child packages using `{ workspace = true }`.
- **Transitive Feature Union Alignment**: If a third-party crate is transitively shared between the service and the Tauri dashboard with mismatched features, the unified features **MUST** be explicitly declared in the root workspace dependency, and that dependency **MUST** be added to `curator-core/Cargo.toml` to guarantee Cargo resolves identical build graphs for both target binaries.
- **Feature Profile Unification**: Never mix `default-features = true` and `default-features = false` states when importing shared internal workspace crates (like `curator-core`) across different target packages. To prevent Cargo from resolving separate dependency feature subgraphs (which triggers a full rebuild when switching targets), always import shared internal crates using their default features. Do not declare `default-features = false` for internal workspace dependencies.
