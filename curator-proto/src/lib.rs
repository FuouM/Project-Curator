//! Domain protobuf specifications, generated Tonic gRPC stubs, the shared kernel
//! contracts (`curator-proto` is the workspace leaf crate), and Named-Pipe / UDS
//! transport helpers.
//!
//! Every sibling crate depends on `curator-proto`, and `curator-core` re-exports
//! its public API so downstream consumers (`curator-service`, `curator-cli`,
//! `curator-dashboard/src-tauri`) compile without call-site changes.

pub mod ipc;
pub mod contracts;
pub mod constants;
pub mod util;
pub mod pipeline;

pub use contracts::{DevicePreference, EmbeddingModel, ModelPrecision, TaggerModel};

pub mod grpc {
    pub mod common {
        tonic::include_proto!("curator.common");
    }
    pub mod system {
        tonic::include_proto!("curator.system");
    }
    pub mod import {
        tonic::include_proto!("curator.import");
    }
    pub mod gallery {
        tonic::include_proto!("curator.gallery");
    }
    pub mod search {
        tonic::include_proto!("curator.search");
    }
    pub mod tags {
        tonic::include_proto!("curator.tags");
    }
    pub mod tagging {
        tonic::include_proto!("curator.tagging");
    }
    pub mod characters {
        tonic::include_proto!("curator.characters");
    }
    pub mod ocr {
        tonic::include_proto!("curator.ocr");
    }
    pub mod concepts {
        tonic::include_proto!("curator.concepts");
    }
    pub mod models {
        tonic::include_proto!("curator.models");
    }
    pub mod tools {
        tonic::include_proto!("curator.tools");
    }
    pub mod folders {
        tonic::include_proto!("curator.folders");
    }
    pub mod benchmarks {
        tonic::include_proto!("curator.benchmarks");
    }
    pub mod plugins {
        tonic::include_proto!("curator.plugins");
    }
    pub mod parser {
        tonic::include_proto!("curator.parser");
    }
}