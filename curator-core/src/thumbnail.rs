use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::path::Path;
use std::sync::Arc;
use tracing::info;

use crate::image_decode::decode_rgb;

const THUMBNAIL_WIDTH: u32 = 200;
const WEBP_QUALITY: f32 = 80.0;
const DEFAULT_MAX_ENTRIES: usize = 200_000;

pub struct ThumbnailCache {
    db: SqlitePool,
}

impl ThumbnailCache {
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
            "CREATE TABLE IF NOT EXISTS thumbnails (
                image_id   INTEGER PRIMARY KEY,
                width      INTEGER NOT NULL,
                data       BLOB NOT NULL,
                created_at INTEGER NOT NULL
            )",
        )
        .execute(&db)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_thumbnails_created_at ON thumbnails(created_at)",
        )
        .execute(&db)
        .await?;

        info!("Thumbnail cache opened at {:?}", path);
        Ok(Arc::new(Self { db }))
    }

    pub async fn get(&self, image_id: i64) -> Option<Vec<u8>> {
        let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT data FROM thumbnails WHERE image_id = ?")
            .bind(image_id)
            .fetch_optional(&self.db)
            .await
            .ok()?;

        row.map(|(data,)| data)
    }

    pub async fn put(&self, image_id: i64, width: u32, data: &[u8]) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        sqlx::query(
            "INSERT OR REPLACE INTO thumbnails (image_id, width, data, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(image_id)
        .bind(width)
        .bind(data)
        .bind(now)
        .execute(&self.db)
        .await?;

        self.evict_if_needed(DEFAULT_MAX_ENTRIES).await?;
        Ok(())
    }

    pub async fn purge_missing(&self, missing_ids: &[i64]) -> Result<usize> {
        if missing_ids.is_empty() {
            return Ok(0);
        }

        let mut deleted = 0usize;
        for chunk in missing_ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM thumbnails WHERE image_id IN ({})", placeholders);
            let mut q = sqlx::query(&sql);
            for id in chunk {
                q = q.bind(id);
            }
            let result = q.execute(&self.db).await?;
            deleted += result.rows_affected() as usize;
        }

        info!("Purged {} missing image thumbnails", deleted);
        Ok(deleted)
    }

    pub async fn evict_lru(&self, count: usize) -> Result<usize> {
        let result = sqlx::query(
            "DELETE FROM thumbnails WHERE image_id IN (SELECT image_id FROM thumbnails ORDER BY created_at ASC LIMIT ?)",
        )
        .bind(count as i64)
        .execute(&self.db)
        .await?;

        let evicted = result.rows_affected() as usize;
        if evicted > 0 {
            info!("Evicted {} LRU thumbnails", evicted);
        }
        Ok(evicted)
    }

    async fn evict_if_needed(&self, max_entries: usize) -> Result<()> {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM thumbnails")
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

pub fn generate_thumbnail(source_path: &Path, target_width: u32) -> Result<Vec<u8>> {
    let (rgb_buf, width, height) = decode_rgb(source_path)
        .with_context(|| format!("Failed to decode image for thumbnail: {:?}", source_path))?;

    let aspect = height as f64 / width as f64;
    let target_height = (target_width as f64 * aspect).round() as u32;
    let target_height = target_height.max(1);

    let src_image = fast_image_resize::images::ImageRef::new(
        width,
        height,
        &rgb_buf,
        fast_image_resize::PixelType::U8x3,
    )
    .context("Failed to create source image ref for thumbnail resize")?;

    let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
        target_width,
        target_height,
        vec![0u8; (target_width * target_height * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )
    .context("Failed to create destination image for thumbnail resize")?;

    let mut resizer = fast_image_resize::Resizer::new();

    resizer
        .resize(&src_image, &mut dst_image, None)
        .context("Failed to resize image for thumbnail")?;

    let encoder = webp::Encoder::from_rgb(dst_image.buffer(), target_width, target_height);
    let webp_memory = encoder.encode(WEBP_QUALITY);

    Ok(webp_memory.to_vec())
}
