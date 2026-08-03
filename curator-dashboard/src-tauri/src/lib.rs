use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tokio::sync::OnceCell;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use curator_core::grpc::curator_client::CuratorClient;
use tonic::transport::Channel;

use curator_core::thumbnail::{ThumbnailCache, generate_thumbnail};

// We will default to the standard curator data path
const DEFAULT_DATA_DIR: &str = r".curator";

fn log_dashboard_event(msg: &str) {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let _ = fs::create_dir_all(&data_dir);
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
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let _ = fs::create_dir_all(&data_dir);
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
                        .arg(DEFAULT_DATA_DIR)
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

fn get_grpc_client() -> &'static Mutex<Option<CuratorClient<Channel>>> {
    static CLIENT: OnceLock<Mutex<Option<CuratorClient<Channel>>>> = OnceLock::new();
    CLIENT.get_or_init(|| Mutex::new(None))
}


static THUMB_DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static THUMB_CACHE: OnceCell<Arc<ThumbnailCache>> = OnceCell::const_new();
static IMAGES_DB: OnceCell<SqlitePool> = OnceCell::const_new();



async fn pipe_request(request_json: &str) -> Result<String, String> {
    let client_mutex = get_grpc_client();
    let mut client = {
        let mut guard = client_mutex.lock().await;
        ensure_client(&mut guard).await?
    };

    let grpc_req = curator_core::grpc::CuratorRequest {
        request_json: request_json.to_string(),
    };

    match client.call(grpc_req).await {
        Ok(grpc_resp) => Ok(grpc_resp.into_inner().response_json),
        Err(e) => {
            log_dashboard_event(&format!("gRPC call failed, attempting reconnect: {:?}", e));
            let mut client = {
                let mut guard = client_mutex.lock().await;
                *guard = None;
                ensure_client(&mut guard).await?
            };
            let grpc_req = curator_core::grpc::CuratorRequest {
                request_json: request_json.to_string(),
            };
            client
                .call(grpc_req)
                .await
                .map(|resp| resp.into_inner().response_json)
                .map_err(|e2| format!("Retry also failed: {:?}", e2))
        }
    }
}

/// Connects (and if needed spawns + waits for) the Curator Service, then returns
/// a cloned client. The global mutex is only held during connect, never across
/// the actual gRPC call, so concurrent IPC calls are no longer serialized.
async fn ensure_client(
    guard: &mut Option<CuratorClient<Channel>>,
) -> Result<CuratorClient<Channel>, String> {
    if guard.is_none() {
        match curator_core::ipc::grpc_helper::connect_ipc().await {
            Ok(channel) => {
                *guard = Some(CuratorClient::new(channel));
            }
            Err(_) => {
                spawn_service();
                let start = std::time::Instant::now();
                let mut connected = false;
                while start.elapsed() < std::time::Duration::from_secs(3) {
                    if let Ok(channel) = curator_core::ipc::grpc_helper::connect_ipc().await {
                        *guard = Some(CuratorClient::new(channel));
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

#[tauri::command]
async fn send_to_service(request_json: String) -> Result<String, String> {
    log_dashboard_event(&format!("send_to_service: {}", request_json));
    pipe_request(&request_json).await
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
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("dashboard.log");
    match read_last_n_bytes(&log_file, 128 * 1024) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read log file: {:?}", e)),
    }
}

#[tauri::command]
async fn read_service_logs() -> Result<String, String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("service_stdout.log");
    match read_last_n_bytes(&log_file, 128 * 1024) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read service log file: {:?}", e)),
    }
}

#[tauri::command]
async fn clear_logs() -> Result<(), String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("dashboard.log");
    fs::write(&log_file, "").map_err(|e| format!("Failed to clear logs: {:?}", e))
}

#[tauri::command]
async fn clear_service_logs() -> Result<(), String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("service_stdout.log");
    fs::write(&log_file, "").map_err(|e| format!("Failed to clear service logs: {:?}", e))
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

    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT current_filepath, mtime FROM images WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(image_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    let (filepath, mtime) = row.ok_or("Image not found")?;

    // Cache is keyed on (image_id, width, mtime) to avoid stale thumbnails
    // when a file is replaced and wrong-size blobs across width changes.
    if let Some(data) = cache.get(image_id, 200, mtime).await {
        return Ok(data);
    }

    let thumb_path: std::path::PathBuf = filepath.into();

    let webp_bytes = tokio::task::spawn_blocking(move || generate_thumbnail(&thumb_path, 200))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let _ = cache.put(image_id, 200, mtime, &webp_bytes).await;
    Ok(webp_bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
            let _ = fs::create_dir_all(&data_dir);
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
                let client_mutex = get_grpc_client();
                let mut guard = client_mutex.lock().await;

                if guard.is_none() {
                    match curator_core::ipc::grpc_helper::connect_ipc().await {
                        Ok(channel) => {
                            *guard = Some(CuratorClient::new(channel));
                            log_dashboard_event("Pre-connect: gRPC channel ready.");
                        }
                        Err(e) => {
                            log_dashboard_event(&format!("Pre-connect: Initial connect failed: {:?}", e));
                            spawn_service();
                            let start = std::time::Instant::now();
                            while start.elapsed() < std::time::Duration::from_secs(3) {
                                if let Ok(channel) = curator_core::ipc::grpc_helper::connect_ipc().await {
                                    *guard = Some(CuratorClient::new(channel));
                                    log_dashboard_event("Pre-connect: gRPC channel ready after spawning.");
                                    break;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            }
                        }
                    }
                }

                if let Some(ref mut client) = *guard {
                    let grpc_req = curator_core::grpc::CuratorRequest {
                        request_json: serde_json::to_string(&curator_core::ipc::Request::Ping).unwrap_or_default(),
                    };
                    match client.call(grpc_req).await {
                        Ok(_) => log_dashboard_event("Pre-connect: Ping OK, connection warm."),
                        Err(e) => {
                            log_dashboard_event(&format!("Pre-connect Ping failed: {:?}", e));
                            *guard = None;
                        }
                    }
                }

                // Emit a Tauri event so the frontend knows the connection is ready
                let _ = app_handle.emit("service-ready", ());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_to_service,
            select_path,
            read_logs,
            read_service_logs,
            clear_logs,
            clear_service_logs,
            log_frontend,
            open_file_externally,
            read_image_bytes,
            get_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
