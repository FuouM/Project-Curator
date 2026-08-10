use anyhow::Result;
use std::path::Path;
use std::sync::Arc;
use tracing::info;

use crate::AppSettings;

/// Result of probing the configured FFmpeg installation.
#[derive(Debug, Clone)]
pub struct FfmpegStatus {
    pub resolved_path: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    /// Path to the portable build in `.curator/bin/`, if it exists.
    pub portable_path: Option<String>,
}

/// Report FFmpeg availability, honoring the persisted explicit path. Missing
/// FFmpeg is *not* an error — the caller surfaces it as a status result.
pub async fn get_ffmpeg_status(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> Result<FfmpegStatus> {
    let explicit = { settings.lock().await.ffmpeg_path.clone() };
    let resolved = curator_core::video::resolve_ffmpeg_path(
        data_dir,
        explicit.as_deref().map(Path::new),
    )
    .ok();
    let portable = {
        let p = data_dir.join("bin").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        if p.is_file() {
            Some(p.to_string_lossy().into_owned())
        } else {
            None
        }
    };
    match resolved {
        Some(p) => {
            let version = curator_core::video::probe_ffmpeg_version(&p).unwrap_or_default();
            Ok(FfmpegStatus {
                resolved_path: Some(p.to_string_lossy().into_owned()),
                version: Some(version),
                available: true,
                portable_path: portable,
            })
        }
        None => Ok(FfmpegStatus {
            resolved_path: explicit,
            version: None,
            available: false,
            portable_path: portable,
        }),
    }
}

/// Persist an explicit FFmpeg executable path. `None` reverts to auto-detect.
pub async fn set_ffmpeg_path(
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
    path: Option<String>,
) -> Result<()> {
    let mut s = settings.lock().await;
    s.ffmpeg_path = path.clone();
    let settings_to_save = s.clone();
    let data_dir_buf = data_dir.to_path_buf();
    drop(s);

    tokio::task::spawn_blocking(move || crate::save_settings(&data_dir_buf, &settings_to_save))
        .await??;
    info!("FFmpeg path persisted: {:?}", path);
    Ok(())
}
