use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{error, info};

/// Resolved metadata of a media file, surfaced by `GetMediaMetadata`.
#[derive(Debug, Clone)]
pub struct MediaMetadata {
    pub duration_ms: i64,
    pub fps: f64,
    pub total_frames: u32,
}

/// Read video metadata (duration, fps, derived frame count) via the resolved FFmpeg/ffprobe.
pub fn read_media_metadata(
    path: &Path,
    ffmpeg_path: &Path,
) -> Result<MediaMetadata> {
    let meta = crate::video::read_video_metadata(path, ffmpeg_path)
        .map_err(|e| anyhow::anyhow!("Failed to read metadata: {}", e))?;
    let duration_secs = meta.duration_ms as f64 / 1000.0;
    let total_frames = (duration_secs * meta.fps).round() as u32;
    Ok(MediaMetadata {
        duration_ms: meta.duration_ms,
        fps: meta.fps,
        total_frames,
    })
}

/// Shared state for active FFmpeg transcode jobs, keyed by `job_id`.
pub type TranscodeProgressMap =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, TranscodeJobState>>>;

#[derive(Clone, Debug)]
pub struct TranscodeJobState {
    pub running: bool,
    pub percent: f32,
    pub fps: f32,
    pub x_speed: f32,
    pub out_time_ms: i64,
    pub output_path: Option<String>,
    pub error: Option<String>,
    /// Full FFmpeg command line, exposed for verbose logging.
    pub command: Option<String>,
    pub input_size_bytes: Option<u64>,
    pub output_size_bytes: Option<u64>,
    pub output_video_size_bytes: Option<u64>,
    pub output_audio_size_bytes: Option<u64>,
}

/// Spawn a task that parses FFmpeg `-progress pipe:` stdout key=value lines.
pub fn spawn_progress_reader<F>(
    stdout: tokio::process::ChildStdout,
    progress_map: TranscodeProgressMap,
    job_id: String,
    percent_fn: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(f32, i64, bool) -> f32 + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut fps: f32 = 0.0;
        let mut speed: f32 = 0.0;
        let mut out_time_us: u64 = 0;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("fps=") {
                fps = v.trim().parse().unwrap_or(fps);
            } else if let Some(v) = line.strip_prefix("speed=") {
                speed = v
                    .trim()
                    .trim_end_matches('x')
                    .parse()
                    .unwrap_or(speed);
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                out_time_us = v.trim().parse().unwrap_or(out_time_us);
            } else if line.starts_with("progress=") {
                let done = line.trim() == "progress=end";
                let out_time_ms = (out_time_us / 1000) as i64;
                let mut guard = progress_map.lock().await;
                if let Some(state) = guard.get_mut(&job_id) {
                    state.fps = fps;
                    state.x_speed = speed;
                    state.out_time_ms = out_time_ms;
                    state.percent = percent_fn(state.percent, out_time_ms, done);
                }
            }
        }
    })
}

/// Spawn a task that drains an FFmpeg stderr pipe, keeping the last 20 lines.
pub fn spawn_stderr_tail_drainer(
    stderr: tokio::process::ChildStderr,
) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if tail.len() >= 20 {
                tail.remove(0);
            }
            tail.push(line);
        }
        tail.join("\n")
    })
}

fn default_job_state(job_id: &str, output_path: String, input_size: Option<u64>) -> (String, TranscodeJobState) {
    (
        job_id.to_string(),
        TranscodeJobState {
            running: true,
            percent: 0.0,
            fps: 0.0,
            x_speed: 0.0,
            out_time_ms: 0,
            output_path: Some(output_path),
            error: None,
            command: None,
            input_size_bytes: input_size,
            output_size_bytes: None,
            output_video_size_bytes: None,
            output_audio_size_bytes: None,
        },
    )
}

fn transcode_encoder_args(
    target_format: &str,
    vcodec: Option<&str>,
    crf: Option<u32>,
    video_bitrate_kbps: Option<u32>,
    preset: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let codec = vcodec.unwrap_or(match target_format {
        "mp4" => "libx264",
        "webm" => "libvpx-vp9",
        other => other,
    });
    args.push("-c:v".into());
    args.push(codec.to_string());
    if codec != "copy" {
        if let Some(crf) = crf {
            args.push("-crf".into());
            args.push(crf.to_string());
        }
        if let Some(bitrate) = video_bitrate_kbps {
            args.push("-b:v".into());
            args.push(format!("{}k", bitrate));
            args.push("-maxrate".into());
            args.push(format!("{}k", (bitrate as f64 * 1.15).round() as u32));
            args.push("-bufsize".into());
            args.push(format!("{}k", bitrate * 2));
        }
        if let Some(p) = preset {
            args.push("-preset".into());
            args.push(p.to_string());
        }
    }
    args
}

fn probe_bitrate_overshoot(input_path: &Path, ffmpeg_path: &Path, video_kbps: u32, fps: f64, target_format: &str, probe_frames: usize) -> f64 {
    let temp_dir = std::env::temp_dir();
    let unique_id = uuid::Uuid::new_v4().to_string();
    let temp_file_path = temp_dir.join(format!("overshoot_probe_{}.mp4", unique_id));
    
    let status = std::process::Command::new(ffmpeg_path)
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-vframes")
        .arg(probe_frames.to_string())
        .arg("-c:v")
        .arg("libx264")
        .arg("-b:v")
        .arg(format!("{}k", video_kbps))
        .arg("-an")
        .arg(&temp_file_path)
        .status();
        
    let size = if let Ok(s) = status {
        if s.success() {
            std::fs::metadata(&temp_file_path).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        }
    } else {
        0
    };
    
    let _ = std::fs::remove_file(&temp_file_path);
    
    if size == 0 {
        1.0
    } else {
        let header_overhead = match target_format {
            "webm" => 4096.0,
            _ => 16384.0,
        };
        let raw_stream_size = (size as f64 - header_overhead).max(1024.0);
        let target_bytes = (video_kbps as f64 * 1000.0 / 8.0) * (probe_frames as f64 / fps);
        if target_bytes > 0.0 {
            (raw_stream_size / target_bytes).max(1.0)
        } else {
            1.0
        }
    }
}

fn tokenize_args(input: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' if in_double => {
                if let Some(&next) = chars.peek() {
                    current.push(next);
                    chars.next();
                } else {
                    current.push('\\');
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn build_custom_args(
    custom_args: &str,
    input_path: &str,
    output_path: &str,
) -> Result<Vec<String>, String> {
    let tokens = tokenize_args(custom_args);
    let mut expanded: Vec<String> = Vec::with_capacity(tokens.len());
    let mut has_input = false;
    let mut has_output = false;
    for token in tokens {
        match token.as_str() {
            "{input}" => {
                expanded.push(input_path.to_string());
                has_input = true;
            }
            "{output}" => {
                expanded.push(output_path.to_string());
                has_output = true;
            }
            other => expanded.push(other.to_string()),
        }
    }
    if !has_input {
        return Err("Custom command must contain the {input} placeholder for the source video".to_string());
    }
    if !has_output {
        return Err("Custom command must contain the {output} placeholder for the output file".to_string());
    }
    Ok(expanded)
}

#[derive(Debug, Clone, Default)]
pub struct TranscodeOptions {
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub crf: Option<u32>,
    pub video_bitrate: Option<u32>,
    pub preset: Option<String>,
    pub target_size_mb: Option<f64>,
    pub audio_bitrate: Option<u32>,
    pub mixdown: Option<String>,
    pub sample_rate: Option<u32>,
    pub custom_args: Option<String>,
}

/// Start an async FFmpeg transcode. Progress is streamed via `-progress pipe:1`
/// and recorded into `map` under `job_id`.
pub async fn start_transcode(
    job_id: &str,
    input_path: &str,
    output_path: &str,
    target_format: &str,
    opts: TranscodeOptions,
    ffmpeg_path: &Path,
    map: &TranscodeProgressMap,
) -> Result<()> {
    let TranscodeOptions {
        vcodec,
        acodec,
        crf,
        video_bitrate,
        preset,
        target_size_mb,
        audio_bitrate,
        mixdown,
        sample_rate,
        custom_args,
    } = opts;
    let input = Path::new(input_path);
    if !input.is_file() {
        anyhow::bail!("Input file not found: {}", input_path);
    }
    let output = Path::new(output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    let metadata = crate::video::read_video_metadata(input, ffmpeg_path)?;
    let total_duration_ms = metadata.duration_ms.max(1);
    let input_size = std::fs::metadata(input).map(|m| m.len()).ok();

    {
        let mut guard = map.lock().await;
        let (key, state) = default_job_state(job_id, output_path.to_string(), input_size);
        guard.insert(key, state);
    }

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-y");
    if let Some(ca) = custom_args {
        if ca.trim().is_empty() {
            anyhow::bail!("Custom command is empty");
        }
        let expanded = build_custom_args(&ca, input_path, output_path)
            .map_err(anyhow::Error::msg)?;
        cmd.args(expanded);
    } else {
        let mut calculated_video_bitrate = video_bitrate;
        let mut calculated_audio_bitrate = audio_bitrate;

        if let Some(budget_mb) = target_size_mb {
            let duration_ms = metadata.duration_ms.max(1000);
            let duration_secs = duration_ms as f64 / 1000.0;
            
            let fps = metadata.fps;
            let fps = if fps <= 0.0 || fps.is_nan() { 30.0 } else { fps };

            let has_audio = if let Some(ref ac) = acodec {
                ac != "none" && metadata.audio_codec.is_some()
            } else {
                metadata.audio_codec.is_some()
            };

            let sample_rate = metadata.sample_rate.unwrap_or(44100) as f64;
            let audio_packets_per_sec = match acodec.as_deref().unwrap_or("") {
                "libopus" | "opus" => 50.0,
                "libvorbis" | "vorbis" => 45.0,
                _ => sample_rate / 1024.0,
            };

            let container_overhead_bytes = match target_format {
                "webm" => {
                    let video_overhead = duration_secs * fps * 8.0;
                    let audio_overhead = if has_audio { duration_secs * audio_packets_per_sec * 6.0 } else { 0.0 };
                    let cluster_overhead = (duration_secs / 2.0).ceil() * 12.0;
                    video_overhead + audio_overhead + cluster_overhead + 4096.0
                }
                _ => {
                    let video_overhead = duration_secs * fps * 16.0;
                    let audio_overhead = if has_audio { duration_secs * audio_packets_per_sec * 16.0 } else { 0.0 };
                    video_overhead + audio_overhead + 16384.0
                }
            };

            let budget_bytes = budget_mb * 1024.0 * 1024.0;
            let available_payload_bytes = (budget_bytes * 0.90 - container_overhead_bytes).max(1024.0);

            let total_budget_bits = available_payload_bytes * 8.0;
            let total_bitrate_bps = total_budget_bits / duration_secs;
            let total_bitrate_kbps = (total_bitrate_bps / 1000.0) as u32;

            let audio_kbps = if !has_audio {
                0
            } else if let Some(ab) = audio_bitrate {
                ab
            } else {
                let probed_bps = metadata.audio_bitrate.unwrap_or(0);
                if probed_bps > 0 {
                    (probed_bps / 1000) as u32
                } else {
                    128
                }
            };

            let final_audio_kbps = if has_audio {
                if audio_kbps * 3 > total_bitrate_kbps {
                    (total_bitrate_kbps / 3).max(32)
                } else {
                    audio_kbps
                }
            } else {
                0
            };

            calculated_audio_bitrate = if has_audio { Some(final_audio_kbps) } else { None };

            let raw_video_kbps = if total_bitrate_kbps > final_audio_kbps {
                total_bitrate_kbps - final_audio_kbps
            } else {
                50
            };

            let total_frames = (duration_secs * fps).round() as usize;
            let probe_frames = total_frames.clamp(15, 100);

            let overshoot_factor = probe_bitrate_overshoot(input, ffmpeg_path, raw_video_kbps, fps, target_format, probe_frames);
            let final_video_kbps = (raw_video_kbps as f64 / overshoot_factor) as u32;

            calculated_video_bitrate = Some(final_video_kbps.max(50));
        }

        cmd.arg("-i")
            .arg(input_path)
            .args(transcode_encoder_args(
                target_format,
                vcodec.as_deref(),
                crf,
                calculated_video_bitrate,
                preset.as_deref(),
            ));

        let has_audio = if let Some(ref ac) = acodec {
            ac != "none"
        } else {
            true
        };

        if has_audio {
            if let Some(ref ac) = acodec {
                let mapped_ac = match ac.as_str() {
                    "vorbis" => "libvorbis",
                    other => other,
                };
                cmd.arg("-c:a").arg(mapped_ac);
            } else {
                cmd.arg("-c:a").arg(match target_format {
                    "webm" => "libopus",
                    _ => "aac",
                });
            }

            if acodec.as_deref() != Some("copy") {
                if let Some(ab) = calculated_audio_bitrate {
                    cmd.arg("-b:a").arg(format!("{}k", ab));
                }
            }

            if let Some(ref md) = mixdown {
                match md.as_str() {
                    "mono" => { cmd.arg("-ac").arg("1"); },
                    "stereo" => { cmd.arg("-ac").arg("2"); },
                    "5.1" => { cmd.arg("-ac").arg("6"); },
                    _ => {}
                }
            }

            if let Some(sr) = sample_rate {
                cmd.arg("-ar").arg(sr.to_string());
            }
        } else {
            cmd.arg("-an");
        }

        cmd.arg("-f").arg(target_format).arg(output_path);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let command_string = {
        let mut parts = vec![ffmpeg_path.display().to_string()];
        for arg in cmd.as_std().get_args() {
            parts.push(format!("{}", arg.to_string_lossy()));
        }
        parts.join(" ")
    };
    {
        let mut guard = map.lock().await;
        if let Some(state) = guard.get_mut(job_id) {
            state.command = Some(command_string);
        }
    }

    let mut child = cmd.spawn().context("Failed to spawn FFmpeg")?;
    let stdout = child.stdout.take().expect("ffmpeg stdout piped");
    let stderr = child.stderr.take().expect("ffmpeg stderr piped");
    let map_task = map.clone();
    let job_id_task = job_id.to_string();
    let total_task = total_duration_ms;

    let reader_task = spawn_progress_reader(
        stdout,
        map_task,
        job_id_task,
        move |_current, out_time_ms, done| {
            if done {
                100.0
            } else {
                ((out_time_ms as f64 / total_task as f64) * 100.0).clamp(0.0, 100.0) as f32
            }
        },
    );

    let stderr_task = spawn_stderr_tail_drainer(stderr);

    let map_fin = map.clone();
    let job_id_fin = job_id.to_string();
    let output_fin = output_path.to_string();
    let ffmpeg_path_clone = ffmpeg_path.to_path_buf();
    tokio::spawn(async move {
        let status = child.wait().await.context("FFmpeg process wait failed");
        let stderr_tail = stderr_task.await.unwrap_or_default();
        let _ = reader_task.await;

        let mut guard = map_fin.lock().await;
        if let Some(state) = guard.get_mut(&job_id_fin) {
            state.running = false;
            match status {
                Ok(s) if s.success() => {
                    state.percent = 100.0;
                    let out_path = std::path::Path::new(&output_fin);
                    if out_path.is_file() {
                        state.output_size_bytes = std::fs::metadata(out_path).map(|m| m.len()).ok();
                        if let Ok(out_meta) = crate::video::read_video_metadata(out_path, &ffmpeg_path_clone) {
                            let dur_secs = out_meta.duration_ms as f64 / 1000.0;
                            if dur_secs > 0.0 {
                                if let Some(v_bps) = out_meta.bitrate {
                                    state.output_video_size_bytes = Some((v_bps as f64 * dur_secs / 8.0) as u64);
                                }
                                if let Some(a_bps) = out_meta.audio_bitrate {
                                    state.output_audio_size_bytes = Some((a_bps as f64 * dur_secs / 8.0) as u64);
                                }
                            }
                        }
                    }
                }
                Ok(s) => {
                    state.error = Some(format!(
                        "FFmpeg exited with status: {}",
                        s
                    ));
                }
                Err(e) => {
                    state.error = Some(format!("{}", e));
                }
            }
            if state.error.is_some() && !stderr_tail.is_empty() {
                state.error = Some(format!("{}\n{}", state.error.clone().unwrap_or_default(), stderr_tail));
            }
            if state.error.is_some() {
                error!(
                    "Transcode job {} failed for {:?}: {:?}",
                    job_id_fin, output_fin, state.error
                );
            }
        }
    });

    info!("Transcode job {} started for {:?}", job_id, output_path);
    Ok(())
}

/// Poll the current state of a transcode job.
pub async fn get_transcode_progress(job_id: &str, map: &TranscodeProgressMap) -> TranscodeJobState {
    let guard = map.lock().await;
    match guard.get(job_id) {
        Some(state) => state.clone(),
        None => TranscodeJobState {
            running: false,
            percent: 0.0,
            fps: 0.0,
            x_speed: 0.0,
            out_time_ms: 0,
            output_path: None,
            error: Some("Unknown transcode job".to_string()),
            command: None,
            input_size_bytes: None,
            output_size_bytes: None,
            output_video_size_bytes: None,
            output_audio_size_bytes: None,
        },
    }
}
