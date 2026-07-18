use anyhow::{Context, Error};
use clap::Parser;
use curator_core::db::init_db;
use curator_core::vector::{ModelManager, VectorIndex};
use curator_core::ipc::{Request, Response, SearchMatch, ImageDetails};
use sqlx::SqlitePool;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ServerOptions;
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use sha2::Digest;

mod auth;
mod worker;

use auth::load_or_create_service_key;
use worker::BackgroundWorker;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short, long, default_value = ".curator")]
    data_dir: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args = Args::parse();
    let data_dir = PathBuf::from(&args.data_dir);
    fs::create_dir_all(&data_dir)?;

    // Open log file in append mode
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(data_dir.join("curator.log"))
        .context("Failed to open log file")?;

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false);

    let console_layer = tracing_subscriber::fmt::layer();

    // Initialize structured logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(console_layer)
        .with(file_layer)
        .init();

    info!("Starting Project Curator Service...");

    // 1. Load or generate service key
    let service_key = load_or_create_service_key(&data_dir)?;
    info!("Service Key authenticated successfully.");

    // 2. Initialize SQLite Database
    let db_path = data_dir.join("curator.db");
    let db = init_db(&db_path).await?;

    // Seed the AI model source if missing
    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('ai:clip-vit-b-32', 'AI_MODEL', '{}')"
    )
    .execute(&db)
    .await?;

    // Seed the user source if missing
    sqlx::query(
        "INSERT OR IGNORE INTO sources (name, type, manifest) VALUES ('user', 'USER', '{}')"
    )
    .execute(&db)
    .await?;

    // 3. Initialize CLIP Models
    let model_dir = data_dir.join("models");
    let mut model_manager = ModelManager::new(&model_dir);
    model_manager.init()?;
    let model_manager = Arc::new(model_manager);

    // 4. Initialize Vector Index
    let index_path = data_dir.join("vector_index.usearch");
    let vector_index = Arc::new(VectorIndex::new(&index_path, 512)?);

    // 5. Start Background Job Worker
    let worker = BackgroundWorker::new(db.clone(), model_manager.clone(), vector_index.clone());
    worker.start();

    // 6. Start Named Pipe Server Loop
    let pipe_name = r"\\.\pipe\curator_ipc";
    info!("Listening on Named Pipe: {}", pipe_name);

    let db_arc = db.clone();
    let mm_arc = model_manager.clone();
    let vi_arc = vector_index.clone();
    let key_arc = Arc::new(service_key);

    // Named Pipe listener loop
    let mut is_first = true;
    loop {
        let server = ServerOptions::new()
            .first_pipe_instance(is_first)
            .create(pipe_name)
            .context("Failed to create named pipe instance")?;
        is_first = false;

        server.connect().await?;

        let db = db_arc.clone();
        let mm = mm_arc.clone();
        let vi = vi_arc.clone();
        let key = key_arc.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_client(server, db, mm, vi, key).await {
                error!("Error handling IPC client: {:?}", e);
            }
        });
    }
}

async fn handle_client(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    db: SqlitePool,
    model_manager: Arc<ModelManager>,
    vector_index: Arc<VectorIndex>,
    service_key: Arc<String>,
) -> Result<(), Error> {
    info!("New client connected to named pipe.");
    let mut buffer = vec![0; 16384];

    // Read Handshake (the token key must be sent first)
    let n = stream.read(&mut buffer).await?;
    if n == 0 {
        return Ok(());
    }

    let token_input = String::from_utf8_lossy(&buffer[..n]).trim().to_string();
    if token_input != *service_key {
        warn!("Client authentication failed. Invalid token.");
        stream.write_all(b"AUTH_FAILED").await?;
        return Ok(());
    }

    // Auth succeeded
    stream.write_all(b"AUTH_OK").await?;

    // Process requests
    loop {
        let n = stream.read(&mut buffer).await?;
        if n == 0 {
            break; // connection closed
        }

        let request_str = String::from_utf8_lossy(&buffer[..n]);
        let request: Request = match serde_json::from_str(&request_str) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = Response::Error { message: format!("Failed to parse request JSON: {:?}", e) };
                let resp_str = serde_json::to_string(&err_resp)?;
                stream.write_all(resp_str.as_bytes()).await?;
                continue;
            }
        };

        info!("Received Request: {:?}", request);
        let response = handle_request(request, &db, &model_manager, &vector_index).await;
        
        let response_str = serde_json::to_string(&response)?;
        stream.write_all(response_str.as_bytes()).await?;
    }

    info!("Client disconnected.");
    Ok(())
}

async fn handle_request(
    request: Request,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Response {
    match request {
        Request::Ping => Response::Pong,
        Request::GetStatus => {
            match query_status(db).await {
                Ok((images, vectors, pending)) => Response::StatusResult {
                    image_count: images,
                    vector_count: vectors,
                    pending_jobs: pending,
                },
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::ImportImage { path } => {
            match import_image_logic(&path, db).await {
                Ok((id, sha256)) => Response::ImportResult { image_id: id, sha256 },
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::AddTag { image_id, tag, category } => {
            match add_tag_logic(image_id, &tag, &category, db).await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::RemoveTag { image_id, tag_id } => {
            // Soft delete
            match sqlx::query(
                "UPDATE image_tags 
                 SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP 
                 WHERE image_id = ? AND tag_id = ?"
            )
            .bind(image_id)
            .bind(tag_id)
            .execute(db)
            .await
            {
                Ok(_) => Response::Success,
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::Search { query_text, tag_filter, limit } => {
            match search_logic(query_text, tag_filter, limit, db, model_manager, vector_index).await {
                Ok(matches) => Response::SearchResult { matches },
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::ListImages { limit, offset } => {
            match list_images_logic(limit, offset, db).await {
                Ok(images) => Response::ListResult { images },
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::GetImage { image_id } => {
            match get_image_logic(image_id, db).await {
                Ok(image) => Response::ImageResult { image },
                Err(e) => Response::Error { message: e.to_string() }
            }
        }
        Request::ValidatePlugin { manifest_path } => {
            match validate_plugin_logic(&manifest_path).await {
                Ok((name, version)) => Response::ValidationResult { name, version, valid: true, error: None },
                Err(e) => Response::ValidationResult {
                    name: String::new(),
                    version: String::new(),
                    valid: false,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

async fn query_status(db: &SqlitePool) -> Result<(i64, i64, i64), Error> {
    let images: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM images WHERE deleted_at IS NULL").fetch_one(db).await?;
    let vectors: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'ready'").fetch_one(db).await?;
    let pending: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'pending'").fetch_one(db).await?;
    Ok((images.0, vectors.0, pending.0))
}

async fn import_image_logic(path_str: &str, db: &SqlitePool) -> Result<(i64, String), Error> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("File or directory does not exist: {}", path_str));
    }

    if path.is_dir() {
        // Scan directory recursively
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
                    if ext_lower == "png" || ext_lower == "jpg" || ext_lower == "jpeg" || ext_lower == "webp" || ext_lower == "bmp" || ext_lower == "gif" || ext_lower == "tiff" {
                        image_paths.push(current_path);
                    }
                }
            }
        }
        
        if image_paths.is_empty() {
            return Err(anyhow::anyhow!("No supported image files found in directory: {}", path_str));
        }
        
        let mut first_id = 0;
        let mut first_sha = String::new();
        let mut imported_any = false;
        
        for img_path in image_paths {
            if let Some(p_str) = img_path.to_str() {
                match import_single_image(p_str, db).await {
                    Ok((id, sha)) => {
                        if !imported_any {
                            first_id = id;
                            first_sha = sha;
                            imported_any = true;
                        }
                    }
                    Err(e) => {
                        warn!("Failed to import image {:?}: {:?}", img_path, e);
                    }
                }
            }
        }
        
        if imported_any {
            Ok((first_id, first_sha))
        } else {
            Err(anyhow::anyhow!("Failed to import any images from directory: {}", path_str))
        }
    } else {
        import_single_image(path_str, db).await
    }
}

async fn import_single_image(path_str: &str, db: &SqlitePool) -> Result<(i64, String), Error> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("File does not exist: {}", path_str));
    }

    // 1. Compute SHA256 hash
    let data = fs::read(path)?;
    let sha256 = format!("{:x}", sha2::Sha256::digest(&data));

    // Get file mtime
    let metadata = fs::metadata(path)?;
    let mtime = metadata.modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?
        .as_secs() as i64;

    // Fetch CLIP model source ID
    let clip_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = 'ai:clip-vit-b-32' LIMIT 1").fetch_one(db).await?;
    let clip_source_id = clip_row.0;

    // Check if image already exists
    let existing: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, current_filepath FROM images WHERE sha256 = ?"
    )
    .bind(&sha256)
    .fetch_optional(db)
    .await?;

    if let Some((id, old_path)) = existing {
        // Path repair: update filepath if it moved
        if old_path != path_str {
            sqlx::query("UPDATE images SET current_filepath = ?, mtime = ?, deleted_at = NULL WHERE id = ?")
                .bind(path_str)
                .bind(mtime)
                .bind(id)
                .execute(db)
                .await?;
            info!("Path repair: updated filepath of image ID {} from {} to {}", id, old_path, path_str);
        }
        return Ok((id, sha256));
    }

    // Insert new image
    let id = sqlx::query(
        "INSERT INTO images (sha256, current_filepath, mtime) VALUES (?, ?, ?)"
    )
    .bind(&sha256)
    .bind(path_str)
    .bind(mtime)
    .execute(db)
    .await?
    .last_insert_rowid();

    // Create pending vector placeholder
    sqlx::query(
        "INSERT INTO image_vectors (image_id, source_id, vector_id, vector_state) VALUES (?, ?, '', 'pending')"
    )
    .bind(id)
    .bind(clip_source_id)
    .execute(db)
    .await?;

    Ok((id, sha256))
}

async fn add_tag_logic(image_id: i64, tag: &str, category: &str, db: &SqlitePool) -> Result<(), Error> {
    // Insert tag or ignore if exists
    sqlx::query("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)")
        .bind(tag)
        .bind(category)
        .execute(db)
        .await?;

    let tag_row: (i64,) = sqlx::query_as("SELECT id FROM tags WHERE name = ? LIMIT 1").bind(tag).fetch_one(db).await?;
    let tag_id = tag_row.0;

    // Fetch user source ID
    let source_row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = 'user' LIMIT 1").fetch_one(db).await?;
    let source_id = source_row.0;

    // Add to image_tags
    sqlx::query(
        "INSERT OR REPLACE INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted) 
         VALUES (?, ?, ?, 1.0, 0)"
    )
    .bind(image_id)
    .bind(tag_id)
    .bind(source_id)
    .execute(db)
    .await?;

    Ok(())
}

async fn search_logic(
    query_text: Option<String>,
    tag_filter: Option<String>,
    limit: usize,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
) -> Result<Vec<SearchMatch>, Error> {
    let mut candidate_ids: Option<std::collections::HashSet<i64>> = None;
    let mut vector_scores: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();

    // 1. Vector Search
    if let Some(text) = query_text {
        if !text.trim().is_empty() {
            let query_vector = model_manager.generate_text_embedding(&text)?;
            let results = vector_index.search(&query_vector, limit.max(100))?;
            
            let mut ids = std::collections::HashSet::new();
            for (id, dist) in results {
                let id_i64 = id as i64;
                ids.insert(id_i64);
                // Cosine similarity = 1.0 - cosine distance
                let score = 1.0 - dist;
                vector_scores.insert(id_i64, score);
            }
            candidate_ids = Some(ids);
        }
    }

    // 2. Tag Filter
    if let Some(tag_name) = tag_filter {
        if !tag_name.trim().is_empty() {
            let tagged_images: Vec<(i64,)> = sqlx::query_as(
                "SELECT DISTINCT it.image_id FROM image_tags it
                 JOIN tags t ON it.tag_id = t.id
                 WHERE t.name = ? AND it.is_deleted = 0"
            )
            .bind(tag_name)
            .fetch_all(db)
            .await?;

            let mut tag_set = std::collections::HashSet::new();
            for row in tagged_images {
                tag_set.insert(row.0);
            }

            if let Some(ref mut existing_candidates) = candidate_ids {
                // Intersect
                *existing_candidates = existing_candidates.intersection(&tag_set).cloned().collect();
            } else {
                candidate_ids = Some(tag_set);
            }
        }
    }

    // 3. Populate detailed match fields
    let target_ids = match candidate_ids {
        Some(set) => set.into_iter().collect::<Vec<i64>>(),
        None => {
            // Default: List latest 50 images if no filters
            let latest: Vec<(i64,)> = sqlx::query_as(
                "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?"
            )
            .bind(limit as i64)
            .fetch_all(db)
            .await?;
            latest.into_iter().map(|r| r.0).collect()
        }
    };

    let mut matches = Vec::new();
    for id in target_ids {
        if let Ok(details) = get_image_logic(id, db).await {
            let score = vector_scores.get(&details.id).cloned().unwrap_or(1.0);
            matches.push(SearchMatch {
                id: details.id,
                filepath: details.current_filepath,
                score,
                tags: details.tags,
            });
        }
    }

    // Sort matches by score descending
    matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Limit results
    matches.truncate(limit);
    Ok(matches)
}

async fn list_images_logic(limit: usize, offset: usize, db: &SqlitePool) -> Result<Vec<ImageDetails>, Error> {
    let image_ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(db)
    .await?;

    let mut images = Vec::new();
    for row in image_ids {
        if let Ok(img) = get_image_logic(row.0, db).await {
            images.push(img);
        }
    }
    Ok(images)
}

async fn get_image_logic(image_id: i64, db: &SqlitePool) -> Result<ImageDetails, Error> {
    let img: curator_core::db::models::Image = sqlx::query_as(
        "SELECT * FROM images WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(image_id)
    .fetch_one(db)
    .await?;

    let tags: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT t.name FROM image_tags it
         JOIN tags t ON it.tag_id = t.id
         WHERE it.image_id = ? AND it.is_deleted = 0"
    )
    .bind(image_id)
    .fetch_all(db)
    .await?;

    let vector_state: (String,) = sqlx::query_as(
        "SELECT vector_state FROM image_vectors WHERE image_id = ? LIMIT 1"
    )
    .bind(image_id)
    .fetch_one(db)
    .await?;

    Ok(ImageDetails {
        id: img.id,
        sha256: img.sha256,
        current_filepath: img.current_filepath,
        mtime: img.mtime,
        created_at: img.created_at.to_string(),
        tags: tags.into_iter().map(|r| r.0).collect(),
        vector_state: vector_state.0,
    })
}

async fn validate_plugin_logic(manifest_path_str: &str) -> Result<(String, String), Error> {
    let path = Path::new(manifest_path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("manifest.json path does not exist"));
    }

    let content = fs::read_to_string(path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;

    let name = val.get("name").and_then(|v| v.as_str()).context("Missing 'name' field")?.to_string();
    let version = val.get("version").and_then(|v| v.as_str()).context("Missing 'version' field")?.to_string();
    
    // Check permission format
    if let Some(permissions) = val.get("permissions") {
        if !permissions.is_object() {
            return Err(anyhow::anyhow!("'permissions' must be a JSON object"));
        }
    }

    Ok((name, version))
}
