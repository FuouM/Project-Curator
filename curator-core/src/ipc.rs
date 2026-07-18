use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum Request {
    Ping,
    ImportImage {
        path: String,
    },
    AddTag {
        image_id: i64,
        tag: String,
        category: String,
    },
    RemoveTag {
        image_id: i64,
        tag_id: i64,
    },
    Search {
        query_text: Option<String>,
        tag_filter: Option<String>,
        limit: usize,
    },
    GetStatus,
    GetImage {
        image_id: i64,
    },
    ListImages {
        limit: usize,
        offset: usize,
    },
    ValidatePlugin {
        manifest_path: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Response {
    Pong,
    Success,
    Error {
        message: String,
    },
    ImportResult {
        image_id: i64,
        sha256: String,
    },
    SearchResult {
        matches: Vec<SearchMatch>,
    },
    StatusResult {
        image_count: i64,
        vector_count: i64,
        pending_jobs: i64,
    },
    ImageResult {
        image: ImageDetails,
    },
    ListResult {
        images: Vec<ImageDetails>,
    },
    ValidationResult {
        name: String,
        version: String,
        valid: bool,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub id: i64,
    pub filepath: String,
    pub score: f32,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDetails {
    pub id: i64,
    pub sha256: String,
    pub current_filepath: String,
    pub mtime: i64,
    pub created_at: String,
    pub tags: Vec<String>,
    pub vector_state: String,
}
