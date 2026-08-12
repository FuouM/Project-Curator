use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tokio::sync::OnceCell;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use tonic::transport::Channel;

mod typed_bridge;

use curator_core::thumbnail::ThumbnailCache;
use curator_core::constants::resolve_data_dir;

/// Resolved once at first use; all functions reference this.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn data_dir() -> &'static PathBuf {
    DATA_DIR.get_or_init(resolve_data_dir)
}

fn log_dashboard_event(msg: &str) {
    let data_dir = data_dir();
    let _ = fs::create_dir_all(data_dir);
    let log_file = data_dir.join("dashboard.log");

    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
    {
        use std::io::Write;
        let timestamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

fn spawn_service() {
    let data_dir = data_dir();
    let _ = fs::create_dir_all(data_dir);
    let stdout_log_path = data_dir.join("service_stdout.log");

    log_dashboard_event("Attempting to spawn curator-service...");

    if let Ok(exe_path) = std::env::current_exe() {
        log_dashboard_event(&format!("Current exe path: {:?}", exe_path));
        if let Some(dir) = exe_path.parent() {
            // Standard location (release or debug output folder)
            let mut candidate = dir.join("curator-service.exe");

            // Fallback for dev mode running from deps/
            if !candidate.exists() {
                if let Some(parent) = dir.parent() {
                    let dep_candidate = parent.join("curator-service.exe");
                    if dep_candidate.exists() {
                        candidate = dep_candidate;
                    }
                }
            }

            if candidate.exists() {
                log_dashboard_event(&format!("Found curator-service at: {:?}", candidate));

                // Open stdout/stderr redirection file
                if let Ok(log_file) = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&stdout_log_path)
                {
                    let log_file_err = log_file.try_clone().unwrap_or_else(|_| {
                        fs::OpenOptions::new()
                            .append(true)
                            .open(&stdout_log_path)
                            .unwrap()
                    });

                    match Command::new(&candidate)
                        .arg("--data-dir")
                        .arg(data_dir)
                        .stdout(Stdio::from(log_file))
                        .stderr(Stdio::from(log_file_err))
                        .spawn()
                    {
                        Ok(child) => {
                            log_dashboard_event(&format!(
                                "Successfully spawned curator-service. Child PID: {}",
                                child.id()
                            ));
                        }
                        Err(e) => {
                            log_dashboard_event(&format!(
                                "Failed to spawn curator-service Command: {:?}",
                                e
                            ));
                        }
                    }
                } else {
                    log_dashboard_event("Failed to open service_stdout.log for redirection");
                }
            } else {
                let err_msg = format!(
                    "CRITICAL ERROR: curator-service.exe not found at candidate paths under parent of {:?}",
                    dir
                );
                log_dashboard_event(&err_msg);
                panic!("{}", err_msg);
            }
        }
    } else {
        let err_msg = "CRITICAL ERROR: Failed to fetch current_exe path";
        log_dashboard_event(err_msg);
        panic!("{}", err_msg);
    }
}

use tokio::sync::Mutex;

fn get_grpc_channel() -> &'static Mutex<Option<Channel>> {
    static CHANNEL: OnceLock<Mutex<Option<Channel>>> = OnceLock::new();
    CHANNEL.get_or_init(|| Mutex::new(None))
}

/// Connects (and if needed spawns + waits for) the Curator Service, then returns
/// a cloned `Channel`. The global mutex is only held during connect, never across
/// the actual gRPC call, so concurrent IPC calls are no longer serialized.
async fn ensure_channel() -> Result<Channel, String> {
    let mutex = get_grpc_channel();
    let mut guard = mutex.lock().await;
    if guard.is_none() {
        match curator_core::ipc::grpc_helper::connect_ipc().await {
            Ok(channel) => {
                *guard = Some(channel);
            }
            Err(_) => {
                spawn_service();
                let start = std::time::Instant::now();
                let mut connected = false;
                while start.elapsed() < std::time::Duration::from_secs(3) {
                    if let Ok(channel) = curator_core::ipc::grpc_helper::connect_ipc().await {
                        *guard = Some(channel);
                        connected = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                if !connected {
                    return Err("Failed to establish connection to Curator Service".to_string());
                }
            }
        }
    }
    Ok(guard.clone().unwrap())
}



static THUMB_DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static THUMB_CACHE: OnceCell<Arc<ThumbnailCache>> = OnceCell::const_new();
static IMAGES_DB: OnceCell<SqlitePool> = OnceCell::const_new();

#[tauri::command]
async fn send_to_service_typed(method: String, request_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let channel = ensure_channel().await?;
    typed_bridge::call_typed(channel, &method, &request_bytes)
        .await
        .map_err(|e| {
            log_dashboard_event(&format!("send_to_service_typed {} failed: {}", method, e));
            e
        })
}

#[tauri::command]
async fn select_path(is_directory: bool) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new();
    if is_directory {
        let folder = dialog.pick_folder().await;
        Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
    } else {
        let file = dialog.pick_file().await;
        Ok(file.map(|f| f.path().to_string_lossy().to_string()))
    }
}

#[tauri::command]
async fn get_file_size(path: String) -> Result<Option<u64>, String> {
    let p = std::path::Path::new(&path);
    if p.is_file() {
        Ok(std::fs::metadata(p).map(|m| m.len()).ok())
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn save_file_dialog(suggested_name: String, filter_name: String, extensions: Vec<String>) -> Result<Option<String>, String> {
    let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&suggested_name)
        .add_filter(&filter_name, &ext_refs)
        .save_file()
        .await;
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

fn read_last_n_bytes(path: &std::path::Path, max_bytes: usize) -> std::io::Result<String> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let file_len = metadata.len() as usize;

    if file_len <= max_bytes {
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        return Ok(content);
    }

    let seek_pos = file_len - max_bytes;
    file.seek(SeekFrom::Start(seek_pos as u64))?;

    let mut buffer = vec![0; max_bytes];
    file.read_exact(&mut buffer)?;

    let lossy = String::from_utf8_lossy(&buffer).into_owned();
    if let Some(pos) = lossy.find('\n') {
        Ok(lossy[pos + 1..].to_string())
    } else {
        Ok(lossy)
    }
}

#[tauri::command]
async fn read_logs() -> Result<String, String> {
    let log_file = data_dir().join("dashboard.log");
    match read_last_n_bytes(&log_file, 128 * 1024) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read log file: {:?}", e)),
    }
}

#[tauri::command]
async fn read_service_logs() -> Result<String, String> {
    let log_file = data_dir().join("service_stdout.log");
    match read_last_n_bytes(&log_file, 128 * 1024) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read service log file: {:?}", e)),
    }
}

#[tauri::command]
async fn clear_logs() -> Result<(), String> {
    let log_file = data_dir().join("dashboard.log");
    fs::write(&log_file, "").map_err(|e| format!("Failed to clear logs: {:?}", e))
}

#[tauri::command]
async fn clear_service_logs() -> Result<(), String> {
    let log_file = data_dir().join("service_stdout.log");
    fs::write(&log_file, "").map_err(|e| format!("Failed to clear service logs: {:?}", e))
}

/// Reveal a file in Windows Explorer (selects the file inside its parent
/// folder). explorer.exe is resolved via the `WINDIR` environment variable.
fn reveal_in_explorer(path: &std::path::Path) -> Result<(), String> {
    let win_dir = std::env::var("WINDIR")
        .map_err(|_| "WINDIR environment variable is not set; cannot resolve explorer.exe".to_string())?;
    let explorer = std::path::Path::new(&win_dir).join("explorer.exe");
    // explorer.exe parses `/segment` as a command-line switch, so forward
    // slashes in the path would be consumed as unknown switches with no path
    // token left, causing Explorer to fall back to the user's Documents
    // folder. Convert to native backslashes before invoking.
    //
    // `/select,` and the path MUST be separate argv tokens (Command quotes the
    // path token on its own): a single "/select,<path>" argument puts the
    // switch inside the quotes, which Explorer also mis-handles the same way.
    let display = path.display().to_string().replace('/', "\\");
    Command::new(explorer)
        .arg("/select,")
        .arg(&display)
        .spawn()
        .map_err(|e| format!("Failed to open file location: {:?}", e))?;
    Ok(())
}

/// Open the location of the active log file (dashboard or service) in Explorer.
#[tauri::command]
async fn open_log_location(tab: String) -> Result<(), String> {
    let log_file = if tab == "service" {
        data_dir().join("service_stdout.log")
    } else {
        data_dir().join("dashboard.log")
    };
    if !log_file.exists() {
        return Err(format!("Log file not found: {}", log_file.display()));
    }
    reveal_in_explorer(&log_file)
}

/// Reveal a file path in Explorer with the file highlighted.
#[tauri::command]
async fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    reveal_in_explorer(p)
}

#[tauri::command]
fn log_frontend(message: String) {
    log_dashboard_event(&format!("[JS] {}", message));
}

#[tauri::command]
async fn open_file_externally(path: String) -> Result<(), String> {
    log_dashboard_event(&format!("open_file_externally called with path: {}", path));
    let p = std::path::Path::new(&path);
    if !p.exists() {
        let msg = format!("File not found: {}", path);
        log_dashboard_event(&msg);
        return Err(msg);
    }
    Command::new("cmd")
        .args(["/C", "start", "", &path])
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to open file: {:?}", e);
            log_dashboard_event(&msg);
            msg
        })?;
    log_dashboard_event(&format!("Successfully spawned open for: {}", path));
    Ok(())
}

#[tauri::command]
async fn read_image_bytes(path: String) -> Result<Vec<u8>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    std::fs::read(p).map_err(|e| format!("Failed to read file: {:?}", e))
}

#[tauri::command]
async fn get_thumbnail(image_id: i64) -> Result<Vec<u8>, String> {
    let cache = THUMB_CACHE.get_or_init(|| async {
        let db_path = THUMB_DB_PATH.get().expect("THUMB_DB_PATH not set");
        ThumbnailCache::open(db_path).await.expect("Failed to open thumbnail cache")
    }).await;

    // Cache miss — generate locally (after fetching mtime so the cache key is accurate)
    let db = IMAGES_DB.get_or_init(|| async {
        let db_path = THUMB_DB_PATH.get().expect("THUMB_DB_PATH not set");
        let images_db_path = db_path.parent().unwrap().join("curator.db");
        let opts = SqliteConnectOptions::new()
            .filename(&images_db_path)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .create_if_missing(false);
        SqlitePool::connect_with(opts).await.expect("Failed to open images DB")
    }).await;

    let row: Option<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT current_filepath, mtime, video_frame_path FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    let (filepath, mtime, video_frame_path) = row.ok_or("Image not found")?;

    // Cache is keyed on (image_id, width, mtime, kind) to avoid stale thumbnails
    // when a file is replaced, wrong-size blobs across width changes, and stale
    // static single-frame thumbs for videos (which now render animated WebP).
    let is_vid = curator_core::video::is_video(std::path::Path::new(&filepath));
    let kind = if is_vid {
        curator_core::thumbnail::THUMB_KIND_ANIMATED
    } else {
        curator_core::thumbnail::THUMB_KIND_STATIC
    };
    if let Some(data) = cache.get(image_id, 200, mtime, kind).await {
        return Ok(data);
    }

    // For videos, generate a lightweight 2-second animated WebP preview thumbnail
    // via FFmpeg. Fall back to static thumbnail of extracted first-frame PNG if FFmpeg fails.
    let webp_bytes = if is_vid {
        let data_dir = data_dir();
        let ffmpeg_res = curator_core::video::resolve_ffmpeg_path(&data_dir, None);
        let vid_path = std::path::PathBuf::from(&filepath);
        tokio::task::spawn_blocking(move || {
            if let Ok(ffmpeg) = ffmpeg_res {
                if let Ok(animated) = curator_core::thumbnail::generate_video_preview(&vid_path, &ffmpeg, 200, 12, 65) {
                    return Ok(animated);
                }
            }
            // Fallback to static thumbnail of first frame if preview generation fails
            let thumb_src = match video_frame_path {
                Some(ref frame) if std::path::Path::new(frame).exists() => std::path::PathBuf::from(frame),
                _ => std::path::PathBuf::from(&filepath),
            };
            curator_core::thumbnail::generate_thumbnail(&thumb_src, 200)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    } else {
        let thumb_src = std::path::PathBuf::from(&filepath);
        tokio::task::spawn_blocking(move || curator_core::thumbnail::generate_thumbnail(&thumb_src, 200))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    };

    let _ = cache.put(image_id, 200, mtime, kind, &webp_bytes).await;
    Ok(webp_bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            let data_dir = data_dir();
            let _ = fs::create_dir_all(data_dir);
            let log_file = data_dir.join("dashboard.log");
            let stdout_log = data_dir.join("service_stdout.log");
            let _ = fs::write(&log_file, "");
            let _ = fs::write(&stdout_log, "");
            log_dashboard_event("Dashboard started. Cleaned log files.");

            let _ = THUMB_DB_PATH.set(data_dir.join("thumbnail-cache.db"));

            // Eagerly pre-establish the gRPC connection in a background task
            // so the first IPC call from the frontend is instant.
            let app_handle = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log_dashboard_event("Pre-connect: Initializing service connection...");
                match ensure_channel().await {
                    Ok(_) => log_dashboard_event("Pre-connect: gRPC channel ready."),
                    Err(e) => log_dashboard_event(&format!("Pre-connect failed: {e}")),
                }

                // Emit a Tauri event so the frontend knows the connection is ready
                let _ = app_handle.emit("service-ready", ());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_to_service_typed,
            select_path,
            save_file_dialog,
            get_file_size,
            read_logs,
            read_service_logs,
            clear_logs,
            clear_service_logs,
            open_log_location,
            reveal_in_folder,
            log_frontend,
            open_file_externally,
            read_image_bytes,
            get_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
