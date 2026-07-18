use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

// We will default to the standard curator data path
const DEFAULT_DATA_DIR: &str = r".curator";

fn log_dashboard_event(msg: &str) {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let _ = fs::create_dir_all(&data_dir);
    let log_file = data_dir.join("dashboard.log");
    
    if let Ok(mut file) = fs::OpenOptions::new().create(true).write(true).append(true).open(log_file) {
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
                    .write(true)
                    .append(true)
                    .open(&stdout_log_path)
                {
                    let log_file_err = log_file.try_clone().unwrap_or_else(|_| {
                        fs::OpenOptions::new()
                            .write(true)
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
                            log_dashboard_event(&format!("Successfully spawned curator-service. Child PID: {}", child.id()));
                        }
                        Err(e) => {
                            log_dashboard_event(&format!("Failed to spawn curator-service Command: {:?}", e));
                        }
                    }
                } else {
                    log_dashboard_event("Failed to open service_stdout.log for redirection");
                }
            } else {
                log_dashboard_event(&format!("curator-service.exe not found at candidate paths under parent of {:?}", dir));
            }
        }
    } else {
        log_dashboard_event("Failed to fetch current_exe path");
    }
}

use std::sync::OnceLock;
use tokio::sync::Mutex;

fn get_spawn_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
async fn send_to_service(request_json: String) -> Result<String, String> {
    let data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    
    // Acquire spawn lock to prevent concurrent spawns/connection races
    let _guard = get_spawn_lock().lock().await;

    // 1. Read Service Key
    let key_file = data_dir.join("service.key");
    
    log_dashboard_event(&format!("send_to_service called with: {}", request_json));

    // If key file doesn't exist, we try to spawn the service first to generate it
    if !key_file.exists() {
        log_dashboard_event("service.key does not exist, triggering spawn_service...");
        spawn_service();
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    }
    
    let token = match fs::read_to_string(&key_file) {
        Ok(t) => t.trim().to_string(),
        Err(e) => {
            log_dashboard_event(&format!("Failed to read service.key on first pass: {:?}", e));
            // Try spawning and reading one more time
            spawn_service();
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            fs::read_to_string(&key_file)
                .map_err(|err| {
                    let err_msg = format!("Failed to read service key file: {:?}", err);
                    log_dashboard_event(&err_msg);
                    err_msg
                })?
                .trim()
                .to_string()
        }
    };

    // 2. Connect to Named Pipe (with auto-spawning retry)
    let pipe_name = r"\\.\pipe\curator_ipc";
    let mut client = match ClientOptions::new().open(pipe_name) {
        Ok(c) => c,
        Err(e) => {
            log_dashboard_event(&format!("Named Pipe connection failed on first pass: {:?}. Spawning service...", e));
            // Spawn the service and retry
            spawn_service();
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            ClientOptions::new().open(pipe_name)
                .map_err(|err| {
                    let err_msg = format!("Failed to connect to Named Pipe after spawning service: {:?}", err);
                    log_dashboard_event(&err_msg);
                    err_msg
                })?
        }
    };

    // 3. Handshake
    log_dashboard_event("Sending token handshake to service...");
    client.write_all(token.as_bytes()).await
        .map_err(|e| {
            let err_msg = format!("Handshake write failed: {:?}", e);
            log_dashboard_event(&err_msg);
            err_msg
        })?;

    let mut auth_buffer = vec![0; 32];
    let n = client.read(&mut auth_buffer).await
        .map_err(|e| {
            let err_msg = format!("Handshake read failed: {:?}", e);
            log_dashboard_event(&err_msg);
            err_msg
        })?;
        
    let auth_status = String::from_utf8_lossy(&auth_buffer[..n]);
    if auth_status != "AUTH_OK" {
        let err_msg = format!("Authentication failed: {}", auth_status);
        log_dashboard_event(&err_msg);
        return Err(err_msg);
    }

    log_dashboard_event("Authentication handshake succeeded. Sending request JSON...");

    // 4. Send request JSON
    client.write_all(request_json.as_bytes()).await
        .map_err(|e| {
            let err_msg = format!("Request send failed: {:?}", e);
            log_dashboard_event(&err_msg);
            err_msg
        })?;

    // 5. Read response JSON
    let mut response_buffer = vec![0; 131072]; // 128KB buffer for large lists
    let n = client.read(&mut response_buffer).await
        .map_err(|e| {
            let err_msg = format!("Response read failed: {:?}", e);
            log_dashboard_event(&err_msg);
            err_msg
        })?;

    let response_str = String::from_utf8_lossy(&response_buffer[..n]).to_string();
    log_dashboard_event("Successfully received response from service.");
    Ok(response_str)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![send_to_service, select_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
