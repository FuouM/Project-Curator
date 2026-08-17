use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub(crate) struct MetadataRoot {
    pub(crate) model_info: ModelInfo,
    pub(crate) dataset_info: DatasetInfo,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ModelInfo {
    pub(crate) img_size: u32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DatasetInfo {
    pub(crate) tag_mapping: TagMapping,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TagMapping {
    pub(crate) idx_to_tag: HashMap<String, String>,
    pub(crate) tag_to_category: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct TagPrediction {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
}

/// Static configuration describing a tagger model. Both taggers consume the
/// same camie-format `MetadataRoot` JSON; the model-specific details live here.
#[derive(Debug, Clone)]
pub struct TaggerModelSpec {
    pub key: &'static str,
    pub display_name: &'static str,
    pub source_name: &'static str,
    /// Subdirectory under the models dir that holds this model's files.
    pub dir: &'static str,
    pub onnx_filename: &'static str,
    pub metadata_file: &'static str,
    pub input_size: u32,
    pub mean: [f32; 3],
    pub std: [f32; 3],
    pub pad_color: [u8; 3],
    pub default_threshold: f32,
    /// ONNX output tensor names, tried in order.
    pub output_names: &'static [&'static str],
}

pub const CAMIE_SPEC: TaggerModelSpec = TaggerModelSpec {
    key: "camie-tagger-v2",
    display_name: "Camie Tagger v2",
    source_name: "ai:camie-tagger-v2",
    dir: "camie-tagger-v2",
    onnx_filename: "camie-tagger-v2.onnx",
    metadata_file: "camie-tagger-v2-metadata.json",
    input_size: 512,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    pad_color: [124, 116, 104],
    default_threshold: 0.50,
    output_names: &["refined_predictions", "output_1", "output_0"],
};

pub const WD_EVA02_SPEC: TaggerModelSpec = TaggerModelSpec {
    key: "wd-eva02-tagger-2026-canary",
    display_name: "WD EVA02 Tagger 2026 Canary",
    source_name: "ai:wd-eva02-tagger-2026-canary",
    dir: "wd-eva02-tagger-2026-canary",
    onnx_filename: "wd-eva02-tagger-2026-canary.onnx",
    metadata_file: "wd-eva02-tagger-2026-canary-metadata.json",
    input_size: 448,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    pad_color: [0, 0, 0],
    default_threshold: 0.6094,
    output_names: &["logits"],
};

#[derive(Debug, Clone)]
pub struct TaggerStatus {
    pub loaded: bool,
    pub model_path: String,
    pub total_tags: usize,
}

/// Serialized status snapshot for one tagger, surfaced in Settings /
/// DashboardInit so the UI can list all configured taggers and their load state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaggerStatusInfo {
    pub key: String,
    pub name: String,
    pub source_name: String,
    pub loaded: bool,
    pub model_path: String,
    pub total_tags: usize,
    pub default_threshold: f32,
    pub input_size: u32,
}

pub(crate) struct TaggerMetadata {
    pub(crate) img_size: u32,
    pub(crate) tags_by_index: Vec<(String, String)>,
    pub(crate) total_tags: usize,
}
