# Project Curator Documentation Hub

Welcome to the Project Curator technical documentation directory.

---

## 🏛️ Architecture & System Design

- [**Workspace & Runtime Architecture**](architecture/workspace_and_runtime.md) — Rust workspace structure, single-writer background daemon, typed binary gRPC IPC bus, storage philosophy.
- [**Initial Design Document (Archival Reference)**](old/curator_design_document.md) — Initial foundational architecture blueprint and subsystem breakdown, preserved for historical reference.

---

## 🧠 Machine Learning & Inference Pipelines

- [**ML Models, Preprocessing & Tokenization**](ml/inference_pipelines.md) — Supported model pipelines, CLIP/MobileCLIP 77-token zero-padding rules, tensor normalization, and hardware execution providers.
- [**ML Inference Porting Field Guide**](ml/porting_guide.md) — Deep-dive guide for porting Python ONNX/Safetensors models to Rust `ort`, covering all 9 production pitfalls and step-by-step debugging.

---

## 🖼️ Media Engine & Image Processing

- [**High-Performance Media & Tensor Preprocessing**](media/image_and_video_processing.md) — Fast native decoding (`turbojpeg`, `libwebp`, `png`), SIMD resizing (`fast_image_resize`), contiguous slice NCHW tensor projection, and video probing.

---

## 🛠️ Development & Engineering Mandates

- [**Development Workflows & Runtime Constraints**](development/workflows_and_constraints.md) — PowerShell toolchain setup, dev server, ORT DirectML DLLs, typed binary IPC transport, and double-compilation prevention.
- [**Data Integrity & Design System**](rules/data_integrity_and_design_system.md) — SQLite migrations, query performance, vector integrity, WinForms desktop control aesthetic tokens.
- [**Code Style & Safety Mandates**](rules/code_style_and_safety_mandates.md) — 16 core safety mandates, filesystem preservation, git workflows, analytical grounding, and action-first protocol.

---

## 🧩 Plugin Development

- [**Plugin Overview & Distribution**](plugins/overview.md) — Portable distribution, security hardening, plugin execution model.
- [**Workspace & Manifest**](plugins/workspace_and_manifest.md) — Directory layouts, TypeScript build tooling, `manifest.json` schema.
- [**PluginHost API Reference**](plugins/plugin_host_api.md) — `window.PluginHost` interface specification, multi-segment asset URL resolution.
- [**UI & Native Event Integration**](plugins/ui_and_native_events.md) — WinForms controls, Tauri v2 native drag-and-drop listener.
- [**Performance & Architectural Patterns**](plugins/performance_and_patterns.md) — GPU compositing, RAF loops, non-destructive file collision, iframe bridge error relays, canvas readback fixes.
- [**Reference Implementation & Checklist**](plugins/example_plugin.md) — Self-contained plugin template and pre-commit verification checklist.
