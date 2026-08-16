/// Source name constants used across the workspace.
pub const SOURCE_CLIP: &str = "ai:clip-vit-b-32";
pub const SOURCE_MOBILECLIP: &str = "ai:mobileclip-s2";
pub const SOURCE_CAMIE: &str = "ai:camie-tagger-v2";
pub const SOURCE_WD_EVA02: &str = "ai:wd-eva02-tagger-2026-canary";
pub const SOURCE_USER: &str = "user";


/// Named pipe path for IPC communication between service, CLI, and dashboard.
pub const PIPE_NAME: &str = r"\\.\pipe\curator_ipc";

/// Resolve the curator data directory portably and deterministically based on
/// self-contained project assets, with no reliance on environment variables,
/// `.git`, or `Cargo.toml`.
///
/// Resolution order:
/// 1. Check if the current executable's folder (or its ancestors during dev)
///    contains Curator domain markers (`model_manifest.json` or `plugins/`).
/// 2. Check if the current working directory or its ancestors contain the markers.
/// 3. Fallback: adjacent `.curator` folder next to the current executable.
pub fn resolve_data_dir() -> std::path::PathBuf {
    // 1. Walk up from the current executable.
    let exe_path = std::env::current_exe().ok();
    if let Some(ref exe) = exe_path {
        if let Some(root) = find_app_root(exe.as_path()) {
            return root.join(".curator");
        }
    }

    // 2. Walk up from the current working directory.
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_app_root(cwd.as_path()) {
            return root.join(".curator");
        }
    }

    // 3. Fallback: directly adjacent to the running executable.
    if let Some(ref exe) = exe_path {
        if let Some(parent) = exe.parent() {
            return parent.join(".curator");
        }
    }

    std::path::PathBuf::from(".curator")
}

/// Checks if a directory is the Project Curator application/workspace root
/// by inspecting Curator-specific assets rather than generic VCS/build files.
fn is_app_root(dir: &std::path::Path) -> bool {
    // `model_manifest.json` is the authoritative Project Curator model manifest
    if dir.join("model_manifest.json").is_file() {
        return true;
    }
    // Alternatively, a folder containing both `plugins` and `.curator`
    if dir.join("plugins").is_dir() && dir.join(".curator").is_dir() {
        return true;
    }
    false
}

/// Walk up from `start` (a file or directory) looking for the Project Curator
/// root directory.
fn find_app_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut current = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    if is_app_root(&current) {
        return Some(current);
    }

    while let Some(parent) = current.parent() {
        if is_app_root(parent) {
            return Some(parent.to_path_buf());
        }
        current = parent.to_path_buf();
    }

    None
}
