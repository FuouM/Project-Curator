use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedMetadata {
    pub match_type: String,
    pub raw_matched: String,
    pub artist: Option<String>,
    pub pixiv_id: Option<String>,
    pub twitter_id: Option<String>,
    pub timestamp_4chan: Option<String>,
    pub datetime_iso: Option<String>,
    pub extracted_tags: Vec<String>,
    #[serde(default)]
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBlock {
    pub token_type: String,
    pub value: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub optional_prefix: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPreviewItem {
    pub image_id: i64,
    pub filename: String,
    pub filepath: String,
    pub match_result: Option<ParsedMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchExecutionResult {
    pub total_processed: usize,
    pub matched_count: usize,
    pub tags_created: usize,
}

pub(crate) struct BatchParseState {
    pub source_id: i64,
    pub tag_cache: std::collections::HashMap<String, i64>,
    pub matched_count: usize,
    pub tags_created: usize,
}
