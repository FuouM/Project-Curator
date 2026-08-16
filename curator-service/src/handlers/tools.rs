//! Generic tool/binary management primitive (§3.4 A).
//!
//! Plugins inspect and manage auxiliary executables (ffmpeg, aria2, future
//! yt-dlp) through `CheckTool` / `SetToolPath` / `InstallTool` instead of
//! plugin-specific commands. Resolution order is explicit path → bundled
//! `<data_dir>/bin/` → system `PATH`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Result};
use tokio::sync::Mutex;
use tracing::info;

use crate::AppSettings;

/// Result of probing a configured tool installation.
#[derive(Debug, Clone)]
pub struct ToolStatus {
    pub resolved_path: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    /// Path to the portable build in `.curator/bin/`, if it exists.
    pub portable_path: Option<String>,
}

/// Per-tool install progress, keyed by tool id. Follows the same
/// `Arc<tokio::sync::Mutex<HashMap<…>>>` async pattern as every other progress
/// map in the codebase; the install pipelines run on the async runtime so the
/// tiny critical sections are taken with `.lock().await`.
pub type ToolInstallProgressMap = Arc<Mutex<HashMap<String, ToolInstallProgress>>>;

#[derive(Clone, Default)]
pub struct ToolInstallProgress {
    /// `"idle"` | `"downloading"` | `"extracting"` | `"completed"` | `"failed"`
    pub status: String,
    pub percent: u32,
    pub logs: Vec<String>,
    pub error: Option<String>,
}

pub async fn tool_install_progress_mut<F>(map: &ToolInstallProgressMap, tool: &str, f: F)
where
    F: FnOnce(&mut ToolInstallProgress),
{
    let mut guard = map.lock().await;
    let cell = guard.entry(tool.to_string()).or_default();
    f(cell);
}

pub async fn tool_install_progress_log(map: &ToolInstallProgressMap, tool: &str, line: impl Into<String>) {
    let line = line.into();
    tool_install_progress_mut(map, tool, |s| s.logs.push(line.clone())).await;
    info!("tool installer [{tool}]: {line}");
}

/// Read the shared install-progress cell for a tool.
pub async fn get_tool_install_progress(map: &ToolInstallProgressMap, tool: &str) -> ToolInstallProgress {
    let guard = map.lock().await;
    guard.get(tool).cloned().unwrap_or_default()
}

impl From<crate::handlers::ffmpeg::FfmpegStatus> for ToolStatus {
    fn from(s: crate::handlers::ffmpeg::FfmpegStatus) -> Self {
        Self {
            resolved_path: s.resolved_path,
            version: s.version,
            available: s.available,
            portable_path: s.portable_path,
        }
    }
}

/// Report a tool's availability, honoring the persisted explicit path.
pub async fn check_tool(
    data_dir: &Path,
    settings: &Arc<Mutex<AppSettings>>,
    tool: &str,
) -> Result<ToolStatus> {
    match tool {
        "ffmpeg" => Ok(super::ffmpeg::get_ffmpeg_status(data_dir, settings).await?.into()),
        "aria2" => {
            let explicit = { settings.lock().await.tool_paths.get("aria2").cloned().flatten() };
            Ok(check_aria2(data_dir, explicit))
        }
        other => bail!("unsupported tool: {other}"),
    }
}

fn check_aria2(data_dir: &Path, explicit: Option<String>) -> ToolStatus {
    let bundled = data_dir.join("bin").join(super::download::aria2::aria2_exe());
    let portable = bundled.is_file().then(|| bundled.to_string_lossy().into_owned());
    match super::download::aria2::resolve_aria2_path(data_dir, explicit.clone()) {
        Some(path) => {
            let version = super::download::aria2::probe_aria2_version(&path);
            ToolStatus {
                resolved_path: Some(path.to_string_lossy().into_owned()),
                version: version.clone(),
                available: version.is_some(),
                portable_path: portable,
            }
        }
        None => ToolStatus {
            resolved_path: explicit,
            version: None,
            available: false,
            portable_path: portable,
        },
    }
}

/// Persist an explicit tool executable path. `None` reverts to auto-detect.
/// ffmpeg's legacy `ffmpeg_path` field is kept in sync so the existing
/// ffmpeg plumbing keeps working unchanged.
pub async fn set_tool_path(
    data_dir: &Path,
    settings: &Arc<Mutex<AppSettings>>,
    tool: &str,
    path: Option<String>,
) -> Result<()> {
    if tool != "ffmpeg" && tool != "aria2" {
        bail!("unsupported tool: {tool}");
    }
    let mut s = settings.lock().await;
    s.tool_paths.insert(tool.to_string(), path.clone());
    if tool == "ffmpeg" {
        s.ffmpeg_path = path.clone();
    }
    let settings_to_save = s.clone();
    let data_dir_buf = data_dir.to_path_buf();
    drop(s);

    tokio::task::spawn_blocking(move || crate::save_settings(&data_dir_buf, &settings_to_save))
        .await??;
    info!("Tool path persisted: {tool} = {:?}", path);
    Ok(())
}

pub struct ToolInstallOutcome {
    pub started: bool,
    pub error: Option<String>,
}

/// Start a background tool install (download → extract → verify). Only tools
/// with a bundled-binary spec are auto-installable; everything else reports a
/// clear `started: false` error.
pub async fn install_tool(
    data_dir: &Path,
    tool: &str,
    progress: ToolInstallProgressMap,
) -> Result<ToolInstallOutcome> {
    match tool {
        "aria2" => install_aria2(data_dir, progress).await,
        other => Ok(ToolInstallOutcome {
            started: false,
            error: Some(format!("unsupported tool for auto-install: {other}")),
        }),
    }
}

// ── aria2 portable binary install ─────────────────────────────────────────────

/// Official static Windows x64 aria2 build. Pinned to a tagged release so the
/// URL is immutable; integrity is verified by executing `aria2c --version`.
const ARIA2_VERSION: &str = "1.37.0";
const ARIA2_RELEASE_URL: &str = "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip";

async fn install_aria2(data_dir: &Path, progress: ToolInstallProgressMap) -> Result<ToolInstallOutcome> {
    let bin_dir = data_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| anyhow::anyhow!("Failed to create bin directory: {e}"))?;

    let exe = bin_dir.join(super::download::aria2::aria2_exe());
    if exe.is_file() && super::download::aria2::probe_aria2_version(&exe).is_some() {
        return Ok(ToolInstallOutcome {
            started: false,
            error: None,
        });
    }

    {
        let guard = progress.lock().await;
        if matches!(guard.get("aria2").map(|s| s.status.as_str()), Some("downloading" | "extracting")) {
            return Ok(ToolInstallOutcome {
                started: false,
                error: Some("aria2 download already in progress".to_string()),
            });
        }
    }

    tool_install_progress_mut(&progress, "aria2", |s| {
        s.status = "downloading".to_string();
        s.percent = 0;
        s.error = None;
        s.logs.clear();
    })
    .await;
    tool_install_progress_log(&progress, "aria2", format!("Downloading {ARIA2_RELEASE_URL}")).await;

    // Run the download/extract on the async runtime (models.rs pattern) so the
    // tokio progress mutex can be taken with `.lock().await` throughout.
    let data_dir_owned = data_dir.to_path_buf();
    let progress_clone = progress.clone();
    tokio::spawn(async move {
        if let Err(e) = download_and_extract_aria2(&data_dir_owned, &progress_clone).await {
            tool_install_progress_mut(&progress_clone, "aria2", |s| {
                s.status = "failed".to_string();
                s.error = Some(e.to_string());
            })
            .await;
            tool_install_progress_log(&progress_clone, "aria2", format!("[ERROR] {e}")).await;
        }
    });

    Ok(ToolInstallOutcome {
        started: true,
        error: None,
    })
}

/// Stream the aria2 release zip from GitHub to `zip_path`, reporting byte
/// progress into the install console. Leaves a `.tmp` file on failure so the
/// caller can clean up and retry.
async fn download_aria2_zip(
    agent: &ureq::Agent,
    zip_path: &Path,
    progress: &ToolInstallProgressMap,
) -> anyhow::Result<()> {
    let mut response = agent
        .get(ARIA2_RELEASE_URL)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Curator/1.0")
        .call()
        .map_err(|e| anyhow::anyhow!("download failed: {e}"))?;

    let total = response
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    tool_install_progress_log(progress, "aria2", format!("Response size: {} bytes", total)).await;

    let temp_path = zip_path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp_path)?;
    let mut reader = response.body_mut().as_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_logged_pct: u32 = 0;
    loop {
        use std::io::Read;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n])?;
        done += n as u64;
        if total > 0 {
            let pct = ((done as f64 / total as f64) * 90.0) as u32;
            tool_install_progress_mut(progress, "aria2", |s| s.percent = pct).await;
            if pct >= last_logged_pct + 10 {
                last_logged_pct = pct;
                tool_install_progress_log(progress, "aria2", format!("Downloading… {pct}%")).await;
            }
        }
    }
    drop(file);
    std::fs::rename(&temp_path, zip_path)?;
    tool_install_progress_log(progress, "aria2", "Download complete.").await;
    Ok(())
}

async fn download_and_extract_aria2(data_dir: &Path, progress: &ToolInstallProgressMap) -> anyhow::Result<()> {
    let bin_dir = data_dir.join("bin");
    let zip_path = bin_dir.join(format!("aria2-{ARIA2_VERSION}-win-64.zip"));

    // ── 1. Download the zip (streamed, byte progress reported) ──────────────
    // GitHub over HTTP/2 can drop a connection mid-transfer on flaky links, so
    // the whole fetch is retried a few times. A retry always removes the
    // partial .tmp/.zip files first so it never merges with stale bytes.
    let config = ureq::config::Config::builder()
        .max_redirects(10)
        .timeout_global(Some(std::time::Duration::from_secs(180)))
        .build();
    let agent = config.new_agent();

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=3u32 {
        match download_aria2_zip(&agent, &zip_path, progress).await {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                tool_install_progress_log(
                    progress,
                    "aria2",
                    format!("Download attempt {attempt}/3 failed: {e}"),
                )
                .await;
                last_err = Some(e);
                std::fs::remove_file(&zip_path).ok();
                std::fs::remove_file(zip_path.with_extension("tmp")).ok();
                tokio::time::sleep(std::time::Duration::from_millis(800 * attempt as u64)).await;
            }
        }
    }
    if let Some(e) = last_err {
        return Err(anyhow::anyhow!("download failed after 3 attempts: {e}"));
    }

    // ── 2. Extract aria2c.exe into bin/ ─────────────────────────────────────
    tool_install_progress_mut(progress, "aria2", |s| {
        s.status = "extracting".to_string();
        s.percent = 90;
    })
    .await;
    tool_install_progress_log(progress, "aria2", "Extracting aria2c.exe…").await;
    let zip_file = std::fs::File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| anyhow::anyhow!("open zip: {e}"))?;
    let mut extracted = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| anyhow::anyhow!("zip entry {i}: {e}"))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with("/aria2c.exe") || name == "aria2c.exe" {
            let out_path = bin_dir.join("aria2c.exe");
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
            extracted = true;
            break;
        }
    }
    if !extracted {
        bail!("archive did not contain aria2c.exe");
    }
    std::fs::remove_file(&zip_path).ok();

    // ── 3. Verify by executing aria2c --version ─────────────────────────────
    let exe = bin_dir.join(super::download::aria2::aria2_exe());
    if super::download::aria2::probe_aria2_version(&exe).is_none() {
        bail!("aria2c failed --version verification");
    }
    tool_install_progress_mut(progress, "aria2", |s| {
        s.status = "completed".to_string();
        s.percent = 100;
    })
    .await;
    tool_install_progress_log(progress, "aria2", "aria2 installed and verified.").await;
    Ok(())
}
