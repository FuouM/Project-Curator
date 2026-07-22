# CLAUDE.md - Project Curator Developer & AI Assistant Guide

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
  Use portable PyTorch/CUDA environment at:
  `J:\REAI\ComfyUI_windows_portable_nvidia_cu128\ComfyUI_windows_portable`

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
* **Solution**: Ensure `onnxruntime.dll` exists in root (`.\onnxruntime.dll`) and target directories (`target/debug` or `target/release`). Use `.\download_ort.ps1` if missing.

### 3. CLIP Text Tokenization & Padding Rules
* **Problem**: Semantic search similarity ranking yielding incorrect or uniform scores.
* **Gotcha**: CLIP text sequence input IDs **must be padded with zeros (`0`)** up to max sequence length 77.
* **Do NOT**: Repeat `EOS` tokens across padded slots, as it corrupts positional embeddings and pooling computations inside the CLIP text transformer model.

### 4. Frontend Event Handler Modularity (`curator-dashboard`)
* **Guideline**: When rendering image cards across Gallery, Search Results, and Favorites views, use shared card event handlers (`attachCardEventHandlers`) and unified card rendering functions (`renderCards`) in `main.ts` rather than duplicating element event bindings.

---

## 5. Code Style & Standards

* **Rust**:
  * Follow Rust 2021 edition idioms.
  * Use `clippy.toml` and `rustfmt.toml` configurations.
  * Prefer explicit, non-blocking asynchronous processing for heavy IO/inference pipelines using `tokio`.
* **TypeScript / CSS**:
  * Keep components modular and single-purpose.
  * Use CSS variables and dark-mode high-contrast UI design system tokens.
  * Ensure user feedback indicators (copy status, star toggle, search loaders) are explicitly updated and reactive.
