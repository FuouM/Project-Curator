# Project Architecture & Workspace Structure

Project Curator is organized as a modular Rust Cargo workspace coupled with a Tauri v2 desktop frontend:

```bash
project-curator/
├── curator-core/       # Core aggregator/orchestrator crate: DTOs, grpc_convert, re-exports of child crates
├── curator-proto/      # Leaf contracts crate: 16 Domain Protobuf specs, generated Tonic stubs,
│   └── proto/          #   shared kernel (DevicePreference/TaggerModel/etc.), constants, util, pipeline traits, IPC transport
├── curator-filename-parser/  # Rule & tokenizer engine: presets, token blocks, batch filename parsing
├── curator-media/      # High-performance media engine: TurboJPEG decode, WebP/GIF, video, thumbnails, CropCache
├── curator-db/         # SQLite schema, migrations, models, and HNSW vector storage
├── curator-ml/         # ONNX Runtime engine: CLIP, MobileCLIP, YOLO, OCR, taggers, safety, concepts, benchmarks
├── curator-service/    # Background daemon: task queues, ONNX model pipeline, Named Pipe server
│   └── src/server/     # Domain gRPC service implementations (SystemServiceClient, SearchServiceClient, etc.)
├── curator-cli/        # Scriptable CLI: headless indexing, batch query, agentic execution over gRPC
├── curator-dashboard/  # Native-looking desktop UI (Tauri v2 + Vite + TypeScript)
│   ├── src-tauri/      # Rust backend glue & typed binary IPC bridge (send_to_service_typed)
│   └── src/            # TypeScript UI components, RPC clients (callSearch, callGallery), and gen/ stubs
├── plugins/            # Sandboxed TypeScript/JavaScript desktop extensions
└── .curator/           # Local runtime state: cached models, vector indexes, SQLite database
```

---

## Core IPC Bus

All client-to-service communication is strongly-typed gRPC (Tonic in Rust, `@bufbuild/protobuf` in TypeScript) over local transports:

- **Windows**: Named Pipe (`\\.\pipe\curator_ipc`)
- **Unix / macOS**: Domain Socket (`~/.curator/curator.sock`)

Frontend-to-daemon communication serializes Protobuf messages directly to raw binary bytes (`.toBinary()` / `.fromBinary()`) sent through Tauri's `send_to_service_typed` IPC command. A per-installation service key authenticates clients.

---

## Storage Philosophy

1. **Relational Metadata**: Managed in SQLite (`sqlx` with strict versioned migrations in `curator-db/migrations/`).
2. **Dense Vector Embeddings**: 512-dimensional embeddings managed in an isolated dynamic in-memory vector index (`usearch`).
3. **Non-Destructive Guarantee**: Original source files, embedded sidecars, and user folder layouts are never mutated, renamed, or deleted. All analysis, thumbnails, and tags are stored and cached in isolation.
