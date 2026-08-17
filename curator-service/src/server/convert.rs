//! Type conversion helpers between internal ipc domain types and the generated
//! protobuf messages used by the typed gRPC service layer.
//!
//! Domain-to-proto `From` conversions for structs defined in `curator_core`
//! live in `curator_core::ipc::grpc_helper` (required by the orphan rule).
//! This module contains only the primitive enum mapping helpers (device,
//! embedding model, precision, tagger model) shared across multiple server
//! handlers.

use curator_core::grpc::common as commonpb;
use curator_core::ipc::{DevicePreference, EmbeddingModel, ModelPrecision, TaggerModel};

pub(crate) fn device_to_proto(v: &DevicePreference) -> i32 {
    match v {
        DevicePreference::Cpu => commonpb::DevicePreference::Cpu as i32,
        DevicePreference::Gpu => commonpb::DevicePreference::Gpu as i32,
        DevicePreference::Auto => commonpb::DevicePreference::Auto as i32,
    }
}

pub(crate) fn device_from_proto(v: i32) -> DevicePreference {
    match v {
        x if x == commonpb::DevicePreference::Cpu as i32 => DevicePreference::Cpu,
        x if x == commonpb::DevicePreference::Gpu as i32 => DevicePreference::Gpu,
        _ => DevicePreference::Auto,
    }
}

pub(crate) fn precision_to_proto(v: &ModelPrecision) -> i32 {
    match v {
        ModelPrecision::Int8 => commonpb::ModelPrecision::Int8 as i32,
        ModelPrecision::Fp16 => commonpb::ModelPrecision::Fp16 as i32,
        ModelPrecision::Original => commonpb::ModelPrecision::Original as i32,
    }
}

pub(crate) fn precision_from_proto(v: i32) -> ModelPrecision {
    if v == commonpb::ModelPrecision::Int8 as i32 {
        ModelPrecision::Int8
    } else if v == commonpb::ModelPrecision::Fp16 as i32 {
        ModelPrecision::Fp16
    } else {
        ModelPrecision::Original
    }
}

pub(crate) fn embedding_from_proto(v: i32) -> EmbeddingModel {
    if v == commonpb::EmbeddingModel::MobileclipS2 as i32 {
        EmbeddingModel::MobileClipS2
    } else {
        EmbeddingModel::ClipVitB32
    }
}

pub(crate) fn embedding_to_proto(v: EmbeddingModel) -> i32 {
    match v {
        EmbeddingModel::MobileClipS2 => commonpb::EmbeddingModel::MobileclipS2 as i32,
        EmbeddingModel::ClipVitB32 => commonpb::EmbeddingModel::ClipVitB32 as i32,
    }
}

pub(crate) fn tagger_from_proto(v: Option<i32>) -> Option<TaggerModel> {
    v.and_then(|v| match v {
        x if x == commonpb::TaggerModel::WdEva02 as i32 => Some(TaggerModel::WdEva02),
        x if x == commonpb::TaggerModel::Camie as i32 => Some(TaggerModel::Camie),
        _ => None,
    })
}

pub(crate) fn tagger_to_proto(v: TaggerModel) -> i32 {
    match v {
        TaggerModel::WdEva02 => commonpb::TaggerModel::WdEva02 as i32,
        TaggerModel::Camie => commonpb::TaggerModel::Camie as i32,
    }
}
