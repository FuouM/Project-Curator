use anyhow::Result;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tracing::info;

use crate::models::{DuplicateFolderGroup, DuplicateFolderInfo, FolderDetails};

pub struct FolderRepo;

impl FolderRepo {
    /// Get an existing folder ID by path or insert a new one.
    pub async fn get_or_create_folder(folder_path: &str, db: &SqlitePool) -> Result<i64> {
        let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE path = ?")
            .bind(folder_path)
            .fetch_optional(db)
            .await?;

        if let Some((id,)) = existing {
            return Ok(id);
        }

        let name = Path::new(folder_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(folder_path);

        let id = sqlx::query(
            "INSERT INTO folders (path, name, imported_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        )
        .bind(folder_path)
        .bind(name)
        .execute(db)
        .await?
        .last_insert_rowid();

        Ok(id)
    }

    /// List all imported folders with file and vector status counts.
    pub async fn get_imported_folders(db: &SqlitePool) -> Result<Vec<FolderDetails>> {
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
                COALESCE(SUM(CASE WHEN iv.vector_state = 'ready' THEN 1 ELSE 0 END), 0) as video_ready,
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

        let mut missing_per_folder: HashMap<i64, (i64, i64)> = HashMap::new();
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
                FolderDetails {
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

    /// Update folder path and derived name.
    pub async fn update_folder_path(id: i64, new_path: &str, db: &SqlitePool) -> Result<bool> {
        let new_path_obj = Path::new(new_path);
        if !new_path_obj.exists() {
            anyhow::bail!("New folder path does not exist: {}", new_path);
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
            anyhow::bail!("Folder not found: id={}", id);
        }
    }

    /// Delete a folder entry.
    pub async fn delete_folder(id: i64, db: &SqlitePool) -> Result<bool> {
        let affected = sqlx::query("DELETE FROM folders WHERE id = ?")
            .bind(id)
            .execute(db)
            .await?
            .rows_affected();

        if affected > 0 {
            info!("Deleted folder record id={}", id);
            Ok(true)
        } else {
            anyhow::bail!("Folder not found: id={}", id);
        }
    }

    /// Detect duplicate / overlapping folder groups based on image SHA-256 intersection.
    pub async fn detect_duplicate_folders(db: &SqlitePool) -> Result<Vec<DuplicateFolderGroup>> {
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

        let mut sha_to_folders: HashMap<String, HashSet<i64>> = HashMap::new();
        for item in all_sha {
            sha_to_folders
                .entry(item.sha256)
                .or_default()
                .insert(item.folder_id);
        }

        let folder_map: HashMap<i64, &FolderInfo> = folders.iter().map(|f| (f.id, f)).collect();
        let mut overlap_counts: HashMap<(i64, i64), i64> = HashMap::new();

        for folder_set in sha_to_folders.values() {
            if folder_set.len() < 2 {
                continue;
            }
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

        let mut parent: HashMap<i64, i64> = HashMap::new();
        for f in &folders {
            parent.insert(f.id, f.id);
        }

        fn find(parent: &mut HashMap<i64, i64>, x: i64) -> i64 {
            let px = *parent.get(&x).unwrap_or(&x);
            if px == x {
                x
            } else {
                let root = find(parent, px);
                parent.insert(x, root);
                root
            }
        }

        fn union(parent: &mut HashMap<i64, i64>, a: i64, b: i64) {
            let ra = find(parent, a);
            let rb = find(parent, b);
            if ra != rb {
                parent.insert(ra, rb);
            }
        }

        for (&(id_a, id_b), &count) in &overlap_counts {
            if let (Some(fa), Some(fb)) = (folder_map.get(&id_a), folder_map.get(&id_b)) {
                let min_count = fa.image_count.min(fb.image_count);
                if min_count > 0 && (count as f64) / (min_count as f64) > 0.5 {
                    union(&mut parent, id_a, id_b);
                }
            }
        }

        let mut groups: HashMap<i64, Vec<i64>> = HashMap::new();
        for f in &folders {
            let root = find(&mut parent, f.id);
            groups.entry(root).or_default().push(f.id);
        }

        let mut result = Vec::new();
        for (_, group_ids) in groups {
            if group_ids.len() < 2 {
                continue;
            }

            let mut total_shared: i64 = 0;
            let mut folder_infos = Vec::new();

            for &fid in &group_ids {
                if let Some(finfo) = folder_map.get(&fid) {
                    let mut overlap: i64 = 0;
                    for (&(a, b), &count) in &overlap_counts {
                        if (a == fid && group_ids.contains(&b)) || (b == fid && group_ids.contains(&a)) {
                            overlap += count;
                        }
                    }
                    overlap = (overlap + 1) / 2;
                    total_shared = total_shared.max(overlap);

                    folder_infos.push(DuplicateFolderInfo {
                        id: finfo.id,
                        path: finfo.path.clone(),
                        name: finfo.name.clone(),
                        image_count: finfo.image_count,
                        overlap_count: overlap,
                    });
                }
            }

            folder_infos.sort_by_key(|b| std::cmp::Reverse(b.image_count));

            if folder_infos.len() >= 2 {
                result.push(DuplicateFolderGroup {
                    folders: folder_infos,
                    shared_image_count: total_shared,
                });
            }
        }

        result.sort_by_key(|b| std::cmp::Reverse(b.shared_image_count));
        Ok(result)
    }

    /// Merge one folder into another.
    pub async fn merge_folders(
        keep_folder_id: i64,
        merge_folder_id: i64,
        db: &SqlitePool,
    ) -> Result<(bool, i64)> {
        if keep_folder_id == merge_folder_id {
            anyhow::bail!("Cannot merge a folder into itself");
        }

        let keep_exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE id = ?")
            .bind(keep_folder_id)
            .fetch_optional(db)
            .await?;
        if keep_exists.is_none() {
            anyhow::bail!("Keep folder not found: id={}", keep_folder_id);
        }

        let merge_exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM folders WHERE id = ?")
            .bind(merge_folder_id)
            .fetch_optional(db)
            .await?;
        if merge_exists.is_none() {
            anyhow::bail!("Merge folder not found: id={}", merge_folder_id);
        }

        let affected = sqlx::query("UPDATE images SET folder_id = ? WHERE folder_id = ?")
            .bind(keep_folder_id)
            .bind(merge_folder_id)
            .execute(db)
            .await?
            .rows_affected() as i64;

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
}
