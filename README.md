# Project Curator

Project Curator is a high-performance, local-first AI image curation, tagging, and semantic vector search system. It runs completely locally, protecting your privacy while enabling fast semantic image search and automatic tagging using CLIP and custom AI models.

![Project Curator Gallery Preview](assets/project_curator_gallery.png)

## Core Features

* 🔒 **Local-First & Private** – All image processing, vector databases, and AI model inference run entirely on your local machine. No data or images are ever uploaded to the cloud.
* 🛡️ **Non-Destructive** – The system indexes images and generates cached thumbnails and crops, but **never** modifies, moves, or renames your original image files.
* 🧠 **CLIP Semantic Search** – Search your local collection using natural language descriptions (powered by `ai:clip-vit-b-32`).
* 🏷️ **AI Tagger / Auto-Tagging** – Automated high-accuracy Danbooru-style tag prediction (powered by `ai:camie-tagger-v2`) alongside custom user tag concepts.
* ⚡ **Single-Writer SQLite & Vector Architecture** – Uses SQLite for structured metadata combined with a dynamic vector index, synchronized via transactional pipelines.
* 🔌 **Secure IPC Named Pipes** – High-performance communication between the dashboard, CLI, and background service via local Named Pipes (`\\.\pipe\curator_ipc`).

---

## Workspace Structure

The project is structured as a Rust Cargo workspace paired with a Tauri v2 desktop frontend:

* **[`curator-core/`](curator-core)** – Core Rust engine for fast PNG decoding, CLIP vector embeddings (via ONNX Runtime DirectML/CPU), vector similarity indexing, database migrations, and SQLite storage.
* **[`curator-service/`](curator-service)** – Background service worker managing the indexing task queues, ONNX model inference pipelines, and the IPC Named Pipe server.
* **[`curator-cli/`](curator-cli)** – Scriptable command-line interface for headless indexing, batch tagging, and testing search queries.
* **[`curator-dashboard/`](curator-dashboard)** – Native-looking desktop control center built with Tauri v2, Vite, TypeScript, and Vanilla CSS (using a modern WinForms-inspired aesthetic).

---

## Quick Start & Build Guide

Follow these steps to set up and run Project Curator on Windows:

### 1. Setup the Environment (Optional)
If you want to install Rust in an isolated local directory rather than using your system-wide installation, run:
```powershell
.\setup_env.ps1
```

### 2. Load the Environment (Optional)
If you used the local setup in step 1, load the local environment variables in every new PowerShell session before running any Cargo or development commands:
```powershell
. .\env.ps1
```
*(This maps `RUSTUP_HOME` and `CARGO_HOME` to the local `.rust/` directory. If you are using your own global Rust installation, you can skip steps 1 and 2).*

### 3. Download ONNX Runtime (DirectML)
Download the DirectML ONNX Runtime DLL needed for local hardware-accelerated CLIP/Tagger inference:
```powershell
.\download_ort.ps1
```

### 4. Launch Development Mode
Run the developer launcher script to compile the service and start the Tauri desktop GUI:
```powershell
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```

Alternatively, you can compile and run components manually:
* **Run tests**:
  ```powershell
  cargo test -p curator-core
  cargo test -p curator-service
  ```
* **Run dashboard**:
  ```powershell
  cd curator-dashboard
  npm install
  npm run tauri dev
  ```

### 5. Download AI Models
To start using semantic search and automatic tagging, you must download the CLIP and tagger models:
1. Open the running desktop dashboard.
2. Navigate to the **System Diagnostics** tab.
3. Select the **Models** sub-tab.
4. Download the required text/vision embedding and tagger models.
