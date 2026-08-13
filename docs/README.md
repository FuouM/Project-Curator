# Project Curator Documentation

Welcome to the Project Curator technical documentation hub.

---

## 🏛️ Architecture & System Design

- [**Workspace & Runtime Architecture**](architecture/workspace_and_runtime.md) — Rust workspace structure, single-writer background daemon, typed binary gRPC IPC bus, storage philosophy.
- [**Design Document (Reference)**](old/curator_design_document.md) — Core architectural specification and engine subsystem breakdown.

---

## 🧠 Machine Learning & Inference Pipelines

- [**ML Models, Preprocessing & Tokenization**](ml/inference_pipelines.md) — Supported models, CLIP/MobileCLIP 77-token zero-padding rules, tensor normalization, and hardware execution providers.
- [**ML Porting Guide**](old/porting_ml_inference_guide.md) — Porting models, ONNX Runtime execution providers, tensor shapes.
- [**Image Processing Guide**](old/IMAGE_PROCESSING_FOR_AGENTS.md) — TurboJPEG, WebP, GIF, video thumbnails, and crop caching.

---

## 🛠️ Development & Engineering

- [**Development Workflows & Runtime Constraints**](development/workflows_and_constraints.md) — PowerShell toolchain setup, dev server, ORT DirectML DLLs, CLIP tokenization, IPC latency, double-compilation prevention.
- [**Data Integrity & Design System**](rules/data_integrity_and_design_system.md) — SQLite migrations, query performance, vector integrity, WinForms desktop control aesthetic tokens.
- [**Code Style & Safety Mandates**](rules/code_style_and_safety_mandates.md) — 16 core safety mandates, filesystem preservation, git workflow, self-adversarial audits.

---

## 🧩 Plugin Development

- [**Plugin Overview & Distribution**](plugins/overview.md) — Portable distribution, security hardening, plugin execution model.
- [**Workspace & Manifest**](plugins/workspace_and_manifest.md) — Directory layouts, TypeScript build tooling, `manifest.json` schema.
- [**PluginHost API Reference**](plugins/plugin_host_api.md) — `window.PluginHost` interface specification, multi-segment asset URL resolution.
- [**UI & Native Event Integration**](plugins/ui_and_native_events.md) — WinForms controls, Tauri v2 native drag-and-drop listener.
- [**Performance & Architectural Patterns**](plugins/performance_and_patterns.md) — GPU compositing, RAF loops, non-destructive file collision, iframe bridge error relays, canvas readback fixes.
- [**Reference Implementation & Checklist**](plugins/example_plugin.md) — Self-contained plugin template and pre-commit verification checklist.
