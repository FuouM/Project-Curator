use anyhow::Result;
use std::path::Path;

pub async fn path_exists(path: &str) -> Result<bool> {
    Ok(Path::new(path).exists())
}
