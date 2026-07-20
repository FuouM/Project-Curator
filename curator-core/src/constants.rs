/// Source name constants used across the workspace.
pub const SOURCE_CLIP: &str = "ai:clip-vit-b-32";
pub const SOURCE_CAMIE: &str = "ai:camie-tagger-v2";
pub const SOURCE_USER: &str = "user";

/// Named pipe path for IPC communication between service, CLI, and dashboard.
pub const PIPE_NAME: &str = r"\\.\pipe\curator_ipc";

/// Default data directory for the curator service.
pub const DEFAULT_DATA_DIR: &str = r".curator";
