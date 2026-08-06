use anyhow::Result;
use curator_core::ipc::EmbeddingModel;
use curator_core::video::{self, VideoInfo};
use sha2::Digest;
use sqlx::SqlitePool;
use std::fs;
use std::path::Path;
use tracing::{info, warn};

use super::common::resolve_source_id;

/// Best-effort media metadata extracted from a file header.
/// Extraction failures are logged and stored as `None`, matching the phash
/// convention: a corrupt file must never block library import. Missing FFmpeg
/// for a video, however, is an environmental failure and fails fast.
struct MediaExtract {
    width: Option<i64>,
    height: Option<i64>,
    animation: Option<curator_core::media::AnimationInfo>,
    video: Option<VideoInfo>,
    video_frame_path: Option<String>,
}

/// SHA-256 of the file's first 64 KiB (streamed, constant memory). Used as a
/// best-effort identity fallback when the whole file cannot be read.
fn header_sha256(path: &Path) -> String {
    use std::io::Read;
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let mut buf = vec![0u8; 65536];
    let mut total = 0usize;
    let mut hasher = sha2::Sha256::new();
    while let Ok(n) = file.read(&mut buf) {
        if n == 0 {
            break;
        }
        total += n;
        hasher.update(&buf[..n]);
        if total >= 65536 {
            break;
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Extract the first frame (0.0s) of a video to the derived frame cache and
/// return `(cache_path, sha256_of_frame)`.
fn extract_frame_to_cache(path: &Path, ffmpeg: &Path, data_dir: &Path) -> Result<(String, String)> {
    let frame_dir = data_dir.join("video_frames");
    fs::create_dir_all(&frame_dir)?;
    let frame = video::extract_video_frame(path, 0, ffmpeg)?;
    let png = video::frame_to_png_bytes(&frame)?;
    let sha = format!("{:x}", sha2::Sha256::digest(&png));
    let target = frame_dir.join(format!("{}.png", &sha[..32]));
    if !target.exists() {
        fs::write(&target, &png)?;
    }
    Ok((target.to_string_lossy().into_owned(), sha))
}

fn extract_media_info(path: &Path, ffmpeg: Option<&Path>, data_dir: &Path) -> Result<MediaExtract> {
    if curator_core::video::is_video(path) {
        let ffmpeg = match ffmpeg {
            Some(p) => p,
            None => anyhow::bail!(
                "Video file {:?} detected but FFmpeg is not configured. Open Settings → FFmpeg to resolve it.",
                path
            ),
        };
        let video = match video::read_video_metadata(path, ffmpeg) {
            Ok(v) => Some(v),
            Err(e) => {
                warn!("Failed to probe video {:?}: {:?}", path, e);
                None
            }
        };
        let frame_path = match extract_frame_to_cache(path, ffmpeg, data_dir) {
            Ok((p, _)) => Some(p),
            Err(e) => {
                warn!("Failed to extract first frame for {:?}: {:?}", path, e);
                None
            }
        };
        return Ok(MediaExtract {
            width: video.as_ref().map(|v| v.width as i64),
            height: video.as_ref().map(|v| v.height as i64),
            animation: None,
            video,
            video_frame_path: frame_path,
        });
    }

    let (width, height) = match curator_core::media::read_dimensions(path) {
        Ok((w, h)) => (Some(w as i64), Some(h as i64)),
        Err(e) => {
            warn!("Failed to read dimensions for {:?}: {:?}", path, e);
            (None, None)
        }
    };

    let animation = if curator_core::media::is_gif(path) {
        match curator_core::media::read_gif_animation(path) {
            Ok(info) => Some(info),
            Err(e) => {
                warn!("Failed to read GIF animation metadata for {:?}: {:?}", path, e);
                None
            }
        }
    } else {
        None
    };

    Ok(MediaExtract {
        width,
        height,
        animation,
        video: None,
        video_frame_path: None,
    })
}

/// Content identity hash. Videos and images both hash the entire file
/// (streamed, constant memory) so a duplicate is detected regardless of its
/// container or codec. Corrupt/unreadable files fall back to the header hash.
fn compute_content_sha(path: &Path, media: &MediaExtract) -> String {
    if let Ok(sha) = curator_core::media::sha256_file(path) {
        return sha;
    }
    if media.video.is_some() {
        return header_sha256(path);
    }
    match fs::read(path) {
        Ok(data) => format!("{:x}", sha2::Sha256::digest(&data)),
        Err(_) => header_sha256(path),
    }
}

/// Upsert animated media metadata for an image (no-op for static images).
async fn upsert_animation_metadata(
    exec: &mut sqlx::SqliteConnection,
    image_id: i64,
    media: &MediaExtract,
) -> Result<()> {
    if let Some(anim) = &media.animation {
        sqlx::query(
            "INSERT INTO image_animation_metadata (image_id, format, frame_count, duration_ms, loop_count, is_animated)
             VALUES (?, 'gif', ?, ?, ?, 1)
             ON CONFLICT(image_id) DO UPDATE SET
               format = excluded.format,
               frame_count = excluded.frame_count,
               duration_ms = excluded.duration_ms,
               loop_count = excluded.loop_count,
               is_animated = excluded.is_animated,
               updated_at = CURRENT_TIMESTAMP",
        )
        .bind(image_id)
        .bind(anim.frame_count as i64)
        .bind(anim.duration_ms)
        .bind(anim.loop_count.map(|c| c as i64))
        .execute(&mut *exec)
        .await?;
    }
    Ok(())
}

/// Upsert video stream/container metadata for an image (no-op for images).
async fn upsert_video_metadata(
    exec: &mut sqlx::SqliteConnection,
    image_id: i64,
    media: &MediaExtract,
) -> Result<()> {
    if let Some(v) = &media.video {
        sqlx::query(
            "INSERT INTO video_media_metadata (image_id, format, duration_ms, fps, video_codec, audio_codec, bitrate)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(image_id) DO UPDATE SET
               format = excluded.format,
               duration_ms = excluded.duration_ms,
               fps = excluded.fps,
               video_codec = excluded.video_codec,
               audio_codec = excluded.audio_codec,
               bitrate = excluded.bitrate,
               updated_at = CURRENT_TIMESTAMP",
        )
        .bind(image_id)
        .bind(&v.format)
        .bind(v.duration_ms)
        .bind(v.fps)
        .bind(&v.video_codec)
        .bind(&v.audio_codec)
        .bind(v.bitrate)
        .execute(&mut *exec)
        .await?;
    }
    Ok(())
}

/// Resolve the perceptual hash source path for an image (videos use their
/// extracted first frame so the hash is computed on decodable pixels).
fn phash_source_path(media: &MediaExtract, path: &Path) -> std::path::PathBuf {
    if media.video.is_some() {
        if let Some(fp) = &media.video_frame_path {
            return Path::new(fp).to_path_buf();
        }
    }
    path.to_path_buf()
}

pub async fn get_or_create_folder(folder_path: &str, db: &SqlitePool) -> Result<i64> {
    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE path = ? LIMIT 1")
        .bind(folder_path)
        .fetch_optional(db)
        .await?;

    if let Some((id,)) = existing {
        return Ok(id);
    }

    let folder_name = Path::new(folder_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(folder_path)
        .to_string();

    let id = sqlx::query("INSERT INTO folders (path, name) VALUES (?, ?)")
        .bind(folder_path)
        .bind(&folder_name)
        .execute(db)
        .await?
        .last_insert_rowid();

    info!("Created folder record: {} (id={})", folder_name, id);
    Ok(id)
}

pub async fn import_single_image(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
    folder_id: Option<i64>,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
) -> Result<(i64, String)> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("File does not exist: {}", path_str));
    }

    let media = extract_media_info(path, ffmpeg, data_dir)?;
    let sha256 = compute_content_sha(path, &media);

    let metadata = fs::metadata(path)?;
    let mtime = metadata
        .modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?
        .as_secs() as i64;

    let source_name = match active {
        EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let clip_source_id = resolve_source_id(db, source_name).await?;

    let phash = match curator_core::vector::compute_ahash(phash_source_path(&media, path)) {
        Ok(h) => Some(h),
        Err(e) => {
            warn!("Failed to compute aHash for {:?}: {:?}", path, e);
            None
        }
    };

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
            .bind(&sha256)
            .fetch_optional(db)
            .await?;

    // Reconciliation: old rows (e.g. videos hashed by first frame before the
    // whole-file sha change) are found by path and re-hashed in place so a
    // rescan upgrades their identity instead of inserting a duplicate.
    let existing = match existing {
        Some(row) => Some(row),
        None => sqlx::query_as(
            "SELECT id, current_filepath FROM images WHERE current_filepath = ? AND deleted_at IS NULL",
        )
        .bind(path_str)
        .fetch_optional(db)
        .await?,
    };

    let mut tx = db.begin().await?;
    let id = if let Some((id, _old_path)) = existing {
        sqlx::query(
            "UPDATE images SET sha256 = ?, current_filepath = ?, mtime = ?, phash = ?, width = COALESCE(?, width), height = COALESCE(?, height), folder_id = COALESCE(folder_id, ?), video_frame_path = COALESCE(?, video_frame_path), deleted_at = NULL WHERE id = ?",
        )
        .bind(&sha256)
        .bind(path_str)
        .bind(mtime)
        .bind(&phash)
        .bind(media.width)
        .bind(media.height)
        .bind(folder_id)
        .bind(&media.video_frame_path)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        let vec_exists: Option<(String,)> = sqlx::query_as(
            "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
        )
        .bind(id)
        .bind(clip_source_id)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);

        if vec_exists.is_none() {
            let _ = sqlx::query(
                "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
            )
            .bind(id)
            .bind(clip_source_id)
            .execute(&mut *tx)
            .await?;
        }
        id
    } else {
        let id = sqlx::query(
            "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id, width, height, video_frame_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&sha256)
        .bind(&phash)
        .bind(path_str)
        .bind(mtime)
        .bind(folder_id)
        .bind(media.width)
        .bind(media.height)
        .bind(&media.video_frame_path)
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();

        sqlx::query(
            "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
        )
        .bind(id)
        .bind(clip_source_id)
        .execute(&mut *tx)
        .await?;
        id
    };

    upsert_animation_metadata(&mut tx, id, &media).await?;
    upsert_video_metadata(&mut tx, id, &media).await?;
    tx.commit().await?;

    Ok((id, sha256))
}

pub async fn import_image_logic(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
) -> Result<(i64, String, usize, Option<i64>)> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!(
            "File or directory does not exist: {}",
            path_str
        ));
    }

    if path.is_dir() {
        let folder_id = get_or_create_folder(path_str, db).await?;

        let mut paths_to_process = vec![path.to_path_buf()];
        let mut image_paths = Vec::new();

        while let Some(current_path) = paths_to_process.pop() {
            if current_path.is_dir() {
                if let Ok(entries) = fs::read_dir(&current_path) {
                    for entry in entries.flatten() {
                        paths_to_process.push(entry.path());
                    }
                }
            } else if current_path.is_file() {
                if let Some(ext) = current_path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if matches!(
                        ext_lower.as_str(),
                        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff" | "mp4" | "webm"
                    ) {
                        image_paths.push(current_path);
                    }
                }
            }
        }

        if image_paths.is_empty() {
            return Err(anyhow::anyhow!(
                "No supported image files found in directory: {}",
                path_str
            ));
        }

        let total_count = image_paths.len();
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(image_paths.len());

        let chunk_size = (image_paths.len() + num_threads - 1) / num_threads;
        let paths_vec: Vec<String> = image_paths
            .iter()
            .filter_map(|p| p.to_str().map(|s| s.to_string()))
            .collect();

        struct PreppedImage {
            path_str: String,
            sha256: String,
            mtime: i64,
            phash: Option<String>,
            media: MediaExtract,
        }

        let mut prepped_images = Vec::with_capacity(paths_vec.len());

        // ffmpeg/data_dir are borrowed read-only inside the scoped threads.
        let ffmpeg_owned = ffmpeg.map(|p| p.to_path_buf());

        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(num_threads);

            for chunk in paths_vec.chunks(chunk_size) {
                let chunk_paths = chunk.to_vec();
                let ffmpeg_ref = ffmpeg_owned.clone();
                let data_dir_owned = data_dir.to_path_buf();
                let handle = s.spawn(move || {
                    let mut items = Vec::with_capacity(chunk_paths.len());
                    for p_str in chunk_paths {
                        let p = Path::new(&p_str);
                        if let Ok(metadata) = fs::metadata(p) {
                            let mtime = metadata
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0);
                            let media = match extract_media_info(
                                p,
                                ffmpeg_ref.as_deref(),
                                &data_dir_owned,
                            ) {
                                Ok(m) => m,
                                Err(e) => {
                                    warn!(
                                        "Failed to extract media info for {:?}: {:?}",
                                        p, e
                                    );
                                    continue;
                                }
                            };
                            let sha256 = compute_content_sha(p, &media);
                            items.push(PreppedImage {
                                path_str: p_str,
                                sha256,
                                mtime,
                                phash: None,
                                media,
                            });
                        }
                    }
                    items
                });
                handles.push(handle);
            }

            for handle in handles {
                if let Ok(items) = handle.join() {
                    prepped_images.extend(items);
                }
            }
        });

        let clip_source_id = resolve_source_id(db, match active {
            EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
            EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
        }).await?;

        let mut first_id = 0;
        let mut first_sha = String::new();
        let mut imported_any = false;

        // Batch all per-image statements in a single transaction.
        let mut tx = db.begin().await?;
        for item in prepped_images {
            let existing: Option<(i64, String)> =
                sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
                    .bind(&item.sha256)
                    .fetch_optional(&mut *tx)
                    .await?;

            // Reconciliation: old rows (e.g. videos hashed by first frame before
            // the whole-file sha change) are found by path and re-hashed in place
            // so a rescan upgrades their identity instead of inserting a duplicate.
            let existing = match existing {
                Some(row) => Some(row),
                None => sqlx::query_as(
                    "SELECT id, current_filepath FROM images WHERE current_filepath = ? AND deleted_at IS NULL",
                )
                .bind(&item.path_str)
                .fetch_optional(&mut *tx)
                .await?,
            };

            let img_id = if let Some((id, _old_path)) = existing {
                let _ = sqlx::query(
                    "UPDATE images SET sha256 = ?, current_filepath = ?, mtime = ?, phash = ?, width = COALESCE(?, width), height = COALESCE(?, height), folder_id = COALESCE(folder_id, ?), video_frame_path = COALESCE(?, video_frame_path), deleted_at = NULL WHERE id = ?",
                )
                .bind(&item.sha256)
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(&item.phash)
                .bind(item.media.width)
                .bind(item.media.height)
                .bind(folder_id)
                .bind(&item.media.video_frame_path)
                .bind(id)
                .execute(&mut *tx)
                .await;

                let vec_exists: Option<(String,)> = sqlx::query_as(
                    "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
                )
                .bind(id)
                .bind(clip_source_id)
                .fetch_optional(&mut *tx)
                .await
                .unwrap_or(None);

                if vec_exists.is_none() {
                    let _ = sqlx::query(
                        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                    )
                    .bind(id)
                    .bind(clip_source_id)
                    .execute(&mut *tx)
                    .await;
                }
                id
            } else {
                let id = sqlx::query(
                    "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id, width, height, video_frame_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&item.sha256)
                .bind(&item.phash)
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(Some(folder_id))
                .bind(item.media.width)
                .bind(item.media.height)
                .bind(&item.media.video_frame_path)
                .execute(&mut *tx)
                .await?
                .last_insert_rowid();

                let _ = sqlx::query(
                    "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                )
                .bind(id)
                .bind(clip_source_id)
                .execute(&mut *tx)
                .await;

                id
            };

            upsert_animation_metadata(&mut tx, img_id, &item.media).await?;
            upsert_video_metadata(&mut tx, img_id, &item.media).await?;

            if !imported_any {
                first_id = img_id;
                first_sha = item.sha256;
                imported_any = true;
            }
        }
        tx.commit().await?;

        if imported_any {
            Ok((first_id, first_sha, total_count, Some(folder_id)))
        } else {
            Err(anyhow::anyhow!(
                "Failed to import any images from directory: {}",
                path_str
            ))
        }
    } else {
        let parent_dir = path
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or(path_str);
        let folder_id = get_or_create_folder(parent_dir, db).await?;
        let (id, sha) =
            import_single_image(path_str, db, active, Some(folder_id), ffmpeg, data_dir).await?;
        Ok((id, sha, 1, Some(folder_id)))
    }
}

pub async fn backfill_image_folders(db: &SqlitePool) -> Result<i64> {
    #[derive(Debug, sqlx::FromRow)]
    struct ImageRow {
        id: i64,
        current_filepath: String,
    }

    let images: Vec<ImageRow> = sqlx::query_as(
        "SELECT id, current_filepath FROM images WHERE folder_id IS NULL AND deleted_at IS NULL",
    )
    .fetch_all(db)
    .await?;

    let mut backfilled: i64 = 0;
    // Memoize folder lookups so each unique directory is resolved once.
    let mut folder_cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

    let mut tx = db.begin().await?;
    for img in images {
        let path = Path::new(&img.current_filepath);
        let parent_dir = match path.parent() {
            Some(p) => p.to_str().unwrap_or(""),
            None => continue,
        };

        if parent_dir.is_empty() {
            continue;
        }

        let folder_id = match folder_cache.get(parent_dir) {
            Some(id) => *id,
            None => {
                let id = get_or_create_folder(parent_dir, db).await?;
                folder_cache.insert(parent_dir.to_string(), id);
                id
            }
        };

        sqlx::query("UPDATE images SET folder_id = ? WHERE id = ?")
            .bind(folder_id)
            .bind(img.id)
            .execute(&mut *tx)
            .await?;

        backfilled += 1;
    }
    tx.commit().await?;

    info!("Backfilled {} images with folder assignments", backfilled);
    Ok(backfilled)
}

/// Populate media metadata (dimensions, GIF animation details, video probe
/// details) for images that are missing it. Returns `(processed, updated)`.
pub async fn backfill_media_metadata(
    db: &SqlitePool,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
) -> Result<(i64, i64)> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT i.id, i.current_filepath
         FROM images i
         LEFT JOIN image_animation_metadata am ON am.image_id = i.id
         LEFT JOIN video_media_metadata vm ON vm.image_id = i.id
         WHERE i.deleted_at IS NULL
           AND (i.width IS NULL OR i.height IS NULL
                OR (am.image_id IS NULL AND LOWER(i.current_filepath) LIKE '%.gif')
                OR (vm.image_id IS NULL AND (LOWER(i.current_filepath) LIKE '%.mp4' OR LOWER(i.current_filepath) LIKE '%.webm')))",
    )
    .fetch_all(db)
    .await?;

    let mut processed: i64 = 0;
    let mut updated: i64 = 0;
    let mut tx = db.begin().await?;
    for (id, filepath) in rows {
        let path = Path::new(&filepath);
        if !path.exists() {
            continue;
        }
        let media = extract_media_info(path, ffmpeg, data_dir)?;
        processed += 1;
        let mut changed = false;
        if media.width.is_some() || media.height.is_some() {
            sqlx::query(
                "UPDATE images SET width = COALESCE(?, width), height = COALESCE(?, height), video_frame_path = COALESCE(?, video_frame_path) WHERE id = ?",
            )
            .bind(media.width)
            .bind(media.height)
            .bind(&media.video_frame_path)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            changed = true;
        }
        if media.animation.is_some() {
            upsert_animation_metadata(&mut tx, id, &media).await?;
            changed = true;
        }
        if media.video.is_some() {
            upsert_video_metadata(&mut tx, id, &media).await?;
            changed = true;
        }
        if changed {
            updated += 1;
        }
    }
    tx.commit().await?;

    info!("Backfilled media metadata: {} processed, {} updated", processed, updated);
    Ok((processed, updated))
}

pub async fn get_imported_folders_logic(
    db: &SqlitePool,
) -> Result<Vec<curator_core::ipc::FolderDetails>> {
    #[derive(Debug, sqlx::FromRow)]
    struct FolderRow {
        id: i64,
        path: String,
        name: String,
        imported_at: String,
        image_count: i64,
        video_count: i64,
        vector_ready: i64,
        vector_pending: i64,
    }

    let rows: Vec<FolderRow> = sqlx::query_as(
        r#"
        SELECT
            f.id,
            f.path,
            f.name,
            f.imported_at,
            COUNT(CASE WHEN LOWER(i.current_filepath) NOT LIKE '%.mp4' AND LOWER(i.current_filepath) NOT LIKE '%.webm' THEN 1 END) as image_count,
            COALESCE(SUM(CASE WHEN LOWER(i.current_filepath) LIKE '%.mp4' OR LOWER(i.current_filepath) LIKE '%.webm' THEN 1 ELSE 0 END), 0) as video_count,
            COALESCE(SUM(CASE WHEN iv.vector_state = 'ready' THEN 1 ELSE 0 END), 0) as vector_ready,
            COALESCE(SUM(CASE WHEN iv.vector_state IN ('pending', 'preprocessing') THEN 1 ELSE 0 END), 0) as vector_pending
        FROM folders f
        LEFT JOIN images i ON i.folder_id = f.id AND i.deleted_at IS NULL
        LEFT JOIN image_vectors iv ON iv.image_id = i.id
        GROUP BY f.id
        ORDER BY f.imported_at DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    // Batch-check file existence for all images to count missing per folder
    #[derive(Debug, sqlx::FromRow)]
    struct FolderImage {
        folder_id: i64,
        current_filepath: String,
    }

    let folder_images: Vec<FolderImage> = sqlx::query_as(
        "SELECT folder_id, current_filepath FROM images WHERE folder_id IS NOT NULL AND deleted_at IS NULL",
    )
    .fetch_all(db)
    .await?;

    let mut missing_per_folder: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    for fi in &folder_images {
        if !Path::new(&fi.current_filepath).exists() {
            let is_video = fi.current_filepath.to_lowercase().ends_with(".mp4")
                || fi.current_filepath.to_lowercase().ends_with(".webm");
            let entry = missing_per_folder.entry(fi.folder_id).or_insert((0, 0));
            if is_video {
                entry.1 += 1;
            } else {
                entry.0 += 1;
            }
        }
    }

    Ok(rows
        .into_iter()
        .map(|r| {
            let is_missing = !Path::new(&r.path).exists();
            let (missing_image_count, missing_video_count) =
                missing_per_folder.get(&r.id).copied().unwrap_or((0, 0));
            curator_core::ipc::FolderDetails {
                id: r.id,
                path: r.path,
                name: r.name,
                imported_at: r.imported_at,
                image_count: r.image_count,
                video_count: r.video_count,
                vector_ready: r.vector_ready,
                vector_pending: r.vector_pending,
                missing_image_count,
                missing_video_count,
                is_missing,
            }
        })
        .collect())
}

pub async fn update_folder_path_logic(
    id: i64,
    new_path: &str,
    db: &SqlitePool,
) -> Result<bool> {
    let new_path_obj = Path::new(new_path);
    if !new_path_obj.exists() {
        return Err(anyhow::anyhow!(
            "New folder path does not exist: {}",
            new_path
        ));
    }

    let new_name = new_path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(new_path)
        .to_string();

    let affected = sqlx::query("UPDATE folders SET path = ?, name = ? WHERE id = ?")
        .bind(new_path)
        .bind(&new_name)
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();

    if affected > 0 {
        info!("Updated folder {} path to {}", id, new_path);
        Ok(true)
    } else {
        Err(anyhow::anyhow!("Folder not found: id={}", id))
    }
}

pub async fn delete_folder_logic(id: i64, db: &SqlitePool) -> Result<bool> {
    let affected = sqlx::query("DELETE FROM folders WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();

    if affected > 0 {
        info!("Deleted folder record id={}", id);
        Ok(true)
    } else {
        Err(anyhow::anyhow!("Folder not found: id={}", id))
    }
}

/// Re-scan an imported folder for media files that are not yet in the library
/// (notably videos that were ignored before video support). Reuses the normal
/// import pipeline, which deduplicates by content hash, so already-known files
/// are updated in place rather than re-inserted. Returns `(newly_imported,
/// total_supported_found)`.
pub async fn rescan_folder_logic(
    folder_id: i64,
    db: &SqlitePool,
    active: EmbeddingModel,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
) -> Result<(i64, i64)> {
    let folder_path: Option<String> =
        sqlx::query_scalar("SELECT path FROM folders WHERE id = ?")
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    let path = match folder_path {
        Some(p) => p,
        None => anyhow::bail!("Folder not found: id={}", folder_id),
    };

    if !Path::new(&path).exists() {
        return Err(anyhow::anyhow!(
            "Folder path no longer exists on disk: {}",
            path
        ));
    }

    let before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM images WHERE folder_id = ? AND deleted_at IS NULL",
    )
    .bind(folder_id)
    .fetch_one(db)
    .await?;

    let (_id, _sha, found, _folder_id) =
        import_image_logic(&path, db, active, ffmpeg, data_dir).await?;

    let after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM images WHERE folder_id = ? AND deleted_at IS NULL",
    )
    .bind(folder_id)
    .fetch_one(db)
    .await?;

    let imported = (after - before).max(0);
    let found_i64 = found as i64;
    info!(
        "Rescanned folder {} ({:?}): {} new media, {} total supported found",
        folder_id, path, imported, found_i64
    );
    Ok((imported, found_i64))
}

/// Queue vector indexing for media in an imported folder that does not yet have
/// a `ready` vector for the active embedding model. Rows that are already
/// `pending`/`preprocessing`/`ready` are left untouched, so this is safe to run
/// repeatedly. Returns the number of media files newly queued.
pub async fn index_folder_logic(
    folder_id: i64,
    db: &SqlitePool,
    active: EmbeddingModel,
) -> Result<i64> {
    let folder_exists: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM folders WHERE id = ?")
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    if folder_exists.is_none() {
        anyhow::bail!("Folder not found: id={}", folder_id);
    }

    let source_name = match active {
        EmbeddingModel::ClipVitB32 => "ai:clip-vit-b-32",
        EmbeddingModel::MobileClipS2 => "ai:mobileclip-s2",
    };
    let source_id = resolve_source_id(db, source_name).await?;

    let result = sqlx::query(
        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state, vector_checksum)
         SELECT i.id, ?, '', 'pending', NULL
         FROM images i
         WHERE i.folder_id = ? AND i.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM image_vectors iv
             WHERE iv.image_id = i.id AND iv.source_id = ?
               AND iv.vector_state IN ('ready', 'pending', 'preprocessing')
           )",
    )
    .bind(source_id)
    .bind(folder_id)
    .bind(source_id)
    .execute(db)
    .await?;

    let queued = result.rows_affected() as i64;
    info!(
        "Queued {} media file(s) for indexing in folder {}",
        queued, folder_id
    );
    Ok(queued)
}

pub async fn detect_duplicate_folders_logic(
    db: &SqlitePool,
) -> Result<Vec<curator_core::ipc::DuplicateFolderGroup>> {
    // Get all folders with their image counts
    #[derive(Debug, sqlx::FromRow)]
    struct FolderInfo {
        id: i64,
        path: String,
        name: String,
        image_count: i64,
    }

    let folders: Vec<FolderInfo> = sqlx::query_as(
        r#"
        SELECT f.id, f.path, f.name,
               COUNT(i.id) as image_count
        FROM folders f
        LEFT JOIN images i ON i.folder_id = f.id AND i.deleted_at IS NULL
        GROUP BY f.id
        HAVING image_count > 0
        ORDER BY image_count DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    if folders.len() < 2 {
        return Ok(Vec::new());
    }

    // For each folder, get the set of image SHA-256 hashes
    #[derive(Debug, sqlx::FromRow)]
    struct FolderSha256 {
        folder_id: i64,
        sha256: String,
    }

    let all_sha: Vec<FolderSha256> = sqlx::query_as(
        r#"
        SELECT folder_id, sha256
        FROM images
        WHERE deleted_at IS NULL AND folder_id IS NOT NULL
        "#,
    )
    .fetch_all(db)
    .await?;

    // Build map: sha256 -> set of folder_ids
    let mut sha_to_folders: std::collections::HashMap<String, std::collections::HashSet<i64>> =
        std::collections::HashMap::new();
    for item in all_sha {
        sha_to_folders
            .entry(item.sha256)
            .or_default()
            .insert(item.folder_id);
    }

    // Build map: folder_id -> folder info
    let folder_map: std::collections::HashMap<i64, &FolderInfo> =
        folders.iter().map(|f| (f.id, f)).collect();

    // Count overlaps between folder pairs
    let mut overlap_counts: std::collections::HashMap<(i64, i64), i64> =
        std::collections::HashMap::new();

    for folder_set in sha_to_folders.values() {
        if folder_set.len() < 2 {
            continue;
        }
        // For each pair in this set, increment overlap
        let folder_ids: Vec<i64> = folder_set.iter().copied().collect();
        for i in 0..folder_ids.len() {
            for j in (i + 1)..folder_ids.len() {
                let key = if folder_ids[i] < folder_ids[j] {
                    (folder_ids[i], folder_ids[j])
                } else {
                    (folder_ids[j], folder_ids[i])
                };
                *overlap_counts.entry(key).or_insert(0) += 1;
            }
        }
    }

    // Build groups using union-find: merge folders that share images
    let mut parent: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for f in &folders {
        parent.insert(f.id, f.id);
    }

    fn find(parent: &mut std::collections::HashMap<i64, i64>, x: i64) -> i64 {
        let px = *parent.get(&x).unwrap_or(&x);
        if px == x {
            x
        } else {
            let root = find(parent, px);
            parent.insert(x, root);
            root
        }
    }

    fn union(parent: &mut std::collections::HashMap<i64, i64>, a: i64, b: i64) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    }

    // Only merge folders with significant overlap (>50% of smaller folder)
    for (&(id_a, id_b), &count) in &overlap_counts {
        if let (Some(fa), Some(fb)) = (folder_map.get(&id_a), folder_map.get(&id_b)) {
            let min_count = fa.image_count.min(fb.image_count);
            if min_count > 0 && (count as f64) / (min_count as f64) > 0.5 {
                union(&mut parent, id_a, id_b);
            }
        }
    }

    // Group folders by root
    let mut groups: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for f in &folders {
        let root = find(&mut parent, f.id);
        groups.entry(root).or_default().push(f.id);
    }

    // Build result groups (only groups with 2+ folders)
    let mut result = Vec::new();
    for (_, group_ids) in groups {
        if group_ids.len() < 2 {
            continue;
        }

        // Calculate total shared images in this group
        let mut total_shared: i64 = 0;
        let mut folder_infos = Vec::new();

        for &fid in &group_ids {
            if let Some(finfo) = folder_map.get(&fid) {
                // Count how many of this folder's images overlap with other folders in the group
                let mut overlap: i64 = 0;
                for (&(a, b), &count) in &overlap_counts {
                    if (a == fid && group_ids.contains(&b)) || (b == fid && group_ids.contains(&a)) {
                        overlap += count;
                    }
                }
                // Each shared image is counted twice (once per folder pair), so divide by 2 for unique count
                overlap = (overlap + 1) / 2;
                total_shared = total_shared.max(overlap);

                folder_infos.push(curator_core::ipc::DuplicateFolderInfo {
                    id: finfo.id,
                    path: finfo.path.clone(),
                    name: finfo.name.clone(),
                    image_count: finfo.image_count,
                    overlap_count: overlap,
                });
            }
        }

        // Sort by image count descending (keep the largest folder first)
        folder_infos.sort_by(|a, b| b.image_count.cmp(&a.image_count));

        if folder_infos.len() >= 2 {
            result.push(curator_core::ipc::DuplicateFolderGroup {
                folders: folder_infos,
                shared_image_count: total_shared,
            });
        }
    }

    // Sort groups by shared count descending
    result.sort_by(|a, b| b.shared_image_count.cmp(&a.shared_image_count));

    Ok(result)
}

pub async fn merge_folders_logic(
    keep_folder_id: i64,
    merge_folder_id: i64,
    db: &SqlitePool,
) -> Result<(bool, i64)> {
    if keep_folder_id == merge_folder_id {
        return Err(anyhow::anyhow!("Cannot merge a folder into itself"));
    }

    // Verify both folders exist
    let keep_exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE id = ?")
        .bind(keep_folder_id)
        .fetch_optional(db)
        .await?;
    if keep_exists.is_none() {
        return Err(anyhow::anyhow!("Keep folder not found: id={}", keep_folder_id));
    }

    let merge_exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE id = ?")
        .bind(merge_folder_id)
        .fetch_optional(db)
        .await?;
    if merge_exists.is_none() {
        return Err(anyhow::anyhow!("Merge folder not found: id={}", merge_folder_id));
    }

    // Move all images from merge folder to keep folder
    let affected = sqlx::query("UPDATE images SET folder_id = ? WHERE folder_id = ?")
        .bind(keep_folder_id)
        .bind(merge_folder_id)
        .execute(db)
        .await?
        .rows_affected() as i64;

    // Delete the merge folder record
    sqlx::query("DELETE FROM folders WHERE id = ?")
        .bind(merge_folder_id)
        .execute(db)
        .await?;

    info!(
        "Merged folder {} into {}: {} images moved",
        merge_folder_id, keep_folder_id, affected
    );

    Ok((true, affected))
}
