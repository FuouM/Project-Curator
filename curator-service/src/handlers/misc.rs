use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

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

    let description = val
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

    let _ = description;
    Ok((name, version))
}

fn is_valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
