use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Source {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub manifest: Option<String>,
    pub installed_at: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Image {
    pub id: i64,
    pub sha256: String,
    pub phash: Option<String>,
    pub current_filepath: String,
    pub os_file_id: Option<String>,
    pub mtime: i64,
    pub created_at: NaiveDateTime,
    pub deleted_at: Option<NaiveDateTime>,
    pub favorite: bool,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub category: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ImageTag {
    pub id: i64,
    pub image_id: i64,
    pub tag_id: i64,
    pub source_id: i64,
    pub confidence: Option<f32>,
    pub transaction_id: String,
    pub applied_at: NaiveDateTime,
    pub is_deleted: i64, // 0 or 1 in SQLite
    pub deleted_at: Option<NaiveDateTime>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ImageVector {
    pub id: i64,
    pub image_id: i64,
    pub source_id: i64,
    pub vector_id: String,
    pub vector_checksum: Option<String>,
    pub vector_state: String,
    pub created_at: NaiveDateTime,
}
