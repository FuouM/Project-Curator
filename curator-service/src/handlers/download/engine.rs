use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::AppSettings;

/// Parameters of a download request, supplied by the generic `DownloadStart`
/// primitive. Engine-agnostic: the plugin names an engine id and the backend's
/// engine registry (see `EngineRegistry`) knows how to translate these fields
/// into that engine's command line.
#[derive(Clone, Debug)]
pub struct DownloadJob {
    pub job_id: String,
    pub engine: String,
    pub url: String,
    pub output_path: PathBuf,
    pub max_connections: u16,
    pub speed_limit_kb: Option<u64>,
    pub user_agent: Option<String>,
    pub headers: Vec<String>,
    pub max_tries: Option<u64>,
    pub timeout_secs: Option<u64>,
    /// When the target path already exists, pick the next free `_1`, `_2`, ...
    /// name instead of overwriting (aria2's own `--auto-file-renaming` appends
    /// `.1`; this engine-agnostic scheme uses the requested `_N` style).
    pub auto_rename: bool,
}

/// Live state of an in-flight (or finished) download job, keyed by `job_id`.
/// Populated by the generic runner and polled via the generic `DownloadProgress`.
#[derive(Clone, Default)]
pub struct DownloadJobState {
    pub running: bool,
    /// `"running"` | `"completed"` | `"cancelled"` | `"failed"`
    pub status: String,
    pub percent: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub connections: u32,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub command: Option<String>,
    pub engine: Option<String>,
}

/// Append a log line to the job state, keeping at most `max` lines so an
/// endlessly streaming engine cannot grow the vec without bound.
pub(crate) fn push_log(state: &mut DownloadJobState, line: String, max: usize) {
    state.logs.push(line);
    let overflow = state.logs.len().saturating_sub(max);
    if overflow > 0 {
        state.logs.drain(..overflow);
    }
}

/// Engine seam (§3.0). One implementation per CLI downloader. The generic
/// runner in this module owns spawning, stdout parsing, and cancellation; an
/// engine only knows how to (a) find its executable, (b) build its command
/// line, (c) parse its stdout lines into the generic state, and (d) decide
/// completion from the captured output.
///
/// Adding a future engine (e.g. yt-dlp) is purely additive: implement the
/// trait, seed the registry, and existing plugins call it with a new `engine`
/// value — no new IPC surface.
pub trait DownloadEngine: Send + Sync {
    /// Stable id used as the `engine` parameter of `DownloadStart` and as the
    /// registry key.
    fn id(&self) -> &'static str;
    /// On-disk executable name (e.g. `aria2c.exe`).
    fn executable(&self) -> &'static str;
    /// Resolve the engine executable honoring explicit → bundled → PATH.
    fn resolve(&self, data_dir: &Path, settings: &AppSettings) -> anyhow::Result<PathBuf>;
    /// Optional child process used to trigger a *graceful* engine stop: when
    /// this process dies, the engine flushes its partial state and exits. The
    /// runner passes its pid to `build_command` via `--stop-with-process`
    /// style flags. `None` when the engine has no graceful-stop mechanism
    /// (cancel then falls back to a hard process kill).
    fn watcher_command(&self) -> Option<tokio::process::Command> {
        None
    }
    /// Build the engine command line for a job. `watcher_pid` is the pid of
    /// the watcher spawned from `watcher_command`, when the engine uses one.
    fn build_command(
        &self,
        exe: &Path,
        job: &DownloadJob,
        watcher_pid: Option<u32>,
    ) -> tokio::process::Command;
    /// Feed one stdout line into the generic job state. Idempotent: progress
    /// engines may repeat a line and the last write wins.
    fn parse_line(&self, line: &str, state: &mut DownloadJobState);
    /// Best-effort completion detection from the full captured stdout. Returns
    /// `(ok, exact_output_path)` when the output proves completion; `None` when
    /// there is no completion evidence (e.g. a cancelled in-progress run).
    fn completion(&self, lines: &[String]) -> Option<(bool, PathBuf)>;
}

/// Shared map of registered engines, seeded in `main()`. Adding an engine is
/// a registry insertion; no changes to the runner or IPC plumbing.
pub type EngineRegistry = Arc<std::collections::HashMap<&'static str, Arc<dyn DownloadEngine>>>;
