# Project Curator

A high-performance, local-first asset curation engine engineered for multi-million image archives, unified source aggregation, and multi-modal semantic discovery.

![Project Curator Gallery Preview](assets/project_curator_gallery.png)

## Overview

Modern digital asset management software frequently degrades at multi-million asset scales or fragments collections across isolated tools, download managers, and custom directory structures. **Project Curator** operates as a centralized hub designed to aggregate local storage hierarchies, specialized database networks (such as Hydrus), and automated download pipelines into a single, high-throughput indexing and retrieval engine.

Built with Rust and Tauri, the system prioritizes computational performance, data integrity, and local execution:

* **Multi-Million Asset Scale:** Engineered to maintain sub-millisecond query performance across massive photo archives, art collections, and visual research libraries while consuming minimal system memory.
* **Unified Source Aggregator:** Ingests and synchronizes metadata across arbitrary folder/filename hierarchies, download manager outputs, and external database systems without requiring data migration.
* **Non-Destructive Local Indexing:** Reads, analyzes, and caches vectors and metadata in isolation. Original files, folder structures, and embedded sidecars are never modified or moved.
* **Deterministic Local Inference:** All feature extraction, vector generation, OCR, and automated tag predictions execute entirely on local hardware via DirectML and CPU runtimes. No data ever leaves the local environment.

---

## Multi-Modal Search Engine

Project Curator combines structured relational querying with deep learning inference, allowing users to locate assets using a wide range of complementary search modalities:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PROJECT CURATOR SEARCH                           │
├─────────────────┬──────────────────┬──────────────────┬─────────────────────┤
│  CLIP Semantic  │ Danbooru Tagging │ Visual Similarity│    OCR Text Search  │
│ (Natural Lang)  │ (Auto-Tagger V2) │ (Reverse Search) │  (Embedded Text)    │
├─────────────────┴──────────────────┴──────────────────┴─────────────────────┤
│     Filename Regex Parsing      │   [Experimental] Custom Trained Concepts  │
└─────────────────────────────────┴───────────────────────────────────────────┘
```

1. **Semantic Vector Search (CLIP):** Natural language queries mapped to high-dimensional visual feature spaces, enabling retrieval based on mood, visual composition, subject matter, or abstract concepts.
2. **Danbooru-Style Tag Taxonomy:** Automatic classification using vision transformers trained on Danbooru tag distributions, supporting namespace categories, exact boolean logic, and negative constraints.
3. **Visual & Semantic Reverse Image Search** Vector-based visual matching using stored image embeddings. Input images can be queried to instantly locate compositional variations, structural duplicates, and conceptually or semantically related assets across the archive.
4. **Optical Character Recognition (OCR):** In-image text extraction and indexing, allowing full-text search against signage, embedded document text, typography, or overlaid text within images.
5. **Custom Filename Regex Parsing:** User-defined regular expression rules to dynamically extract metadata, artist names, dates, or custom IDs from complex filename conventions upon ingestion.
6. **Experimental Concept Training:** Local support for user-trained visual concept vectors, enabling personalized similarity matching for distinct artistic styles or niche subjects.

---

## System Architecture & Interoperability

The architecture decouples heavy database operations and model inference from the user interface to guarantee responsiveness during massive indexing tasks.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                 Desktop User Interface (Tauri v2 GUI)                   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ IPC Named Pipe
                                     │ (\\.\pipe\curator_ipc)
┌────────────────────────────────────▼────────────────────────────────────┐
│                    Background Curator Service Engine                    │
├───────────────────┬─────────────────────────────────┬───────────────────┤
│  SQLite Metadata  │ DirectML Vector Inference Engine│   LLM Agent CLI   │
└───────────────────┴─────────────────────────────────┴───────────────────┘
```

* **Graphical User Interface:** Built with Tauri v2 and Vite for desktop usage, managing background tasks and search workflows natively.
* **Agentic CLI Interface:** A headless command-line interface exposes full search, indexing, and tagging functionality for integration with local LLM agents and automated scripts.
* **Decoupled Service Engine:** A background service executes heavy IO, ONNX Runtime (DirectML/CPU) model evaluation, and SQLite database synchronization. Communication occurs over local Named Pipes (`\\.\pipe\curator_ipc`).

---

## Ingestion & Hub Integration

Project Curator acts as a unified aggregation layer across fragmented workflows:

* **Hydrus Network Import:** Ingests and maps existing Hydrus database stores and tag relationships directly into the Curator unified index.
* **Folder & Filename Parsing:** Accommodates arbitrary file directory depth and custom file-naming schemas without imposing rigid directory structures.
* **Download Manager Ingestion:** Monitors and indexes incoming visual assets from automated download managers and web harvesters in real time.

---

## Performance & System Requirements

Designed for low resource overhead on modern Windows systems, maintaining efficiency even when indexing libraries containing millions of entries.

Currently only support Windows 10 via DirectML. SSD is recommended for database & vector index.

*Note: While GPU execution via DirectML yields significantly faster inference speeds, CPU fallback execution is fully supported.*

---

## Build & Setup Guide

Currently, Project Curator is built from source. Automated environment scripts handle the dependency installation and compilation pipeline. *(A portable, self-contained ZIP executable release is planned).*

### Prerequisites

* Windows 10
* PowerShell 5.1 or higher

### Installation Steps

1. **Clone the Repository:**

   ```powershell
   git clone https://github.com/FuouM/Project-Curator
   cd Project-Curator
   ```

2. **Initialize Local Environment (Optional):**
   To isolate Rust tooling within the workspace directory:

   ```powershell
   .\setup_env.ps1
   . .\env.ps1
   ```

3. **Fetch ONNX Runtime (DirectML):**
   Download required local inference DLLs:

   ```powershell
   .\download_ort.ps1
   ```

4. **Launch Development Mode:**
   Compile the background service and start the desktop GUI:

   ```powershell
   .\dev.ps1
   ```

5. **Model Initialization:**
   * Open the Project Curator GUI.
   * Navigate to **System Diagnostics** → **Models**.
   * Download the required local CLIP text/vision and Danbooru auto-tagger models.
