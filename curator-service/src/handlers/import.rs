use anyhow::Result;
use curator_core::ipc::EmbeddingModel;
use curator_core::video::{self, VideoInfo};
use sha2::Digest;
use sqlx::SqlitePool;
use std::fs;
use std::path::Path;
use tracing::{info, warn};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::common::resolve_source_id;

#[derive(Debug, Clone, Default)]

pub struct ImportProgressState {
    pub running: bool,
    pub phase: String, // "idle" | "discovering" | "extracting" | "writing_db" | "complete" | "cancelled" | "failed"
    pub discovered_files: i64,
    pub processed_files: i64,
    pub total_files: i64,
    pub current_file: String,
    pub error_message: String,
}

#[derive(Clone, Default)]
pub struct ImportController {
    pub progress: Arc<Mutex<ImportProgressState>>,
    pub cancel_flag: Arc<AtomicBool>,
}

impl ImportController {
    pub fn new() -> Self {
        Self {
            progress: Arc::new(Mutex::new(ImportProgressState {
                phase: "idle".to_string(),
                ..Default::default()
            })),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn get_progress(&self) -> ImportProgressState {
        self.progress.lock().unwrap().clone()
    }

    pub fn request_cancel(&self) -> bool {
        let running = self.progress.lock().unwrap().running;
        if running {
            self.cancel_flag.store(true, Ordering::SeqCst);
            let mut p = self.progress.lock().unwrap();
            p.phase = "cancelled".to_string();
            true
        } else {
            false
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel_flag.load(Ordering::Relaxed)
    }

    pub fn reset(&self) {
        self.cancel_flag.store(false, Ordering::SeqCst);
        let mut p = self.progress.lock().unwrap();
        *p = ImportProgressState {
            running: true,
            phase: "discovering".to_string(),
            discovered_files: 0,
            processed_files: 0,
            total_files: 0,
            current_file: String::new(),
            error_message: String::new(),
        };
    }

    pub fn set_discovering(&self, count: i64, current_path: &str) {
        let mut p = self.progress.lock().unwrap();
        p.discovered_files = count;
        p.current_file = current_path.to_string();
    }

    pub fn set_extracting(&self, total: i64, processed: i64, current_path: &str) {
        let mut p = self.progress.lock().unwrap();
        p.phase = "extracting".to_string();
        p.total_files = total;
        p.processed_files = processed;
        p.current_file = current_path.to_string();
    }

    pub fn set_writing_db(&self, total: i64, processed: i64) {
        let mut p = self.progress.lock().unwrap();
        p.phase = "writing_db".to_string();
        p.total_files = total;
        p.processed_files = processed;
    }

    pub fn set_complete(&self, total: i64) {
        let mut p = self.progress.lock().unwrap();
        p.running = false;
        p.phase = "complete".to_string();
        p.total_files = total;
        p.processed_files = total;
        p.current_file.clear();
    }

    pub fn set_cancelled(&self) {
        let mut p = self.progress.lock().unwrap();
        p.running = false;
        p.phase = "cancelled".to_string();
        p.current_file.clear();
    }

    pub fn set_failed(&self, err: &str) {
        let mut p = self.progress.lock().unwrap();
        p.running = false;
        p.phase = "failed".to_string();
        p.error_message = err.to_string();
        p.current_file.clear();
    }
}


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

/// Reconcile one imported image row within a transaction: update the existing
/// row (or insert a new one) and ensure a `pending` vector row exists for the
/// active embedding source. Returns the image id.
struct PreppedImage {
    path_str: String,
    sha256: String,
    mtime: i64,
    phash: Option<String>,
    media: MediaExtract,
}

async fn upsert_image_row(
    exec: &mut sqlx::SqliteConnection,
    item: &PreppedImage,
    folder_id: Option<i64>,
    clip_source_id: i64,
    existing: Option<(i64, String)>,
) -> Result<i64> {
    if let Some((id, _old_path)) = existing {
        sqlx::query(
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
        .execute(&mut *exec)
        .await?;

        let vec_exists: Option<(String,)> = sqlx::query_as(
            "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
        )
        .bind(id)
        .bind(clip_source_id)
        .fetch_optional(&mut *exec)
        .await
        .unwrap_or(None);

        if vec_exists.is_none() {
            sqlx::query(
                "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
            )
            .bind(id)
            .bind(clip_source_id)
            .execute(&mut *exec)
            .await?;
        }
        Ok(id)
    } else {
        let id = sqlx::query(
            "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id, width, height, video_frame_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.sha256)
        .bind(&item.phash)
        .bind(&item.path_str)
        .bind(item.mtime)
        .bind(folder_id)
        .bind(item.media.width)
        .bind(item.media.height)
        .bind(&item.media.video_frame_path)
        .execute(&mut *exec)
        .await?
        .last_insert_rowid();

        sqlx::query(
            "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
        )
        .bind(id)
        .bind(clip_source_id)
        .execute(&mut *exec)
        .await?;
        Ok(id)
    }
}

pub async fn import_paths_logic(
    paths: &[String],
    db: &SqlitePool,
    active: EmbeddingModel,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
    controller: &ImportController,
) -> Result<(i64, String, usize, Vec<i64>)> {

    controller.reset();

    let clean_paths: Vec<String> = paths
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if clean_paths.is_empty() {
        controller.set_failed("No file or folder paths provided for import");
        return Err(anyhow::anyhow!("No file or folder paths provided for import"));
    }

    let mut files_to_prep: Vec<(std::path::PathBuf, i64)> = Vec::new();
    let mut folder_ids: Vec<i64> = Vec::new();
    let mut total_found = 0usize;

    for path_str in &clean_paths {
        if controller.is_cancelled() {
            controller.set_cancelled();
            return Err(anyhow::anyhow!("Import cancelled by user"));
        }

        let path = Path::new(path_str);
        if !path.exists() {
            warn!("Skipping non-existent path during import: {}", path_str);
            continue;
        }

        if path.is_dir() {
            let folder_id = match get_or_create_folder(path_str, db).await {
                Ok(id) => id,
                Err(e) => {
                    controller.set_failed(&e.to_string());
                    return Err(e);
                }
            };
            if !folder_ids.contains(&folder_id) {
                folder_ids.push(folder_id);
            }

            let mut paths_to_process = vec![path.to_path_buf()];
            while let Some(current_path) = paths_to_process.pop() {
                if controller.is_cancelled() {
                    controller.set_cancelled();
                    return Err(anyhow::anyhow!("Import cancelled by user"));
                }
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
                            files_to_prep.push((current_path, folder_id));
                            total_found += 1;
                            if total_found % 25 == 0 {
                                controller.set_discovering(total_found as i64, path_str);
                            }
                        }
                    }
                }
            }
            controller.set_discovering(total_found as i64, path_str);
        } else if path.is_file() {
            let parent_dir = path
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(path_str);
            let folder_id = get_or_create_folder(parent_dir, db).await?;
            if !folder_ids.contains(&folder_id) {
                folder_ids.push(folder_id);
            }
            files_to_prep.push((path.to_path_buf(), folder_id));
            total_found += 1;
            controller.set_discovering(total_found as i64, path_str);
        }
    }

    if files_to_prep.is_empty() {
        controller.set_failed("No supported media files found in selected path(s)");
        return Err(anyhow::anyhow!(
            "No supported media files found in selected path(s)"
        ));
    }

    let total_count = files_to_prep.len();
    controller.set_extracting(total_count as i64, 0, "");

    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files_to_prep.len());

    let chunk_size = (files_to_prep.len() + num_threads - 1) / num_threads;
    let mut prepped_images: Vec<(PreppedImage, i64)> = Vec::with_capacity(files_to_prep.len());
    let ffmpeg_owned = ffmpeg.map(|p| p.to_path_buf());
    let processed_counter = std::sync::atomic::AtomicUsize::new(0);

    std::thread::scope(|s| {
        let mut handles = Vec::with_capacity(num_threads);

        for chunk in files_to_prep.chunks(chunk_size) {
            let chunk_items = chunk.to_vec();
            let ffmpeg_ref = ffmpeg_owned.clone();
            let data_dir_owned = data_dir.to_path_buf();
            let ctrl = controller.clone();
            let proc_ref = &processed_counter;

            let handle = s.spawn(move || {
                let mut items = Vec::with_capacity(chunk_items.len());
                for (p, folder_id) in chunk_items {
                    if ctrl.is_cancelled() {
                        break;
                    }
                    let p_str = p.to_string_lossy().to_string();
                    if let Ok(metadata) = fs::metadata(&p) {
                        let mtime = metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        let media = match extract_media_info(
                            &p,
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
                        let sha256 = compute_content_sha(&p, &media);
                        items.push((
                            PreppedImage {
                                path_str: p_str.clone(),
                                sha256,
                                mtime,
                                phash: None,
                                media,
                            },
                            folder_id,
                        ));
                    }
                    let done = proc_ref.fetch_add(1, Ordering::Relaxed) + 1;
                    if done % 10 == 0 || done == total_count {
                        ctrl.set_extracting(total_count as i64, done as i64, &p_str);
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

    if controller.is_cancelled() {
        controller.set_cancelled();
        return Err(anyhow::anyhow!("Import cancelled by user"));
    }

    let clip_source_id = resolve_source_id(db, active.source_name()).await?;

    let mut first_id = 0;
    let mut first_sha = String::new();
    let mut imported_any = false;
    let mut written_count = 0i64;

    controller.set_writing_db(prepped_images.len() as i64, 0);

    // Batch all per-image statements in a single transaction.
    let mut tx = db.begin().await?;
    for (item, item_folder_id) in prepped_images {
        if controller.is_cancelled() {
            let _ = tx.rollback().await;
            controller.set_cancelled();
            return Err(anyhow::anyhow!("Import cancelled by user"));
        }

        let existing: Option<(i64, String)> =
            sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
                .bind(&item.sha256)
                .fetch_optional(&mut *tx)
                .await?;

        let existing = match existing {
            Some(row) => Some(row),
            None => sqlx::query_as(
                "SELECT id, current_filepath FROM images WHERE current_filepath = ? AND deleted_at IS NULL",
            )
            .bind(&item.path_str)
            .fetch_optional(&mut *tx)
            .await?,
        };

        let img_id = upsert_image_row(&mut tx, &item, Some(item_folder_id), clip_source_id, existing)
            .await?;

        upsert_animation_metadata(&mut tx, img_id, &item.media).await?;
        upsert_video_metadata(&mut tx, img_id, &item.media).await?;

        written_count += 1;

        if written_count % 20 == 0 || written_count == total_count as i64 {
            controller.set_writing_db(total_count as i64, written_count);
        }

        if !imported_any {
            first_id = img_id;
            first_sha = item.sha256;
            imported_any = true;
        }
    }
    tx.commit().await?;

    if imported_any {
        controller.set_complete(total_count as i64);
        Ok((first_id, first_sha, total_count, folder_ids))
    } else {
        controller.set_failed("Failed to import any images from specified path(s)");
        Err(anyhow::anyhow!(
            "Failed to import any images from specified path(s)"
        ))
    }
}

pub async fn import_image_logic(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
    ffmpeg: Option<&Path>,
    data_dir: &Path,
    controller: &ImportController,
) -> Result<(i64, String, usize, Option<i64>)> {
    let (id, sha, count, folder_ids) = import_paths_logic(
        &[path_str.to_string()],
        db,
        active,
        ffmpeg,
        data_dir,
        controller,
    )
    .await?;
    Ok((id, sha, count, folder_ids.into_iter().next()))
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
    controller: &ImportController,
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
        import_image_logic(&path, db, active, ffmpeg, data_dir, controller).await?;


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

    let source_name = active.source_name();
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
           )
         ON CONFLICT(image_id, source_id) DO UPDATE SET vector_state = 'pending', vector_id = '', vector_checksum = NULL
         WHERE vector_state NOT IN ('ready', 'pending', 'preprocessing')",
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


