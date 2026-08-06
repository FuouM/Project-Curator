use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::path::Path;
use std::sync::Arc;
use tracing::info;

use crate::image_decode::decode_rgb;

const WEBP_QUALITY: f32 = 75.0;
const WEBP_METHOD: i32 = 2;
const DEFAULT_MAX_ENTRIES: usize = 200_000;
const EVICTION_CHECK_INTERVAL: u64 = 1000;

/// Cache variant key: static single-frame thumbnail.
pub const THUMB_KIND_STATIC: u8 = 0;
/// Cache variant key: animated WebP preview clip (videos only).
pub const THUMB_KIND_ANIMATED: u8 = 1;

pub struct ThumbnailCache {
    db: SqlitePool,
    op_count: std::sync::atomic::AtomicU64,
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
                image_id   INTEGER NOT NULL,
                width      INTEGER NOT NULL,
                mtime      INTEGER NOT NULL DEFAULT 0,
                kind       INTEGER NOT NULL DEFAULT 0,
                data       BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (image_id, width, kind)
            )",
        )
        .execute(&db)
        .await?;

        // Backward-compatible cache schema migration: cache DB is rebuildable,
        // so a missing mtime column just means all cached entries are stale.
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('thumbnails')")
            .fetch_all(&db)
            .await?;
        if !cols.iter().any(|name| name == "mtime") {
            sqlx::query("ALTER TABLE thumbnails ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0")
                .execute(&db)
                .await?;
        }
        if !cols.iter().any(|name| name == "kind") {
            sqlx::query("ALTER TABLE thumbnails ADD COLUMN kind INTEGER NOT NULL DEFAULT 0")
                .execute(&db)
                .await?;
        }

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_thumbnails_created_at ON thumbnails(created_at)",
        )
        .execute(&db)
        .await?;

        info!("Thumbnail cache opened at {:?}", path);
        Ok(Arc::new(Self {
            db,
            op_count: std::sync::atomic::AtomicU64::new(0),
        }))
    }

    pub async fn get(&self, image_id: i64, width: u32, mtime: i64, kind: u8) -> Option<Vec<u8>> {
        let row: Option<(Vec<u8>,)> = sqlx::query_as(
            "SELECT data FROM thumbnails WHERE image_id = ? AND width = ? AND mtime = ? AND kind = ?",
        )
        .bind(image_id)
        .bind(width)
        .bind(mtime)
        .bind(kind)
        .fetch_optional(&self.db)
        .await
        .ok()?;

        row.map(|(data,)| data)
    }

    pub async fn put(
        &self,
        image_id: i64,
        width: u32,
        mtime: i64,
        kind: u8,
        data: &[u8],
    ) -> Result<()> {
        let now = crate::util::now_secs() as i64;

        sqlx::query(
            "INSERT OR REPLACE INTO thumbnails (image_id, width, mtime, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(image_id)
        .bind(width)
        .bind(mtime)
        .bind(kind)
        .bind(data)
        .bind(now)
        .execute(&self.db)
        .await?;

        let cnt = self.op_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if cnt % EVICTION_CHECK_INTERVAL == 0 {
            self.evict_if_needed(DEFAULT_MAX_ENTRIES).await?;
        }
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

    /// Delete every cached thumbnail row, returning the number of rows removed.
    pub async fn clear(&self) -> Result<usize> {
        let result = sqlx::query("DELETE FROM thumbnails").execute(&self.db).await?;
        let deleted = result.rows_affected() as usize;
        info!("Cleared all {} cached thumbnails", deleted);
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

    let mut rgb_buf = rgb_buf;
    let mut width = width;
    let mut height = height;

    // Downscale is dominated by reading O(source) pixels (the default
    // Convolution/Bilinear pass); for very large sources that dwarfs everything
    // else. Cheaply pre-reduce with a Nearest subsample to <= 2x the target
    // (O(2x target) pixels), then finish with a Bilinear pass (O(intermediate)).
    // For small sources the intermediate degenerates to the source and this is a
    // single Bilinear resize.
    let inter_w = width.min(target_width * 2).max(1);
    let inter_h = height.min(target_height * 2).max(1);

    let mut resizer = fast_image_resize::Resizer::new();
    let bilinear = fast_image_resize::ResizeOptions::new().resize_alg(
        fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
    );

    if inter_w != width || inter_h != height {
        let src_image = fast_image_resize::images::ImageRef::new(
            width,
            height,
            &rgb_buf,
            fast_image_resize::PixelType::U8x3,
        )
        .context("Failed to create source image ref for thumbnail pre-resize")?;

        let mut mid_image = fast_image_resize::images::Image::from_vec_u8(
            inter_w,
            inter_h,
            vec![0u8; (inter_w * inter_h * 3) as usize],
            fast_image_resize::PixelType::U8x3,
        )
        .context("Failed to create intermediate image for thumbnail render")?;

        resizer
            .resize(
                &src_image,
                &mut mid_image,
                Some(
                    &fast_image_resize::ResizeOptions::new()
                        .resize_alg(fast_image_resize::ResizeAlg::Nearest),
                ),
            )
            .context("Failed to pre-resize image for thumbnail")?;

        rgb_buf = mid_image.into_vec();
        width = inter_w;
        height = inter_h;
    }

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

    resizer
        .resize(&src_image, &mut dst_image, Some(&bilinear))
        .context("Failed to resize image for thumbnail")?;

    let encoder = webp::Encoder::from_rgb(dst_image.buffer(), target_width, target_height);
    let mut webp_config =
        webp::WebPConfig::new().map_err(|_| anyhow::anyhow!("Failed to init WebP config"))?;
    webp_config.quality = WEBP_QUALITY;
    webp_config.method = WEBP_METHOD;
    let webp_memory = encoder
        .encode_advanced(&webp_config)
        .map_err(|e| anyhow::anyhow!("Failed to encode WebP thumbnail: {e:?}"))?;

    Ok(webp_memory.to_vec())
}

/// Generate an animated WebP preview clip for a video via FFmpeg (grid
/// thumbnail). `width` is the target width; `fps` and `quality` control the
/// clip density and compression. Delegates to `crate::video`.
pub fn generate_video_preview(
    source_path: &Path,
    ffmpeg_path: &Path,
    width: u32,
    fps: u8,
    quality: u8,
) -> Result<Vec<u8>> {
    crate::video::extract_video_preview(source_path, ffmpeg_path, width, fps, quality)
}
