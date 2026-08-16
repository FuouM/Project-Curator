use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
pub use curator_filename_parser::ParsedMetadata;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Source {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub manifest: Option<String>,
    pub installed_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
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
    #[sqlx(default)]
    pub is_missing: bool,
    #[sqlx(default)]
    pub width: Option<i64>,
    #[sqlx(default)]
    pub height: Option<i64>,
    #[sqlx(default)]
    pub video_frame_path: Option<String>,
    #[sqlx(default)]
    pub note: Option<String>,
    /// NSFW safety per-class probabilities; `None` = not yet classified.
    #[sqlx(default)]
    pub safe_score: Option<f32>,
    #[sqlx(default)]
    pub hentai_score: Option<f32>,
    #[sqlx(default)]
    pub porn_score: Option<f32>,
    #[sqlx(default)]
    pub sexy_score: Option<f32>,
    #[sqlx(default)]
    pub drawing_score: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ImageAnimationMetadata {
    pub image_id: i64,
    pub format: String,
    pub frame_count: i64,
    pub duration_ms: i64,
    pub loop_count: Option<i64>,
    pub is_animated: bool,
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

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub imported_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ImageParsedMetadata {
    pub id: i64,
    pub image_id: i64,
    pub rule_id: Option<i64>,
    pub match_type: String,
    pub artist: Option<String>,
    pub pixiv_id: Option<String>,
    pub twitter_id: Option<String>,
    pub timestamp_4chan: Option<String>,
    pub datetime_iso: Option<String>,
    pub extracted_tags: Option<String>,
    pub raw_matched: String,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TagStat {
    pub tag: String,
    pub category: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TagSummary {
    pub tag: String,
    pub category: String,
    pub confidence: f32,
    #[serde(default)]
    #[sqlx(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub is_blacklisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageTypeStat {
    pub category: String,
    pub extension: String,
    pub size_bytes: u64,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub stats: Vec<StorageTypeStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimationSummary {
    pub format: String,
    pub frame_count: i64,
    pub duration_ms: i64,
    pub loop_count: Option<i64>,
    pub is_animated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSummary {
    pub format: String,
    pub duration_ms: i64,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterIdentitySummary {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDetails {
    pub id: i64,
    pub sha256: String,
    pub current_filepath: String,
    pub mtime: i64,
    pub created_at: String,
    pub tags: Vec<TagSummary>,
    #[serde(default)]
    pub blacklisted_tags: Vec<TagSummary>,
    pub vector_state: String,
    pub favorite: bool,
    #[serde(default)]
    pub parsed_metadata: Option<ParsedMetadata>,
    #[serde(default)]
    pub is_missing: bool,
    #[serde(default)]
    pub character_identities: Vec<CharacterIdentitySummary>,
    #[serde(default)]
    pub ocr_text: Option<String>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub animation: Option<AnimationSummary>,
    #[serde(default)]
    pub video: Option<VideoSummary>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub safe_score: Option<f32>,
    #[serde(default)]
    pub hentai_score: Option<f32>,
    #[serde(default)]
    pub porn_score: Option<f32>,
    #[serde(default)]
    pub sexy_score: Option<f32>,
    #[serde(default)]
    pub drawing_score: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDetails {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub imported_at: String,
    pub image_count: i64,
    pub video_count: i64,
    pub vector_ready: i64,
    pub vector_pending: i64,
    pub missing_image_count: i64,
    pub missing_video_count: i64,
    pub is_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub image_count: i64,
    pub overlap_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderGroup {
    pub folders: Vec<DuplicateFolderInfo>,
    pub shared_image_count: i64,
}
