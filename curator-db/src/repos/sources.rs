use anyhow::Result;
use sqlx::SqlitePool;

pub struct SourceRepo;

impl SourceRepo {
    /// Resolve the numeric ID of a source by name (e.g. "user", "camie", "wd-eva02", "clip:vit-b-32").
    pub async fn resolve_source_id(db: &SqlitePool, name: &str) -> Result<i64> {
        let row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
            .bind(name)
            .fetch_one(db)
            .await?;
        Ok(row.0)
    }

    /// Resolve source id or return `None` if not found.
    pub async fn find_source_id(db: &SqlitePool, name: &str) -> Result<Option<i64>> {
        let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
            .bind(name)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|r| r.0))
    }
}
