use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

pub async fn validate_plugin_logic(manifest_path_str: &str) -> Result<(String, String)> {
    let path = Path::new(manifest_path_str);
    if !path.exists() {
        return Err(anyhow::anyhow!("manifest.json path does not exist"));
    }

    let content = fs::read_to_string(path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;

    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .context("Missing 'name' field")?
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .context("Missing 'version' field")?
        .to_string();

    if let Some(permissions) = val.get("permissions") {
        if !permissions.is_object() {
            return Err(anyhow::anyhow!("'permissions' must be a JSON object"));
        }
    }

    Ok((name, version))
}
