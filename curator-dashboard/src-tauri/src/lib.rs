use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::OnceCell;

use curator_core::thumbnail::ThumbnailCache;

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
                log_dashboard_event(&format!(
                    "curator-service.exe not found at candidate paths under parent of {:?}",
                    dir
                ));
            }
        }
    } else {
        log_dashboard_event("Failed to fetch current_exe path");
    }
}

use tokio::sync::Mutex;

fn get_pipe_connection() -> &'static Mutex<Option<NamedPipeClient>> {
    static CONN: OnceLock<Mutex<Option<NamedPipeClient>>> = OnceLock::new();
    CONN.get_or_init(|| Mutex::new(None))
}

fn get_cached_token() -> &'static Mutex<Option<String>> {
    static TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(None))
}

static THUMB_DB_PATH: OnceLock<PathBuf> = OnceLock::new();
static THUMB_CACHE: OnceCell<Arc<ThumbnailCache>> = OnceCell::const_new();

/// Returns true when `s` appears to contain a complete JSON value
/// (balanced braces/brackets), accounting for strings and escapes.
fn is_json_complete(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    // Simple string "..." or bare number/bool/null
    let first = s.chars().next().unwrap();
    if first != '{' && first != '[' {
        // Strings, numbers, true/false/null — complete if non-empty
        return true;
    }
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escape = false;
    for c in s.chars() {
        if escape {
            escape = false;
            continue;
        }
        if c == '\\' && in_string {
            escape = true;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match c {
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

async fn get_or_obtain_token() -> Result<String, String> {
    {
        let cached = get_cached_token().lock().await;
        if let Some(ref t) = *cached {
            return Ok(t.clone());
        }
    }

    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let key_file = data_dir.join("service.key");

    if !key_file.exists() {
        log_dashboard_event("service.key missing, spawning service...");
        spawn_service();
    }

    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(3) {
        if key_file.exists() {
            if let Ok(t) = fs::read_to_string(&key_file) {
                let token = t.trim().to_string();
                if !token.is_empty() {
                    let mut cached = get_cached_token().lock().await;
                    *cached = Some(token.clone());
                    return Ok(token);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    log_dashboard_event("Retrying spawn_service after key file timeout...");
    spawn_service();
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(2) {
        if key_file.exists() {
            if let Ok(t) = fs::read_to_string(&key_file) {
                let token = t.trim().to_string();
                if !token.is_empty() {
                    let mut cached = get_cached_token().lock().await;
                    *cached = Some(token.clone());
                    return Ok(token);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    Err("Failed to read service key file within timeout".to_string())
}

async fn ensure_connected(pipe_name: &str, token: &str) -> Result<NamedPipeClient, String> {
    if let Ok(client) = connect_and_authenticate(pipe_name, token).await {
        return Ok(client);
    }

    spawn_service();

    {
        let mut cached = get_cached_token().lock().await;
        *cached = None;
    }

    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(3) {
        if let Ok(fresh_token) = get_or_obtain_token().await {
            if let Ok(client) = connect_and_authenticate(pipe_name, &fresh_token).await {
                log_dashboard_event("Fast pipe connection established successfully.");
                return Ok(client);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    Err("Failed to establish named pipe connection to service".to_string())
}

#[tauri::command]
async fn send_to_service(request_json: String) -> Result<String, String> {
    log_dashboard_event(&format!("send_to_service: {}", request_json));
    let pipe_name = r"\\.\pipe\curator_ipc";

    let conn_mutex = get_pipe_connection();
    let mut conn_guard = conn_mutex.lock().await;

    if conn_guard.is_none() {
        let token = get_or_obtain_token().await?;
        let client = ensure_connected(pipe_name, &token).await?;
        *conn_guard = Some(client);
    }

    let send_result = {
        let client = conn_guard.as_mut().unwrap();
        send_request_json(client, &request_json).await
    };

    match send_result {
        Ok(response) => {
            log_dashboard_event(&format!(
                "Successfully received response from service ({} bytes).",
                response.len()
            ));
            Ok(response)
        }
        Err(e) => {
            log_dashboard_event(&format!(
                "Request on persistent connection failed ({}). Reconnecting...",
                e
            ));
            *conn_guard = None;

            let token = get_or_obtain_token().await?;
            let client = ensure_connected(pipe_name, &token).await?;
            *conn_guard = Some(client);

            let response = send_request_json(conn_guard.as_mut().unwrap(), &request_json)
                .await
                .map_err(|e2| {
                    let err_msg = format!("Retry also failed: {}", e2);
                    log_dashboard_event(&err_msg);
                    err_msg
                })?;
            log_dashboard_event(&format!(
                "Successfully received response from service ({} bytes).",
                response.len()
            ));
            Ok(response)
        }
    }
}

async fn connect_and_authenticate(pipe_name: &str, token: &str) -> Result<NamedPipeClient, String> {
    let mut client = ClientOptions::new().open(pipe_name).map_err(|e| {
        format!("Named Pipe open failed: {:?}", e)
    })?;

    client.write_all(token.as_bytes()).await.map_err(|e| {
        format!("Handshake write failed: {:?}", e)
    })?;

    let mut auth_buffer = vec![0; 32];
    let n = client.read(&mut auth_buffer).await.map_err(|e| {
        format!("Handshake read failed: {:?}", e)
    })?;

    let auth_status = String::from_utf8_lossy(&auth_buffer[..n]);
    if auth_status != "AUTH_OK" {
        return Err(format!("Authentication failed: {}", auth_status));
    }

    Ok(client)
}

async fn send_request_json(
    client: &mut NamedPipeClient,
    request_json: &str,
) -> Result<String, String> {
    client
        .write_all(request_json.as_bytes())
        .await
        .map_err(|e| format!("Request send failed: {}", e))?;

    let mut accumulated = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = client
            .read(&mut chunk)
            .await
            .map_err(|e| format!("Response read failed: {}", e))?;
        if n == 0 {
            if accumulated.is_empty() {
                return Err("Connection closed by service before response".to_string());
            }
            break;
        }
        accumulated.extend_from_slice(&chunk[..n]);

        if let Ok(s) = std::str::from_utf8(&accumulated) {
            let s = s.trim();
            if !s.is_empty() && is_json_complete(s) {
                break;
            }
        }
    }

    Ok(String::from_utf8_lossy(&accumulated).to_string())
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
async fn read_logs() -> Result<String, String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("dashboard.log");
    match fs::read_to_string(&log_file) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read log file: {:?}", e)),
    }
}

#[tauri::command]
async fn read_service_logs() -> Result<String, String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let log_file = data_dir.join("service_stdout.log");
    match fs::read_to_string(&log_file) {
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

    match cache.get(image_id).await {
        Some(data) => Ok(data),
        None => Err("Thumbnail not found".to_string()),
    }
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

            // Eagerly pre-establish the pipe connection in a background task
            // so the first IPC call from the frontend is instant.
            let app_handle = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let pipe_name = r"\\.\pipe\curator_ipc";
                log_dashboard_event("Pre-connect: Initializing service connection...");
                match get_or_obtain_token().await {
                    Ok(token) => match ensure_connected(pipe_name, &token).await {
                        Ok(client) => {
                            let conn_mutex = get_pipe_connection();
                            let mut conn_guard = conn_mutex.lock().await;
                            *conn_guard = Some(client);
                            log_dashboard_event("Pre-connect: Pipe connection ready.");
                        }
                        Err(e) => {
                            log_dashboard_event(&format!("Pre-connect pipe failed: {}", e));
                        }
                    },
                    Err(e) => {
                        log_dashboard_event(&format!("Pre-connect token failed: {}", e));
                    }
                }

                // Warm up: fire a Ping to verify the connection works
                let ping_json = serde_json::to_string(&"Ping").unwrap_or_default();
                let conn_mutex = get_pipe_connection();
                let mut conn_guard = conn_mutex.lock().await;
                if let Some(ref mut client) = *conn_guard {
                    match send_request_json(client, &ping_json).await {
                        Ok(_) => log_dashboard_event("Pre-connect: Ping OK, connection warm."),
                        Err(e) => {
                            log_dashboard_event(&format!(
                                "Pre-connect Ping failed ({}), dropping connection.",
                                e
                            ));
                            *conn_guard = None;
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
