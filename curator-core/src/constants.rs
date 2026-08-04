/// Source name constants used across the workspace.
pub const SOURCE_CLIP: &str = "ai:clip-vit-b-32";
pub const SOURCE_CAMIE: &str = "ai:camie-tagger-v2";
pub const SOURCE_WD_EVA02: &str = "ai:wd-eva02-tagger-2026-canary";
pub const SOURCE_CUSTOM_CONCEPTS: &str = "ai:custom-concepts";
pub const SOURCE_USER: &str = "user";

/// Named pipe path for IPC communication between service, CLI, and dashboard.
pub const PIPE_NAME: &str = r"\\.\pipe\curator_ipc";

/// Resolve the curator data directory portably, without any hardcoded paths.
///
/// Resolution order:
/// 1. `CURATOR_DATA_DIR` environment variable (explicit override).
/// 2. Walk up from the current executable's directory looking for `.curator/`
///    adjacent to a `Cargo.toml` or `.git` marker (workspace root detection).
/// 3. Walk up from the current working directory with the same marker check.
///
/// Panics if no suitable location is found, so callers get a clear error
/// rather than silently using a wrong path.
pub fn resolve_data_dir() -> std::path::PathBuf {
    use std::path::PathBuf;

    // 1. Explicit environment variable override.
    if let Ok(env_val) = std::env::var("CURATOR_DATA_DIR") {
        if !env_val.is_empty() {
            return PathBuf::from(env_val);
        }
    }

    // 2. Walk up from the current executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = find_workspace_root(exe.as_path()) {
            return root.join(".curator");
        }
    }

    // 3. Walk up from the current working directory.
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_workspace_root(cwd.as_path()) {
            return root.join(".curator");
        }
    }

    panic!(
        "Could not locate the Project Curator workspace root. \
         Set the CURATOR_DATA_DIR environment variable to the `.curator` data directory path."
    );
}

/// Walk up from `start` (a file or directory) looking for a directory that
/// contains `Cargo.toml` or `.git`. Returns that directory when found.
fn find_workspace_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut current = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        if current.join("Cargo.toml").exists() || current.join(".git").exists() {
            return Some(current);
        }
        match current.parent() {
            Some(p) => current = p.to_path_buf(),
            None => return None,
        }
    }
}
