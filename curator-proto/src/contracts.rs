use serde::{Deserialize, Serialize};

/// Device selection for ONNX model inference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum DevicePreference {
    /// Try GPU first, fall back to CPU if unavailable.
    #[default]
    Auto,
    /// Force CPU-only execution.
    Cpu,
    /// Force GPU execution (fails if no GPU provider available).
    Gpu,
}

/// Model precision/format variant preference.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModelPrecision {
    #[default]
    Original,
    Int8,
}

/// Supported embedding models.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum EmbeddingModel {
    #[serde(rename = "clip-vit-b-32")]
    #[default]
    ClipVitB32,
    #[serde(rename = "mobileclip-s2")]
    MobileClipS2,
}

/// A tagger model selectable at runtime. `camie` is the default.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TaggerModel {
    #[default]
    Camie,
    WdEva02,
}

impl TaggerModel {
    pub fn key(&self) -> &'static str {
        match self {
            TaggerModel::Camie => "camie-tagger-v2",
            TaggerModel::WdEva02 => "wd-eva02-tagger-2026-canary",
        }
    }

    pub fn source_name(&self) -> &'static str {
        match self {
            TaggerModel::Camie => crate::constants::SOURCE_CAMIE,
            TaggerModel::WdEva02 => crate::constants::SOURCE_WD_EVA02,
        }
    }
}

impl EmbeddingModel {
    pub fn source_name(&self) -> &'static str {
        match self {
            EmbeddingModel::ClipVitB32 => crate::constants::SOURCE_CLIP,
            EmbeddingModel::MobileClipS2 => crate::constants::SOURCE_MOBILECLIP,
        }
    }
}