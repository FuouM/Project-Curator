use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDetection {
    pub id: i64,
    pub image_id: i64,
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub confidence: f32,
    pub has_embedding: bool,
    pub identity_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterIdentity {
    pub id: i64,
    pub name: String,
    pub detection_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub image_id: i64,
    pub detections: Vec<StoredDetection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterInfo {
    pub cluster_id: i64,
    pub member_count: usize,
    pub identity_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReidentifyResult {
    pub total_detections: i64,
    pub matched: i64,
    pub unmatched: i64,
}
