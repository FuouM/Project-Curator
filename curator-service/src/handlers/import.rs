use anyhow::Result;
use curator_core::ipc::EmbeddingModel;
use sha2::Digest;
use sqlx::SqlitePool;
use std::fs;
use std::path::Path;
use tracing::{info, warn};

use super::common::resolve_source_id;

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
) -> Result<(i64, String)> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("File does not exist: {}", path_str));
    }

    let data = fs::read(path)?;
    let sha256 = format!("{:x}", sha2::Sha256::digest(&data));

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

    let phash = match curator_core::vector::compute_ahash(path) {
        Ok(h) => Some(h),
        Err(e) => {
            warn!("Failed to compute aHash for image {:?}: {:?}", path, e);
            None
        }
    };

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
            .bind(&sha256)
            .fetch_optional(db)
            .await?;

    if let Some((id, _old_path)) = existing {
        sqlx::query(
            "UPDATE images SET current_filepath = ?, mtime = ?, phash = ?, folder_id = COALESCE(folder_id, ?), deleted_at = NULL WHERE id = ?",
        )
        .bind(path_str)
        .bind(mtime)
        .bind(&phash)
        .bind(folder_id)
        .bind(id)
        .execute(db)
        .await?;

        let vec_exists: Option<(String,)> = sqlx::query_as(
            "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
        )
        .bind(id)
        .bind(clip_source_id)
        .fetch_optional(db)
        .await
        .unwrap_or(None);

        if vec_exists.is_none() {
            let _ = sqlx::query(
                "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
            )
            .bind(id)
            .bind(clip_source_id)
            .execute(db)
            .await?;
        }
        return Ok((id, sha256));
    }

    let id = sqlx::query(
        "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&sha256)
    .bind(&phash)
    .bind(path_str)
    .bind(mtime)
    .bind(folder_id)
    .execute(db)
    .await?
    .last_insert_rowid();

    sqlx::query(
        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
    )
    .bind(id)
    .bind(clip_source_id)
    .execute(db)
    .await?;

    Ok((id, sha256))
}

pub async fn import_image_logic(
    path_str: &str,
    db: &SqlitePool,
    active: EmbeddingModel,
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
                        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff"
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
        }

        let mut prepped_images = Vec::with_capacity(paths_vec.len());

        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(num_threads);

            for chunk in paths_vec.chunks(chunk_size) {
                let chunk_paths = chunk.to_vec();
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
                            if let Ok(data) = fs::read(p) {
                                let sha256 = format!("{:x}", sha2::Sha256::digest(&data));
                                items.push(PreppedImage {
                                    path_str: p_str,
                                    sha256,
                                    mtime,
                                    phash: None,
                                });
                            }
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

        for item in prepped_images {
            let existing: Option<(i64, String)> =
                sqlx::query_as("SELECT id, current_filepath FROM images WHERE sha256 = ?")
                    .bind(&item.sha256)
                    .fetch_optional(db)
                    .await?;

            let img_id = if let Some((id, _old_path)) = existing {
                let _ = sqlx::query(
                    "UPDATE images SET current_filepath = ?, mtime = ?, phash = ?, folder_id = COALESCE(folder_id, ?), deleted_at = NULL WHERE id = ?",
                )
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(&item.phash)
                .bind(folder_id)
                .bind(id)
                .execute(db)
                .await;

                let vec_exists: Option<(String,)> = sqlx::query_as(
                    "SELECT vector_state FROM image_vectors WHERE image_id = ? AND source_id = ? LIMIT 1",
                )
                .bind(id)
                .bind(clip_source_id)
                .fetch_optional(db)
                .await
                .unwrap_or(None);

                if vec_exists.is_none() {
                    let _ = sqlx::query(
                        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                    )
                    .bind(id)
                    .bind(clip_source_id)
                    .execute(db)
                    .await;
                }
                id
            } else {
                let id = sqlx::query(
                    "INSERT INTO images (sha256, phash, current_filepath, mtime, folder_id) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&item.sha256)
                .bind(&item.phash)
                .bind(&item.path_str)
                .bind(item.mtime)
                .bind(Some(folder_id))
                .execute(db)
                .await?
                .last_insert_rowid();

                let _ = sqlx::query(
                    "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')",
                )
                .bind(id)
                .bind(clip_source_id)
                .execute(db)
                .await;

                id
            };

            if !imported_any {
                first_id = img_id;
                first_sha = item.sha256;
                imported_any = true;
            }
        }

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
        let (id, sha) = import_single_image(path_str, db, active, Some(folder_id)).await?;
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

    for img in images {
        let path = Path::new(&img.current_filepath);
        let parent_dir = match path.parent() {
            Some(p) => p.to_str().unwrap_or(""),
            None => continue,
        };

        if parent_dir.is_empty() {
            continue;
        }

        let folder_id = get_or_create_folder(parent_dir, db).await?;

        sqlx::query("UPDATE images SET folder_id = ? WHERE id = ?")
            .bind(folder_id)
            .bind(img.id)
            .execute(db)
            .await?;

        backfilled += 1;
    }

    info!("Backfilled {} images with folder assignments", backfilled);
    Ok(backfilled)
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
            COUNT(i.id) as image_count,
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

    Ok(rows
        .into_iter()
        .map(|r| curator_core::ipc::FolderDetails {
            id: r.id,
            path: r.path,
            name: r.name,
            imported_at: r.imported_at,
            image_count: r.image_count,
            vector_ready: r.vector_ready,
            vector_pending: r.vector_pending,
        })
        .collect())
}
