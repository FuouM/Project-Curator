use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use super::engine::{push_log, DownloadEngine, DownloadJob, DownloadJobState};
use crate::AppSettings;

/// Concrete aria2 engine (§3.1). Flags and stdout shapes below were
/// empirically verified against `aria2c 1.37.0` (see PLAN_ARIA2_DOWNLOADER.md).
pub struct Aria2Engine;

impl Aria2Engine {
    pub fn new() -> Self {
        Self
    }
}

impl Default for Aria2Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// On-disk executable name for the aria2 downloader.
pub(crate) fn aria2_exe() -> &'static str {
    if cfg!(windows) {
        "aria2c.exe"
    } else {
        "aria2c"
    }
}

/// Resolve the aria2 executable honoring explicit → bundled → PATH.
pub(crate) fn resolve_aria2_path(data_dir: &Path, explicit: Option<String>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let candidate = Path::new(&p);
        if candidate.is_file() {
            return Some(candidate.to_path_buf());
        }
    }
    let bundled = data_dir.join("bin").join(aria2_exe());
    if bundled.is_file() {
        return Some(bundled);
    }
    which_in_path(aria2_exe())
}

/// Search `PATH` for an executable by name.
fn which_in_path(exe: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Run `aria2c --version` and return the first line (e.g. `aria2 version 1.37.0`).
pub(crate) fn probe_aria2_version(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

/// Long-lived sleep process used as the `--stop-with-process` watcher. When the
/// runner kills it, aria2 performs a graceful stop that flushes the `.aria2`
/// control file so a later `-c` resume works.
fn watcher_command() -> Command {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 2147483647"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

impl DownloadEngine for Aria2Engine {
    fn id(&self) -> &'static str {
        "aria2"
    }

    fn executable(&self) -> &'static str {
        aria2_exe()
    }

    fn resolve(&self, data_dir: &Path, settings: &AppSettings) -> anyhow::Result<PathBuf> {
        let explicit = settings.tool_paths.get(self.id()).cloned().flatten();
        resolve_aria2_path(data_dir, explicit).ok_or_else(|| {
            anyhow::anyhow!(
                "aria2c not found. Configure it, place it in <data_dir>/bin/, or run InstallTool."
            )
        })
    }

    fn watcher_command(&self) -> Option<Command> {
        Some(watcher_command())
    }

    fn build_command(&self, exe: &Path, job: &DownloadJob, watcher_pid: Option<u32>) -> Command {
        let mut cmd = Command::new(exe);
        cmd.arg("--enable-color=false")
            .arg("--no-conf")
            .arg("--console-log-level=notice")
            .arg("--download-result=full")
            .arg("--summary-interval=1")
            .arg("--auto-save-interval=1")
            .arg("--file-allocation=none")
            .arg("-c")
            .arg(format!(
                "--max-connection-per-server={}",
                job.max_connections.clamp(1, 16)
            ))
            .arg(format!("--split={}", job.max_connections.clamp(1, 16)));
        if let Some(kb) = job.speed_limit_kb {
            cmd.arg(format!("--max-download-limit={kb}K"));
        }
        if let Some(ua) = &job.user_agent {
            cmd.arg(format!("--user-agent={ua}"));
        }
        for header in &job.headers {
            cmd.arg(format!("--header={header}"));
        }
        if let Some(tries) = job.max_tries {
            cmd.arg(format!("--max-tries={tries}"));
        }
        if let Some(timeout) = job.timeout_secs {
            cmd.arg(format!("--connect-timeout={timeout}"))
                .arg(format!("--timeout={timeout}"));
        }
        if let Some(pid) = watcher_pid {
            cmd.arg(format!("--stop-with-process={pid}"));
        }
        let out_name = job
            .output_path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download.bin".to_string());
        let out_dir = job
            .output_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        cmd.arg("--dir").arg(out_dir).arg("--out").arg(out_name).arg(&job.url);
        cmd
    }

    fn parse_line(&self, line: &str, state: &mut DownloadJobState) {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("[#") {
            if let Some(end) = rest.rfind(']') {
                let body = &rest[..end];
                let mut tokens = body.split_whitespace();
                let _gid = tokens.next();
                if let Some(dl_total) = tokens.next() {
                    if let Some((dl, total, pct)) = parse_dl_total(dl_total) {
                        state.downloaded_bytes = dl;
                        if let Some(t) = total {
                            state.total_bytes = Some(t);
                        }
                        state.percent = f64::from(pct);
                    }
                }
                for token in tokens {
                    if let Some(n) = token.strip_prefix("CN:") {
                        if let Ok(v) = n.parse::<u32>() {
                            state.connections = v;
                        }
                    } else if let Some(v) = token.strip_prefix("DL:") {
                        if let Some(bps) = parse_byte_size(v) {
                            state.speed_bps = bps;
                        }
                    } else if let Some(e) = token.strip_prefix("ETA:") {
                        state.eta_secs = parse_eta(e);
                    }
                }
            }
        } else if line.contains("[NOTICE]") {
            push_log(state, line.to_string(), 200);
        }
    }

    fn completion(&self, lines: &[String]) -> Option<(bool, PathBuf)> {
        // Map the result-table columns by name from the header line instead of
        // hardcoding indexes: aria2 >=1.37 inserts a `%` column between the
        // speed and path columns (`gid|stat|avg speed|%|path/URI`).
        let mut stat_col: Option<usize> = None;
        let mut path_col: Option<usize> = None;
        for line in lines {
            let cols: Vec<&str> = line.split('|').map(|c| c.trim()).collect();
            if cols.len() >= 2 && cols[0] == "gid" {
                for (i, c) in cols.iter().enumerate() {
                    if *c == "stat" {
                        stat_col = Some(i);
                    } else if matches!(*c, "path" | "path/URI" | "URI") {
                        path_col = Some(i);
                    }
                }
                break;
            }
        }
        let (Some(sc), Some(pc)) = (stat_col, path_col) else {
            return None;
        };
        for line in lines.iter().rev() {
            let cols: Vec<&str> = line.split('|').collect();
            if cols.len() <= sc || cols.len() <= pc {
                continue;
            }
            let stat = cols[sc].trim();
            if stat == "OK" || stat == "ERR" {
                let path = cols[pc].trim();
                if !path.is_empty() {
                    return Some((stat == "OK", PathBuf::from(path)));
                }
            }
        }
        None
    }
}

/// Parse `208KiB/10MiB(2%)` into `(downloaded, total, percent)`.
fn parse_dl_total(s: &str) -> Option<(u64, Option<u64>, u32)> {
    let (dl_part, rest) = s.split_once('/')?;
    let (total_part, pct_part) = rest.split_once('(')?;
    let pct = pct_part
        .trim_end_matches(')')
        .trim()
        .trim_end_matches('%')
        .parse::<u32>()
        .ok()?;
    let dl = parse_byte_size(dl_part)?;
    let total = parse_byte_size(total_part);
    Some((dl, total, pct))
}

/// Parse an aria2 byte/size token: binary `KiB`/`MiB`/`GiB`, decimal `K`/`M`/`G`,
/// bare bytes, or a trailing `B`.
fn parse_byte_size(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let (num, mult): (&str, u64) = if let Some(p) = lower.strip_suffix("kib") {
        (p, 1024)
    } else if let Some(p) = lower.strip_suffix("mib") {
        (p, 1024 * 1024)
    } else if let Some(p) = lower.strip_suffix("gib") {
        (p, 1024 * 1024 * 1024)
    } else if let Some(p) = lower.strip_suffix("k") {
        (p, 1000)
    } else if let Some(p) = lower.strip_suffix("m") {
        (p, 1000 * 1000)
    } else if let Some(p) = lower.strip_suffix("g") {
        (p, 1000 * 1000 * 1000)
    } else if let Some(p) = lower.strip_suffix("b") {
        (p, 1)
    } else {
        (lower.as_str(), 1)
    };
    let value: f64 = num.trim().parse().ok()?;
    Some((value * mult as f64) as u64)
}

/// Parse an aria2 ETA token (`38s`, `1m15s`, `2m`, `1h2m`) into seconds.
fn parse_eta(s: &str) -> Option<u64> {
    let mut total: u64 = 0;
    let mut current: u64 = 0;
    for ch in s.chars() {
        match ch {
            '0'..='9' => {
                current = current * 10 + u64::from(ch as u8 - b'0');
            }
            'h' => {
                total += current * 3600;
                current = 0;
            }
            'm' => {
                total += current * 60;
                current = 0;
            }
            's' => {
                total += current;
                current = 0;
            }
            _ => {}
        }
    }
    if total == 0 {
        None
    } else {
        Some(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_parses_path_from_header_mapped_columns() {
        let engine = Aria2Engine::new();
        // aria2 >=1.37 layout with the `%` column.
        let lines = [
            "[#0575ca 0B/641KiB(0%) CN:1 DL:78KiB ETA:8s]".to_string(),
            "[NOTICE] Download complete: K:/TEMP/opencode/aria2test/test.jpg".to_string(),
            "gid   |stat|avg speed  |  %|path/URI".to_string(),
            "======+====+===========+===+==================================================="
                .to_string(),
            "0575ca|OK  |   709KiB/s|100|K:/TEMP/opencode/aria2test/test.jpg".to_string(),
        ];
        let got = engine.completion(&lines).expect("completion detected");
        assert_eq!(got.0, true);
        assert_eq!(got.1.to_string_lossy(), "K:/TEMP/opencode/aria2test/test.jpg");
    }

    #[test]
    fn completion_handles_legacy_four_column_header() {
        let engine = Aria2Engine::new();
        let lines = [
            "gid   |stat|avg speed  |path/URI".to_string(),
            "======+====+===========+===============".to_string(),
            "0575ca|OK  |  1024B/s|/media/file.png".to_string(),
        ];
        let got = engine.completion(&lines).expect("completion detected");
        assert_eq!(got.0, true);
        assert_eq!(got.1.to_string_lossy(), "/media/file.png");
    }

    #[test]
    fn completion_ignores_header_and_garbage_rows() {
        let engine = Aria2Engine::new();
        let lines = [
            "gid   |stat|avg speed  |  %|path/URI".to_string(),
            "======+====+===========+===+============".to_string(),
            "0575ca|OK  |       0B/s|100|".to_string(),
        ];
        assert!(engine.completion(&lines).is_none());
    }
}
