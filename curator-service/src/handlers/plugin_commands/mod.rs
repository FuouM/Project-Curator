//! Command handlers for the plugin gRPC dispatch surface.
//!
//! Each submodule owns a coherent group of generic plugin commands
//! (`PluginDb*`, sandboxed file operations, network transport, media
//! pipelines, tool installation, downloads, and plugin-runtime installs).
//! `server/plugins.rs` keeps a single declarative `match` that routes each
//! command string to these handlers; the actual parameter parsing, sandbox
//! canonicalization, and JSON marshalling live here.

pub mod db;
pub mod download;
pub mod media;
pub mod network;
pub mod runtime;
pub mod storage;
pub mod tools;
