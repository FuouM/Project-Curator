//! Generic download-job runner (§3.0).
//!
//! Engine-agnostic: this module owns job state, spawning, stdout parsing, and
//! cancellation for every registered `DownloadEngine`. An engine only supplies
//! its executable resolution, command line, stdout parser, and completion
//! detection — see `engine::DownloadEngine`.

pub mod aria2;
pub mod engine;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tracing::error;

pub use engine::{DownloadEngine, DownloadJob, DownloadJobState, EngineRegistry};

/// Shared live state for active download jobs, keyed by `job_id`.
pub type DownloadJobsMap =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, DownloadJobState>>>;

/// Per-job cancellation signal, keyed by `job_id`. The generic runner watches
/// the receiver; `DownloadCancel` sends `true` to trigger the graceful stop.
pub type DownloadCancelMap =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>;

/// Reserved output paths, keyed by `job_id`. The backend owns name resolution:
/// `ResolveOutputPath` claims the next free `_N` name for a queued job, and
/// `DownloadStart` reuses that exact claim, so queued duplicates never guess
/// names client-side and can never double-rename.
pub type DownloadPathClaims = Arc<tokio::sync::Mutex<std::collections::HashMap<String, PathBuf>>>;

/// Grace period granted to the engine after its graceful-stop watcher is
/// killed, before the runner falls back to a hard process kill.
const GRACE_PERIOD: std::time::Duration = std::time::Duration::from_secs(10);

/// Register a job and spawn the background runner. Returns after the process
/// has been spawned (or the spawn failed synchronously); progress is polled
/// via `DownloadProgress`.
pub async fn start_download(
    mut job: DownloadJob,
    engine: Arc<dyn DownloadEngine>,
    data_dir: Arc<PathBuf>,
    settings: Arc<tokio::sync::Mutex<crate::AppSettings>>,
    jobs: DownloadJobsMap,
    cancels: DownloadCancelMap,
    claims: DownloadPathClaims,
) -> anyhow::Result<()> {
    // Resolve (and, for queued jobs, reuse) the output path through the shared
    // claim map so the name is exactly what `ResolveOutputPath` reserved at
    // enqueue time - the client never invents `_N` names itself.
    let resolved = resolve_output_path(
        &jobs,
        &claims,
        &job.job_id,
        &job.output_path,
        job.auto_rename,
    )
    .await;
    job.output_path = resolved;

    let exe = {
        let s = settings.lock().await;
        engine
            .resolve(&data_dir, &s)
            .context("Failed to resolve download engine executable")?
    };

    let output_path_str = job.output_path.to_string_lossy().into_owned();
    {
        let mut guard = jobs.lock().await;
        guard.insert(
            job.job_id.clone(),
            DownloadJobState {
                running: true,
                status: "running".to_string(),
                percent: 0.0,
                downloaded_bytes: 0,
                total_bytes: None,
                speed_bps: 0,
                eta_secs: None,
                connections: 0,
                output_path: Some(output_path_str),
                error: None,
                logs: vec![format!("engine: {}", engine.executable())],
                command: None,
                engine: Some(job.engine.clone()),
            },
        );
    }

    // Register the cancel handle *before* the runner starts so a cancel request
    // can never race a job that is about to exist.
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut guard = cancels.lock().await;
        guard.insert(job.job_id.clone(), cancel_tx);
    }

    if let Some(parent) = job.output_path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
    }

    let jobs_run = jobs.clone();
    let cancels_run = cancels.clone();
    let claims_run = claims.clone();
    tokio::spawn(async move {
        run_download(
            job,
            engine,
            exe,
            cancel_rx,
            jobs_run,
            cancels_run,
            claims_run,
        )
        .await;
    });
    Ok(())
}

/// Resolve the next free `_N` path for `path` when it already exists on disk or
/// is already claimed by another active job, e.g. `file.png` → `file_1.png` →
/// `file_2.png`. Returns `path` unchanged when it is free or no numbered slot
/// is available.
fn unique_output_path(path: &Path, claimed: &[PathBuf]) -> PathBuf {
    let taken = |candidate: &Path| candidate.exists() || claimed.iter().any(|c| c == candidate);
    if !taken(path) {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..100_000u32 {
        let candidate = parent.join(format!("{stem}_{i}{ext}"));
        if !taken(&candidate) {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Resolve the output path for a job, reserving it under `job_id` so a later
/// `DownloadStart` reuses the exact name. When a claim already exists for the
/// job, it is authoritative; otherwise the next free `_N` name is computed
/// against disk, every active job's output path, and every other claim.
pub async fn resolve_output_path(
    jobs: &DownloadJobsMap,
    claims: &DownloadPathClaims,
    job_id: &str,
    requested: &Path,
    auto_rename: bool,
) -> PathBuf {
    let mut claims_guard = claims.lock().await;
    if let Some(existing) = claims_guard.get(job_id) {
        return existing.clone();
    }
    if !auto_rename {
        claims_guard.insert(job_id.to_string(), requested.to_path_buf());
        return requested.to_path_buf();
    }
    let claimed: Vec<PathBuf> = {
        let jobs_guard = jobs.lock().await;
        let mut v: Vec<PathBuf> = jobs_guard
            .values()
            .filter_map(|s| s.output_path.as_ref().map(PathBuf::from))
            .collect();
        v.extend(claims_guard.values().cloned());
        v
    };
    let resolved = unique_output_path(requested, &claimed);
    claims_guard.insert(job_id.to_string(), resolved.clone());
    resolved
}

async fn run_download(
    job: DownloadJob,
    engine: Arc<dyn DownloadEngine>,
    exe: PathBuf,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    jobs: DownloadJobsMap,
    cancels: DownloadCancelMap,
    claims: DownloadPathClaims,
) {
    // Graceful-stop watcher, shared between the cancel listener and the final
    // cleanup path.
    let watcher = Arc::new(tokio::sync::Mutex::new(engine.watcher_command().and_then(
        |mut c| {
            c.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            c.spawn().ok()
        },
    )));
    let watcher_pid = {
        let watcher_guard = watcher.lock().await;
        watcher_guard.as_ref().and_then(|w| w.id())
    };

    let mut cmd = engine.build_command(&exe, &job, watcher_pid);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let command_string = {
        let mut parts = vec![exe.to_string_lossy().into_owned()];
        for arg in cmd.as_std().get_args() {
            parts.push(arg.to_string_lossy().into_owned());
        }
        parts.join(" ")
    };
    {
        let mut guard = jobs.lock().await;
        if let Some(state) = guard.get_mut(&job.job_id) {
            state.command = Some(command_string);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            error!("download engine spawn failed for {}: {e}", job.job_id);
            let mut guard = jobs.lock().await;
            if let Some(state) = guard.get_mut(&job.job_id) {
                state.running = false;
                state.status = "failed".to_string();
                state.error = Some(format!("Failed to spawn download engine: {e}"));
            }
            drop(guard);
            cancels.lock().await.remove(&job.job_id);
            claims.lock().await.remove(&job.job_id);
            return;
        }
    };
    let _job = bind_kill_on_close_job(&mut child);

    let stdout = child.stdout.take().expect("download stdout piped");
    let stderr = child.stderr.take().expect("download stderr piped");

    let parser = spawn_stdout_parser(stdout, engine.clone(), jobs.clone(), job.job_id.clone());
    let stderr_task = spawn_stderr_tail(stderr);

    let has_watcher = watcher.lock().await.is_some();
    let mut cancelled = false;
    let status = tokio::select! {
        res = child.wait() => res,
        _ = cancel_rx.changed() => {
            cancelled = *cancel_rx.borrow();
            if cancelled {
                // Kill the graceful-stop watcher so the engine flushes its
                // partial state, then give it a grace period before the hard
                // kill backstop.
                {
                    let mut guard = watcher.lock().await;
                    if let Some(mut w) = guard.take() {
                        let _ = w.kill().await;
                    }
                }
                if has_watcher {
                    let grace = tokio::time::timeout(GRACE_PERIOD, child.wait()).await;
                    match grace {
                        Ok(res) => res,
                        Err(_elapsed) => {
                            let _ = child.kill().await;
                            child.wait().await
                        }
                    }
                } else {
                    let _ = child.kill().await;
                    child.wait().await
                }
            } else {
                child.wait().await
            }
        }
    };

    // Stop the watcher on the normal completion path so no watcher leaks.
    {
        let mut guard = watcher.lock().await;
        if let Some(mut w) = guard.take() {
            let _ = w.kill().await;
        }
    }

    let lines = parser.await.unwrap_or_default();
    let stderr_tail = stderr_task.await.unwrap_or_default();

    let mut guard = jobs.lock().await;
    if let Some(state) = guard.get_mut(&job.job_id) {
        state.running = false;
        if cancelled {
            state.status = "cancelled".to_string();
        } else if let Some((ok, path)) = engine.completion(&lines) {
            // Validate the engine-reported output before trusting it: a parser
            // bug must never surface garbage (e.g. a percent token) as the
            // download location. Prefer the reported path when it exists on
            // disk; otherwise fall back to the requested output path.
            let mut resolved = path;
            if !resolved.is_file() && job.output_path.is_file() {
                resolved = job.output_path.clone();
            }
            state.output_path = Some(resolved.to_string_lossy().into_owned());
            if ok {
                if resolved.is_file() {
                    state.status = "completed".to_string();
                    state.percent = 100.0;
                    // Report the true on-disk size so history never stores a
                    // 0-byte placeholder for a real file.
                    if let Ok(meta) = tokio::fs::metadata(&resolved).await {
                        let size = meta.len();
                        state.downloaded_bytes = size;
                        state.total_bytes = Some(size);
                    }
                } else {
                    state.status = "failed".to_string();
                    state.error = Some(
                        "Download reported complete but no output file was found on disk."
                            .to_string(),
                    );
                }
            } else {
                state.status = "failed".to_string();
                state.error = Some("Download failed. See engine logs.".to_string());
            }
        } else {
            match status.map(|s| s.success()) {
                Ok(true) => {
                    if job.output_path.is_file() {
                        state.status = "completed".to_string();
                        state.percent = 100.0;
                    } else {
                        state.status = "failed".to_string();
                        state.error = Some(
                            "Engine exited successfully but produced no output file".to_string(),
                        );
                    }
                }
                Ok(false) => {
                    state.status = "failed".to_string();
                    // aria2 leaves stderr empty on most failures; the actionable
                    // detail (e.g. `[ERROR] ...` or `Download GID#... not
                    // complete`) lives in stdout. Surface the last meaningful
                    // line instead of a bare failure.
                    let detail = lines
                        .iter()
                        .rev()
                        .find(|l| {
                            l.contains("[ERROR]")
                                || l.contains("not complete")
                                || l.contains("Download complete")
                        })
                        .or_else(|| lines.iter().rev().find(|l| !l.trim().is_empty()))
                        .map(|l| l.trim())
                        .unwrap_or_default();
                    let suffix = if detail.is_empty() {
                        stderr_tail.trim().to_string()
                    } else {
                        detail.to_string()
                    };
                    state.error = Some(if suffix.is_empty() {
                        "Download engine exited with failure.".to_string()
                    } else {
                        format!("Download engine exited with failure: {suffix}")
                    });
                }
                Err(_) => {
                    state.status = "failed".to_string();
                    state.error =
                        Some("Download engine process terminated unexpectedly".to_string());
                }
            }
        }
    }
    drop(guard);
    cancels.lock().await.remove(&job.job_id);
    claims.lock().await.remove(&job.job_id);
}

/// Read a job's current state (empty default when the job id is unknown).
pub async fn get_download_progress(jobs: &DownloadJobsMap, job_id: &str) -> DownloadJobState {
    let guard = jobs.lock().await;
    guard.get(job_id).cloned().unwrap_or_default()
}

/// Cancel a download: signal the runner, which kills the engine's graceful-stop
/// watcher first (so the control file is flushed) and hard-kills only as a
/// backstop. Idempotent when the job is not running.
pub async fn cancel_download(
    jobs: &DownloadJobsMap,
    cancels: &DownloadCancelMap,
    job_id: &str,
) -> anyhow::Result<()> {
    let running = {
        jobs.lock()
            .await
            .get(job_id)
            .map(|s| s.running)
            .unwrap_or(false)
    };
    if !running {
        return Ok(());
    }
    let tx = { cancels.lock().await.get(job_id).cloned() };
    if let Some(tx) = tx {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Read raw stdout bytes, splitting on **both** `\n` and `\r`, feeding each
/// trimmed non-empty line to the engine parser and keeping the full capture
/// for `completion()`. Returns the captured lines.
fn spawn_stdout_parser(
    stdout: tokio::process::ChildStdout,
    engine: Arc<dyn DownloadEngine>,
    jobs: DownloadJobsMap,
    job_id: String,
) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut lines: Vec<String> = Vec::new();
        let mut reader = BufReader::new(stdout);
        let mut partial: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => partial.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
            while let Some(i) = partial.iter().position(|&b| b == b'\n' || b == b'\r') {
                let raw: Vec<u8> = partial.drain(..=i).collect();
                process_raw_line(&engine, &jobs, &job_id, &mut lines, raw).await;
            }
        }
        if !partial.is_empty() {
            let raw = std::mem::take(&mut partial);
            process_raw_line(&engine, &jobs, &job_id, &mut lines, raw).await;
        }
        lines
    })
}

async fn process_raw_line(
    engine: &Arc<dyn DownloadEngine>,
    jobs: &DownloadJobsMap,
    job_id: &str,
    lines: &mut Vec<String>,
    raw: Vec<u8>,
) {
    let start = raw
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(raw.len());
    if start >= raw.len() {
        return;
    }
    let end = raw
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .unwrap_or(start);
    let line = String::from_utf8_lossy(&raw[start..=end]).into_owned();
    if line.is_empty() {
        return;
    }
    lines.push(line.clone());
    let mut guard = jobs.lock().await;
    if let Some(state) = guard.get_mut(job_id) {
        engine.parse_line(&line, state);
    }
}

/// Drain engine stderr, keeping the last 30 lines for failure diagnostics.
fn spawn_stderr_tail(stderr: tokio::process::ChildStderr) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if tail.len() >= 30 {
                tail.remove(0);
            }
            tail.push(line);
        }
        tail.join("\n")
    })
}

/// Bind the child to a Windows Job Object with `KILL_ON_JOB_CLOSE` so the
/// download tree dies if the service exits unexpectedly. The returned RAII
/// guard keeps the job handle alive for the duration of the job. No-op on
/// non-Windows.
#[cfg(windows)]
fn bind_kill_on_close_job(child: &mut tokio::process::Child) -> Option<job_guard::JobObject> {
    job_guard::bind(child)
}

#[cfg(not(windows))]
fn bind_kill_on_close_job(_child: &mut tokio::process::Child) -> Option<()> {
    None
}

/// Windows Job Object plumbing. Kept behind its own module so the WinAPI
/// types never leak into the generic runner.
#[cfg(windows)]
mod job_guard {
    use std::mem::size_of;

    #[allow(non_camel_case_types, clippy::upper_case_acronyms)]
    type DWORD = u32;
    #[allow(non_camel_case_types, clippy::upper_case_acronyms)]
    type BOOL = i32;
    #[allow(non_camel_case_types, clippy::upper_case_acronyms)]
    type HANDLE = *mut std::ffi::c_void;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    struct IO_COUNTERS {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[allow(non_camel_case_types)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: DWORD,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: DWORD,
        affinity: usize,
        priority_class: DWORD,
        scheduling_class: DWORD,
    }

    #[repr(C)]
    #[allow(non_camel_case_types)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        io_info: IO_COUNTERS,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_used: usize,
        peak_job_used: usize,
    }

    unsafe extern "system" {
        fn CreateJobObjectW(lpJobAttributes: *const std::ffi::c_void, lpName: *const u16)
        -> HANDLE;
        fn SetInformationJobObject(
            hJob: HANDLE,
            JobObjectInformationClass: i32,
            lpJobObjectInformation: *const std::ffi::c_void,
            cbJobObjectInformationLength: DWORD,
        ) -> BOOL;
        fn AssignProcessToJobObject(hJob: HANDLE, hProcess: HANDLE) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
    }

    pub(crate) struct JobObject(HANDLE);
    // SAFETY: the handle is only ever passed to `CloseHandle` on drop, which is
    // safe to call from any thread; the guard is never otherwise shared.
    unsafe impl Send for JobObject {}
    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(crate) fn bind(child: &mut tokio::process::Child) -> Option<JobObject> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
            );
            AssignProcessToJobObject(job, child.raw_handle().unwrap_or(std::ptr::null_mut()));
            Some(JobObject(job))
        }
    }
}
