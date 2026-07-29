use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::path::Path;
use std::sync::Arc;
use tracing::info;

const DEFAULT_MAX_ENTRIES: usize = 200_000;

pub struct CropCache {
    db: SqlitePool,
}

impl CropCache {
    pub async fn open(path: &Path) -> Result<Arc<Self>> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

        let db = SqlitePool::connect_with(options).await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS detection_crops (
                detection_id INTEGER PRIMARY KEY,
                size         INTEGER NOT NULL,
                data         BLOB NOT NULL,
                created_at   INTEGER NOT NULL
            )",
        )
        .execute(&db)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_detection_crops_created_at ON detection_crops(created_at)",
        )
        .execute(&db)
        .await?;

        info!("Crop cache opened at {:?}", path);
        Ok(Arc::new(Self { db }))
    }

    pub async fn get(&self, detection_id: i64) -> Option<Vec<u8>> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT data FROM detection_crops WHERE detection_id = ?")
                .bind(detection_id)
                .fetch_optional(&self.db)
                .await
                .ok()?;

        row.map(|(data,)| data)
    }

    pub async fn put(&self, detection_id: i64, size: u32, data: &[u8]) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        sqlx::query(
            "INSERT OR REPLACE INTO detection_crops (detection_id, size, data, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(detection_id)
        .bind(size)
        .bind(data)
        .bind(now)
        .execute(&self.db)
        .await?;

        self.evict_if_needed(DEFAULT_MAX_ENTRIES).await?;
        Ok(())
    }

    pub async fn evict_lru(&self, count: usize) -> Result<usize> {
        let result = sqlx::query(
            "DELETE FROM detection_crops WHERE detection_id IN (SELECT detection_id FROM detection_crops ORDER BY created_at ASC LIMIT ?)",
        )
        .bind(count as i64)
        .execute(&self.db)
        .await?;

        let evicted = result.rows_affected() as usize;
        if evicted > 0 {
            info!("Evicted {} LRU detection crops", evicted);
        }
        Ok(evicted)
    }

    async fn evict_if_needed(&self, max_entries: usize) -> Result<()> {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM detection_crops")
            .fetch_one(&self.db)
            .await?;

        if (count.0 as usize) > max_entries {
            let excess = (count.0 as usize) - max_entries;
            let evict_count = excess + (max_entries / 10);
            self.evict_lru(evict_count).await?;
        }

        Ok(())
    }
}
