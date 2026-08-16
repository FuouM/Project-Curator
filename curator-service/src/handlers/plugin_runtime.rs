//! Generic plugin runtime installer.
//!
//! Some plugins ship an embedded editor runtime (miniPaint is the first). The
//! runtime is a third-party archive that is downloaded and extracted into the
//! plugin folder at `plugins/<name>/<output_dir>`. Rather than hardcoding each
//! plugin's install steps into the Plugins gRPC service, this module drives the
//! whole download → extract → verify → inject pipeline from a per-plugin
//! `install.json` spec that lives inside the plugin's own folder:
//!
//! ```json
//! {
//!   "output_dir": "editor",
//!   "archive_url": "https://github.com/.../v1.2.3.zip",
//!   "zip_root": "app-1.2.3",
//!   "extract_dirs": ["dist"],
//!   "extract_files": ["index.html"],
//!   "verify": { "path": "dist/bundle.js", "sha256": "…" },
//!   "inject": { "source": "curator-bridge.js", "tag": "<script src=\"…\"></script>" }
//! }
//! ```
//!
//! `verify` pins a single extracted file to a known SHA-256 so a changed
//! upstream artifact fails loud instead of silently shipping wrong pixels
//! (miniPaint's bridge interception is written against the exact bundle).
//! `inject` copies a git-tracked asset from the plugin folder into the runtime
//! (e.g. a bridge script) and appends the given `<script>` tag to the runtime's
//! `index.html`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use tokio::sync::Mutex;

use crate::handlers::plugins::plugin_root;

/// Per-plugin runtime install progress, keyed by plugin name. Follows the same
/// `Arc<Mutex<HashMap<…>>>` pattern as transcode/download progress so the
/// gRPC unary transport can poll an in-flight install.
pub type PluginRuntimeProgressMap = Arc<Mutex<HashMap<String, PluginRuntimeProgress>>>;

#[derive(Clone, Default)]
pub struct PluginRuntimeProgress {
    pub status: String, // "idle" | "downloading" | "extracting" | "completed" | "failed"
    pub percent: u32,
    pub logs: Vec<String>,
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
struct InstallSpec {
    output_dir: String,
    archive_url: String,
    zip_root: String,
    #[serde(default)]
    extract_dirs: Vec<String>,
    #[serde(default)]
    extract_files: Vec<String>,
    verify: Option<VerifySpec>,
    inject: Option<InjectSpec>,
}

#[derive(serde::Deserialize)]
struct VerifySpec {
    path: String,
    sha256: String,
}

#[derive(serde::Deserialize)]
struct InjectSpec {
    source: String,
    tag: String,
}

pub async fn progress_mut<F>(map: &PluginRuntimeProgressMap, plugin: &str, f: F)
where
    F: FnOnce(&mut PluginRuntimeProgress),
{
    let mut guard = map.lock().await;
    let cell = guard.entry(plugin.to_string()).or_default();
    f(cell);
}

pub async fn progress_log(map: &PluginRuntimeProgressMap, plugin: &str, line: impl Into<String>) {
    let line = line.into();
    progress_mut(map, plugin, |s| {
        s.logs.push(line.clone());
    })
    .await;
    tracing::info!("plugin runtime installer [{plugin}]: {line}");
}

/// Generic install pipeline: read `install.json` from the plugin folder, then
/// download the archive, extract the pinned files, verify the SHA-256, inject
/// the bridge asset + script tag, and finally mark the install completed.
pub async fn install_plugin_runtime(
    data_dir: Arc<PathBuf>,
    plugin_name: String,
    progress: PluginRuntimeProgressMap,
) -> anyhow::Result<()> {
    // Run on the async runtime (models.rs pattern) so the tokio progress mutex
    // can be taken with `.lock().await` throughout the pipeline.
    let join = tokio::spawn(async move {
        let root = plugin_root(&data_dir)?;
        let plugin_dir = root.join(&plugin_name);
        let spec = read_spec(&plugin_dir)?;
        let runtime_dir = plugin_dir.join(&spec.output_dir);

        // Clear a stale runtime so a re-install is a pristine tree. This
        // directory is runtime-generated and gitignored; removal happens inside
        // the service process, never in git.
        if runtime_dir.exists() {
            std::fs::remove_dir_all(&runtime_dir)?;
        }
        std::fs::create_dir_all(&runtime_dir)?;

        let zip_path = std::env::temp_dir().join(format!("{plugin_name}_v{}.zip", spec.zip_root));
        download_archive(&spec, &zip_path, &plugin_name, &progress).await?;
        extract_archive(&spec, &zip_path, &runtime_dir, &plugin_name, &progress).await?;
        inject_bridge(&spec, &plugin_dir, &runtime_dir, &plugin_name, &progress).await?;
        std::fs::remove_file(&zip_path).ok(); // temp cleanup, ignore failure
        Ok(())
    });

    join.await
        .map_err(|e| anyhow::anyhow!("installer task panicked: {e}"))?
}

fn read_spec(plugin_dir: &Path) -> anyhow::Result<InstallSpec> {
    let spec_path = plugin_dir.join("install.json");
    let content = std::fs::read_to_string(&spec_path)
        .with_context(|| format!("missing install.json for plugin {}", plugin_dir.display()))?;
    let spec: InstallSpec =
        serde_json::from_str(&content).context("invalid install.json spec")?;
    if spec.output_dir.is_empty() || spec.archive_url.is_empty() {
        anyhow::bail!("install.json requires non-empty output_dir and archive_url");
    }
    Ok(spec)
}

async fn download_archive(
    spec: &InstallSpec,
    zip_path: &Path,
    plugin: &str,
    progress: &PluginRuntimeProgressMap,
) -> anyhow::Result<()> {
    progress_mut(progress, plugin, |s| {
        s.status = "downloading".to_string();
        s.percent = 0;
    })
    .await;
    progress_log(progress, plugin, format!("Downloading {}", spec.archive_url)).await;
    let config = ureq::config::Config::builder()
        .max_redirects(10)
        .timeout_global(Some(std::time::Duration::from_secs(120)))
        .build();
    let agent = config.new_agent();
    let mut response = agent
        .get(&spec.archive_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Curator/1.0")
        .call()
        .map_err(|e| anyhow::anyhow!("download failed: {e}"))?;

    let total = response
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    progress_log(progress, plugin, format!("Response size: {} bytes", total)).await;

    let tmp_path = zip_path.with_extension("zip.tmp");
    let mut file = std::fs::File::create(&tmp_path)?;
    let mut reader = response.body_mut().as_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_logged_pct: u32 = 0;
    loop {
        use std::io::Read;
        let n = reader.read(&mut buf)?;
        if n == 0 { break; }
        std::io::Write::write_all(&mut file, &buf[..n])?;
        done += n as u64;
        if total > 0 {
            let pct = ((done as f64 / total as f64) * 90.0) as u32;
            progress_mut(progress, plugin, |s| s.percent = pct).await;
            if pct >= last_logged_pct + 10 {
                last_logged_pct = pct;
                progress_log(progress, plugin, format!("Downloading… {pct}%")).await;
            }
        }
    }
    drop(file);
    std::fs::rename(&tmp_path, zip_path)?;
    progress_log(progress, plugin, "Download complete.").await;
    Ok(())
}
async fn extract_archive(
    spec: &InstallSpec,
    zip_path: &Path,
    runtime_dir: &Path,
    plugin: &str,
    progress: &PluginRuntimeProgressMap,
) -> anyhow::Result<()> {
    progress_mut(progress, plugin, |s| {
        s.status = "extracting".to_string();
        s.percent = 90;
    })
    .await;
    progress_log(progress, plugin, "Extracting runtime…").await;

    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| anyhow::anyhow!("open zip: {e}"))?;
    let prefix = format!("{}/", spec.zip_root);
    progress_log(progress, plugin, format!("Archive entries: {}", archive.len())).await;

    let mut written = 0usize;
    let mut extracted_lines: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| anyhow::anyhow!("zip entry {i}: {e}"))?;
        let full = entry.name().to_string();
        let Some(rel) = full.strip_prefix(&prefix) else { continue; };
        if rel.is_empty() { continue; }
        if rel.ends_with('/') { continue; } // dirs created implicitly by file writes

        let keep = spec.extract_files.iter().any(|f| f == rel)
            || spec.extract_dirs.iter().any(|d| rel.starts_with(&format!("{d}/")));
        if !keep { continue; }

        let out_path = runtime_dir.join(rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;
        written += 1;
        // Deferred: `zip::ZipFile` is not Send, so we must not hold it across
        // an `.await`. Emit the per-file lines after the loop closes `entry`.
        extracted_lines.push(format!("Extracted {rel}"));
    }
    for line in extracted_lines {
        progress_log(progress, plugin, line).await;
    }

    if !runtime_dir.join("index.html").is_file() {
        anyhow::bail!("archive did not contain index.html; refusing to proceed");
    }

    // Deterministic drift guard: when the spec pins a SHA-256, a changed
    // upstream artifact must fail loud so any interception written against the
    // pinned version is re-audited instead of silently producing wrong output.
    if let Some(verify) = &spec.verify {
        let target = runtime_dir.join(&verify.path);
        progress_log(progress, plugin, format!("Verifying SHA-256 of {}", verify.path)).await;
        let bytes = std::fs::read(&target)
            .map_err(|e| anyhow::anyhow!("missing {} after extraction: {e}", verify.path))?;
        let actual = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("{:x}", hasher.finalize())
        };
        if actual != verify.sha256 {
            anyhow::bail!(
                "{} does not match the pinned SHA-256 (got {actual}, expected {}). \
                 The upstream artifact changed; re-audit any interception block.",
                verify.path,
                verify.sha256
            );
        }
        progress_log(progress, plugin, "Hash verified.").await;
    }

    progress_log(progress, plugin, format!("Extracted {written} files.")).await;
    Ok(())
}

async fn inject_bridge(
    spec: &InstallSpec,
    plugin_dir: &Path,
    runtime_dir: &Path,
    plugin: &str,
    progress: &PluginRuntimeProgressMap,
) -> anyhow::Result<()> {
    if let Some(inject) = &spec.inject {
        let source = plugin_dir.join(&inject.source);
        let dest = runtime_dir.join(&inject.source);
        progress_log(progress, plugin, format!("Injecting {}", inject.source)).await;
        std::fs::copy(&source, &dest)?;

        let index_path = runtime_dir.join("index.html");
        let html = std::fs::read_to_string(&index_path)?;
        if html.contains(&inject.tag) {
            // idempotent
        } else {
            progress_log(progress, plugin, format!("Patching index.html ({} → before </body>)", inject.tag)).await;
            let patched = html.replace("</body>", &format!("{}\n</body>", inject.tag));
            std::fs::write(&index_path, patched)?;
        }
    }
    progress_mut(progress, plugin, |s| {
        s.status = "completed".to_string();
        s.percent = 100;
    })
    .await;
    progress_log(progress, plugin, "Runtime installed.").await;
    Ok(())
}

/// Read the shared install-progress cell for a plugin (empty when no install
/// has ever been started in this process).
pub async fn get_runtime_progress(
    map: &PluginRuntimeProgressMap,
    plugin: &str,
) -> PluginRuntimeProgress {
    let guard = map.lock().await;
    guard.get(plugin).cloned().unwrap_or_default()
}
