use std::collections::HashMap;
use serde::Deserialize;

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

#[derive(Debug, Clone)]
pub struct TaggerStatus {
    pub loaded: bool,
    pub model_path: String,
    pub total_tags: usize,
}

pub(crate) struct TaggerMetadata {
    pub(crate) img_size: u32,
    pub(crate) idx_to_tag: HashMap<String, String>,
    pub(crate) tag_to_category: HashMap<String, String>,
    pub(crate) total_tags: usize,
}
