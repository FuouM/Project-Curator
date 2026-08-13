use anyhow::Context;
use anyhow::Result;
use curator_core::ipc::PluginInfo;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::info;

use crate::AppSettings;

/// Resolve the workspace-root `plugins/` directory portably as
/// `data_dir.parent().join("plugins")`. Under the default resolution
/// (`data_dir` = `<workspace_root>/.curator`) the parent is the workspace root
/// that holds `curator-core/`, `curator-service/`, and the git-tracked
/// `plugins/`. Fails fast (no silent fallback) when `data_dir` has no parent,
/// e.g. a bare drive root.
pub(crate) fn plugin_root(data_dir: &Path) -> anyhow::Result<PathBuf> {
    let parent = data_dir.parent().context(format!(
        "data_dir {:?} has no parent; cannot resolve workspace-root plugins/ directory",
        data_dir
    ))?;
    Ok(parent.join("plugins"))
}

/// A plugin folder name must be a single path segment — no separators, no
/// `.`/`..`. Guards path traversal in the `plugins/` tree.
fn validate_plugin_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn parse_manifest(path: &Path, fallback_name: &str) -> PluginInfo {
    let manifest_path = path.to_string_lossy().into_owned();
    let empty = PluginInfo {
        name: fallback_name.to_string(),
        version: String::new(),
        description: String::new(),
        permissions: Vec::new(),
        ui: None,
        hooks: Vec::new(),
        loaded: false,
        enabled: true,
        manifest_path: manifest_path.clone(),
    };

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return empty,
    };
    let val: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return empty,
    };

    let get_str = |key: &str| {
        val.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let get_str_array = |key: &str| {
        val.get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    };

    let ui = val
        .get("components")
        .and_then(|c| c.get("ui"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    PluginInfo {
        name: get_str("name"),
        version: get_str("version"),
        description: get_str("description"),
        permissions: get_str_array("permissions"),
        ui,
        hooks: get_str_array("hooks"),
        loaded: true,
        enabled: true,
        manifest_path,
    }
}

pub async fn list_plugins(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> Result<Vec<PluginInfo>> {
    let root = plugin_root(data_dir)?;

    let enabled_map = { settings.lock().await.enabled_plugins.clone() };
    let mut plugins = Vec::new();

    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            // A directory is only a plugin candidate if it declares a
            // manifest.json. Stray support/utility directories (e.g. a shared
            // `lib/` or a `node_modules/` tree) have no manifest and are not
            // plugins — skip them instead of surfacing invalid entries in the
            // Plugins hub.
            if !dir.join("manifest.json").is_file() {
                continue;
            }
            let name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if !validate_plugin_name(&name) {
                continue;
            }
            let mut info = parse_manifest(&dir.join("manifest.json"), &name);
            info.enabled = enabled_map.get(&name).copied().unwrap_or(true);
            plugins.push(info);
        }
    }

    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(plugins)
}

/// Resolve the plugin's runtime output directory (`plugins/<name>/<output_dir>`),
/// as declared in the plugin's `install.json`. Returns `None` when the plugin has
/// no runtime-install spec (i.e. it ships a pure JS bundle, like `example-plugin`).
pub fn plugin_runtime_dir(data_dir: &Path, plugin_name: &str) -> Result<Option<PathBuf>> {
    if !validate_plugin_name(plugin_name) {
        anyhow::bail!("Invalid plugin name: {}", plugin_name);
    }
    let root = plugin_root(data_dir)?;
    let spec_path = root.join(plugin_name).join("install.json");
    if !spec_path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&spec_path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;
    let output_dir = val
        .get("output_dir")
        .and_then(|v| v.as_str())
        .unwrap_or("runtime");
    Ok(Some(root.join(plugin_name).join(output_dir)))
}

/// True when the plugin's extracted runtime entrypoint exists on disk.
pub fn plugin_runtime_index_exists(data_dir: &Path, plugin_name: &str) -> Result<bool> {
    Ok(match plugin_runtime_dir(data_dir, plugin_name)? {
        Some(dir) => dir.join("index.html").is_file(),
        None => false,
    })
}

/// True when the plugin ships an `install.json` runtime-install spec.
pub fn plugin_runtime_spec_exists(data_dir: &Path, plugin_name: &str) -> Result<bool> {
    if !validate_plugin_name(plugin_name) {
        anyhow::bail!("Invalid plugin name: {}", plugin_name);
    }
    Ok(plugin_root(data_dir)?
        .join(plugin_name)
        .join("install.json")
        .is_file())
}

pub async fn set_plugin_enabled(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
    plugin_name: &str,
    enabled: bool,
) -> Result<()> {
    if !validate_plugin_name(plugin_name) {
        anyhow::bail!("Invalid plugin name: {}", plugin_name);
    }
    let root = plugin_root(data_dir)?;
    if !root.join(plugin_name).join("manifest.json").is_file() {
        anyhow::bail!("Unknown plugin: {}", plugin_name);
    }

    let mut s = settings.lock().await;
    s.enabled_plugins.insert(plugin_name.to_string(), enabled);
    let settings_to_save = s.clone();
    let data_dir_buf = data_dir.to_path_buf();
    drop(s);

    let save_res = tokio::task::spawn_blocking(move || crate::save_settings(&data_dir_buf, &settings_to_save))
        .await;
    match save_res {
        Ok(Ok(())) => {
            info!("Plugin enabled state persisted: {} -> {}", plugin_name, enabled);
            Ok(())
        }
        Ok(Err(e)) => anyhow::bail!("Failed to save settings: {:?}", e),
        Err(e) => anyhow::bail!("Failed to save settings: {:?}", e),
    }
}

pub async fn read_plugin_file(data_dir: &Path, plugin_name: &str, relative_path: &str) -> Result<String> {
    if !validate_plugin_name(plugin_name) {
        anyhow::bail!("Invalid plugin name: {}", plugin_name);
    }

    // Reject traversal / absolute components before touching the filesystem.
    let rel = Path::new(relative_path);
    let has_traversal = rel.is_absolute()
        || relative_path.is_empty()
        || relative_path.split('/').any(|p| p == "..")
        || relative_path.split('\\').any(|p| p == "..");

    if has_traversal {
        anyhow::bail!("relative_path must be a relative path inside the plugin folder");
    }

    let root = plugin_root(data_dir)?;
    let plugin_dir = root.join(plugin_name);

    // Canonicalize the plugin root and confirm the resolved file stays inside it
    // (path-traversal guard against symlinks / case tricks).
    let canonical_root = plugin_dir
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("Plugin folder not found: {}", plugin_name))?;
    let file_path = plugin_dir.join(rel);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("Failed to resolve plugin file: {:?}", e))?;
    if !canonical_file.starts_with(&canonical_root) {
        anyhow::bail!("Requested path escapes the plugin folder");
    }

    fs::read_to_string(&canonical_file)
        .map_err(|e| anyhow::anyhow!("Failed to read plugin file: {:?}", e))
}

/// Validates a plugin `manifest.json` against the design doc Section 4 schema
/// (D1). Returns `(name, version)` on success, or a descriptive error.
///
/// Checks (fail fast, no silent fallbacks):
/// - File exists and parses as JSON.
/// - `name` (required): non-empty string, lowercase letters/digits/hyphens.
/// - `version` (required): non-empty string.
/// - `description` (required): string.
/// - `permissions` (required): array of strings; `ui:inject` requires a
///   `components.ui` entrypoint.
/// - `components.type` (if present): one of `"javascript"` or `"python"`.
/// - `hooks` (if present): array of strings.
pub async fn validate_plugin_logic(manifest_path_str: &str) -> Result<(String, String)> {
    let path = Path::new(manifest_path_str);
    if !path.is_file() {
        return Err(anyhow::anyhow!(
            "manifest.json path does not exist or is not a file"
        ));
    }

    let content = fs::read_to_string(path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;

    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .context("Missing or empty 'name' field")?
        .to_string();

    if !is_valid_plugin_name(&name) {
        return Err(anyhow::anyhow!(
            "'name' must be lowercase letters, digits, and hyphens only: {}",
            name
        ));
    }

    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .context("Missing or empty 'version' field")?
        .to_string();

    let _description = val
        .get("description")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .context("Missing or empty 'description' field")?;

    let permissions = match val.get("permissions") {
        Some(p) if p.is_array() => p
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str())
            .collect::<Option<Vec<&str>>>()
            .context("'permissions' must be an array of strings")?,
        Some(_) => return Err(anyhow::anyhow!("'permissions' must be an array of strings")),
        None => return Err(anyhow::anyhow!("Missing 'permissions' array")),
    };

    if let Some(component_type) = val.pointer("/components/type").and_then(|v| v.as_str()) {
        if component_type != "javascript" && component_type != "python" {
            return Err(anyhow::anyhow!(
                "'components.type' must be \"javascript\" or \"python\", got: {}",
                component_type
            ));
        }
    }

    if permissions.contains(&"ui:inject") {
        match val.pointer("/components/ui").and_then(|v| v.as_str()) {
            Some(ui) if !ui.is_empty() => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "Permission 'ui:inject' requires a 'components.ui' entrypoint"
                ))
            }
        }
    }

    if let Some(hooks) = val.get("hooks") {
        if !hooks.is_array() || !hooks.as_array().unwrap().iter().all(|h| h.is_string()) {
            return Err(anyhow::anyhow!("'hooks' must be an array of strings"));
        }
    }

    // Validate the manifest name matches its folder name (design doc 4.2).
    if let Some(folder) = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str())
    {
        if folder != name {
            return Err(anyhow::anyhow!(
                "Manifest 'name' ({}) does not match plugin folder name ({})",
                name,
                folder
            ));
        }
    }

    Ok((name, version))
}

fn is_valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
