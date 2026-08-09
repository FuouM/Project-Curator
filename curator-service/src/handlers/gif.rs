use anyhow::Context;

use std::fs;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::error;

use crate::handlers::transcode::{TranscodeProgressMap, TranscodeJobState};


/// Helper to set default job state in progress map
async fn start_job(job_id: &str, output_path: &str, progress_map: &TranscodeProgressMap) {
    let mut guard = progress_map.lock().await;
    guard.insert(job_id.to_string(), TranscodeJobState {
        running: true,
        percent: 0.0,
        fps: 0.0,
        x_speed: 0.0,
        out_time_ms: 0,
        output_path: Some(output_path.to_string()),
        error: None,
        command: None,
        input_size_bytes: None,
        output_size_bytes: None,
        output_video_size_bytes: None,
        output_audio_size_bytes: None,
    });
}

/// Run FFmpeg with standard progress tracking and update state in progress map
async fn run_ffmpeg_job(
    job_id: String,
    mut cmd: tokio::process::Command,
    output_path: String,
    progress_map: TranscodeProgressMap,
) -> anyhow::Result<()> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Extract command string for logging
    let command_string = {
        let mut parts = vec![cmd.as_std().get_program().to_string_lossy().to_string()];
        for arg in cmd.as_std().get_args() {
            parts.push(format!("{}", arg.to_string_lossy()));
        }
        parts.join(" ")
    };

    {
        let mut guard = progress_map.lock().await;
        if let Some(state) = guard.get_mut(&job_id) {
            state.command = Some(command_string);
        }
    }

    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
    }

    let mut child = cmd.spawn().context("Failed to spawn FFmpeg process")?;
    let stdout = child.stdout.take().expect("Failed to get FFmpeg stdout");
    let stderr = child.stderr.take().expect("Failed to get FFmpeg stderr");

    let progress_map_task = progress_map.clone();
    let job_id_task = job_id.clone();

    // Spawn stdout parser task
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut fps = 0.0;
        let mut speed = 0.0;
        let mut out_time_us = 0;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("fps=") {
                fps = v.trim().parse().unwrap_or(fps);
            } else if let Some(v) = line.strip_prefix("speed=") {
                speed = v.trim().trim_end_matches('x').parse().unwrap_or(speed);
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                out_time_us = v.trim().parse().unwrap_or(out_time_us);
            } else if line.starts_with("progress=") {
                let done = line.trim() == "progress=end";
                let mut guard = progress_map_task.lock().await;
                if let Some(state) = guard.get_mut(&job_id_task) {
                    state.fps = fps;
                    state.x_speed = speed;
                    state.out_time_ms = (out_time_us / 1000) as i64;
                    state.percent = if done { 100.0 } else { (state.percent + 2.0).min(99.0) };
                }
            }
        }
    });

    // Spawn stderr logger/drainer task
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if tail.len() >= 20 {
                tail.remove(0);
            }
            tail.push(line);
        }
        tail.join("\n")
    });

    let status = child.wait().await;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    let _ = reader_task.await;

    let mut guard = progress_map.lock().await;
    if let Some(state) = guard.get_mut(&job_id) {
        state.running = false;
        match status {
            Ok(s) if s.success() => {
                state.percent = 100.0;
                let path = Path::new(&output_path);
                if path.is_file() {
                    state.output_size_bytes = fs::metadata(path).map(|m| m.len()).ok();
                }
                Ok(())
            }
            Ok(s) => {
                let err_msg = format!("FFmpeg exited with error status: {:?}. Stderr tail: {}", s.code(), stderr_tail);
                state.error = Some(err_msg.clone());
                anyhow::bail!(err_msg)
            }
            Err(e) => {
                let err_msg = format!("FFmpeg wait failed: {:?}. Stderr tail: {}", e, stderr_tail);
                state.error = Some(err_msg.clone());
                anyhow::bail!(err_msg)
            }
        }
    } else {
        anyhow::bail!("Job missing in state progress map")
    }
}

/// Create a GIF or Video from multiple images (with custom delays)
pub async fn create_gif_from_images(
    job_id: String,
    image_pattern: String,
    frame_rate: f32,
    output_path: String,
    width: Option<u32>,
    height: Option<u32>,
    loop_count: Option<i32>,
    target_format: String,
    ffmpeg_path: &Path,
    progress_map: &TranscodeProgressMap,
) -> anyhow::Result<()> {
    if image_pattern.is_empty() {
        anyhow::bail!("No image sequence pattern provided");
    }

    start_job(&job_id, &output_path, progress_map).await;

    let fps = if frame_rate > 0.0 { frame_rate } else { 10.0 };

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-y")
        .arg("-framerate")
        .arg(fps.to_string())
        .arg("-f")
        .arg("image2")
        .arg("-i")
        .arg(&image_pattern);

    let mut filter_chain = String::new();
    if let (Some(w), Some(h)) = (width, height) {
        filter_chain.push_str(&format!("scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black", w, h, w, h));
    }

    let is_gif = target_format.to_lowercase() == "gif";

    if is_gif {
        let loop_val = loop_count.unwrap_or(0);
        if filter_chain.is_empty() {
            cmd.arg("-vf").arg("split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=floyd_steinberg");
        } else {
            cmd.arg("-vf").arg(format!("{},split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=floyd_steinberg", filter_chain));
        }
        cmd.arg("-loop").arg(loop_val.to_string());
    } else {
        if !filter_chain.is_empty() {
            cmd.arg("-vf").arg(filter_chain);
        }
        match target_format.to_lowercase().as_str() {
            "mp4" => { cmd.arg("-c:v").arg("libx264").arg("-pix_fmt").arg("yuv420p"); }
            "webp" => { cmd.arg("-c:v").arg("libwebp_anim").arg("-lossless").arg("1").arg("-loop").arg("0"); }
            _ => { cmd.arg("-c:v").arg("libvpx-vp9").arg("-pix_fmt").arg("yuv420p"); }
        }
    }

    cmd.arg(&output_path);

    let progress_map_clone = progress_map.clone();
    let output_path_clone = output_path.clone();

    tokio::spawn(async move {
        if let Err(e) = run_ffmpeg_job(job_id, cmd, output_path_clone, progress_map_clone).await {
            error!("Image-sequence compile job failed: {:?}", e);
        }
    });

    Ok(())
}

/// Apply editing, captions, and effects to a GIF or Video
pub async fn process_gif_effects(
    job_id: String,
    input_path: String,
    output_path: String,
    crop: Option<String>,
    scale: Option<String>,
    speed_multiplier: Option<f32>,
    reverse: bool,
    bounce: bool,
    rotate: Option<String>,
    brightness: Option<f32>,
    contrast: Option<f32>,
    saturation: Option<f32>,
    grayscale: bool,
    invert: bool,
    caption_image_base64: Option<String>,
    caption_image_height: Option<u32>,
    caption_style: Option<String>,
    max_colors: Option<u32>,
    dither_type: Option<String>,
    drop_frames_factor: Option<u32>,
    target_format: String,
    loop_count: Option<i32>,
    fps: Option<u32>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    _data_dir: &Path,
    ffmpeg_path: &Path,
    progress_map: &TranscodeProgressMap,
) -> anyhow::Result<()> {
    if !Path::new(&input_path).is_file() {
        anyhow::bail!("Input file not found: {}", input_path);
    }

    start_job(&job_id, &output_path, progress_map).await;

    let mut caption_file: Option<PathBuf> = None;
    let mut caption_height = 0u32;

    if let Some(ref base64_str) = caption_image_base64 {
        if !base64_str.trim().is_empty() {
            let clean_base64 = if let Some(pos) = base64_str.find(",") {
                &base64_str[pos + 1..]
            } else {
                base64_str
            };

            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(clean_base64) {
                Ok(bytes) => {
                    let temp_file_path = std::env::temp_dir().join(format!("caption_{}.png", job_id));
                    if let Ok(_) = std::fs::write(&temp_file_path, bytes) {
                        caption_file = Some(temp_file_path);
                        caption_height = caption_image_height.unwrap_or(0);
                    } else {
                        error!("Failed to write decoded caption bytes to file");
                    }
                }
                Err(e) => {
                    error!("Failed to decode base64 caption image: {:?}", e);
                }
            }
        }
    }

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-y");

    if let Some(start) = trim_start {
        cmd.arg("-ss").arg(start.to_string());
    }
    if let Some(end) = trim_end {
        if let Some(start) = trim_start {
            cmd.arg("-t").arg((end - start).to_string());
        } else {
            cmd.arg("-t").arg(end.to_string());
        }
    }

    cmd.arg("-i").arg(&input_path);

    if let Some(ref cap) = caption_file {
        cmd.arg("-i").arg(cap);
    }

    let mut filters = Vec::new();
    let mut last_stream = "[0:v]".to_string();

    if let Some(ref c) = crop {
        if !c.trim().is_empty() {
            let next = "[v_cropped]".to_string();
            filters.push(format!("{}crop={}{}", last_stream, c, next));
            last_stream = next;
        }
    }

    if let Some(ref s) = scale {
        if !s.trim().is_empty() {
            let next = "[v_scaled]".to_string();
            filters.push(format!("{}scale={}{}", last_stream, s, next));
            last_stream = next;
        }
    }

    if let Some(factor) = drop_frames_factor {
        if factor > 1 {
            let next = "[v_dropped]".to_string();
            filters.push(format!("{}select=not(mod(n\\,{})){}", last_stream, factor, next));
            last_stream = next;
        }
    }

    let mut color_filters = Vec::new();
    if grayscale {
        color_filters.push("format=gray".to_string());
    }
    if invert {
        color_filters.push("negate".to_string());
    }
    if brightness.is_some() || contrast.is_some() || saturation.is_some() {
        let b = brightness.unwrap_or(0.0);
        let c = contrast.unwrap_or(1.0);
        let s = saturation.unwrap_or(1.0);
        color_filters.push(format!("eq=brightness={}:contrast={}:saturation={}", b, c, s));
    }
    if !color_filters.is_empty() {
        let next = "[v_colors]".to_string();
        filters.push(format!("{}{}{}", last_stream, color_filters.join(","), next));
        last_stream = next;
    }

    if let Some(ref r) = rotate {
        let trans = match r.as_str() {
            "90_cw" => Some("transpose=1"),
            "90_ccw" => Some("transpose=2"),
            "180" => Some("transpose=1,transpose=1"),
            "hflip" => Some("hflip"),
            "vflip" => Some("vflip"),
            _ => None,
        };
        if let Some(t) = trans {
            let next = "[v_rotated]".to_string();
            filters.push(format!("{}{}{}", last_stream, t, next));
            last_stream = next;
        }
    }

    if reverse && !bounce {
        let next = "[v_reversed]".to_string();
        filters.push(format!("{}reverse{}", last_stream, next));
        last_stream = next;
    }

    if bounce {
        let next = "[v_bounced]".to_string();
        filters.push(format!("{}split[f][r];[r]reverse[rev];[f][rev]concat=n=2:v=1:a=0{}", last_stream, next));
        last_stream = next;
    }

    if let Some(m) = speed_multiplier {
        if (m - 1.0).abs() > 0.01 && m > 0.05 {
            let next = "[v_speed]".to_string();
            filters.push(format!("{}setpts={}*PTS{}", last_stream, 1.0 / m, next));
            last_stream = next;
        }
    }

    if caption_file.is_some() {
        let style_str = caption_style.as_deref().unwrap_or("ifunny");
        let next = "[v_captioned]".to_string();
        if style_str == "ifunny" {
            filters.push(format!(
                "{}pad=iw:ih+{}:0:{}:color=white[pad];[pad][1:v]overlay=0:0{}",
                last_stream, caption_height, caption_height, next
            ));
        } else if style_str == "overlay_top" {
            filters.push(format!(
                "{}[1:v]overlay=0:20{}",
                last_stream, next
            ));
        } else if style_str == "overlay_center" {
            filters.push(format!(
                "{}[1:v]overlay=0:(main_h-overlay_h)/2{}",
                last_stream, next
            ));
        } else {
            filters.push(format!(
                "{}[1:v]overlay=0:main_h-overlay_h-20{}",
                last_stream, next
            ));
        }
        last_stream = next;
    }

    if let Some(fps_val) = fps {
        let next = "[v_fps]".to_string();
        filters.push(format!("{}fps={}{}", last_stream, fps_val, next));
        last_stream = next;
    }

    let is_gif = target_format.to_lowercase() == "gif";

    if is_gif {
        let max_c = max_colors.unwrap_or(256);
        let dither = dither_type.as_deref().unwrap_or("floyd_steinberg");
        filters.push(format!(
            "{}split[s0][s1];[s0]palettegen=stats_mode=full:max_colors={}[p];[s1][p]paletteuse=dither={}",
            last_stream, max_c, dither
        ));
    }

    if !filters.is_empty() {
        cmd.arg("-filter_complex").arg(filters.join(";"));
        // For GIF: the palettegen/paletteuse chain consumes the last labelled stream and
        // produces an implicit output — adding -map would reference a now-consumed label.
        // For other formats: -map the final labelled stream explicitly.
        if !is_gif && last_stream != "[0:v]" {
            cmd.arg("-map").arg(&last_stream);
        }
    }

    if is_gif {
        let loop_val = loop_count.unwrap_or(0);
        cmd.arg("-loop").arg(loop_val.to_string());
    }

    if !is_gif {
        match target_format.to_lowercase().as_str() {
            "mp4" => { cmd.arg("-c:v").arg("libx264").arg("-pix_fmt").arg("yuv420p"); }
            "webp" => { cmd.arg("-c:v").arg("libwebp_anim").arg("-lossless").arg("1").arg("-loop").arg("0"); }
            _ => { cmd.arg("-c:v").arg("libvpx-vp9").arg("-pix_fmt").arg("yuv420p"); }
        }
    }

    cmd.arg(&output_path);

    let progress_map_clone = progress_map.clone();
    let output_path_clone = output_path.clone();

    tokio::spawn(async move {
        let res = run_ffmpeg_job(job_id, cmd, output_path_clone, progress_map_clone).await;
        if let Some(cap) = caption_file {
            let _ = fs::remove_file(cap);
        }
        if let Err(e) = res {
            error!("GIF/video effects processing job failed: {:?}", e);
        }
    });

    Ok(())
}

/// Split GIF frames into target directory
pub async fn split_gif(
    job_id: String,
    input_path: String,
    output_dir: String,
    ffmpeg_path: &Path,
    progress_map: &TranscodeProgressMap,
) -> anyhow::Result<()> {
    if !Path::new(&input_path).is_file() {
        anyhow::bail!("Input file not found: {}", input_path);
    }
    
    let dest_dir = Path::new(&output_dir);
    fs::create_dir_all(dest_dir)?;

    start_job(&job_id, &output_dir, progress_map).await;

    let output_pattern = dest_dir.join("frame_%04d.png");

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-y")
        .arg("-i")
        .arg(&input_path)
        .arg("-fps_mode")
        .arg("passthrough")
        .arg(&output_pattern);

    let progress_map_clone = progress_map.clone();
    tokio::spawn(async move {
        let res = run_ffmpeg_job(job_id, cmd, output_dir, progress_map_clone).await;
        if let Err(e) = res {
            error!("GIF split job failed: {:?}", e);
        }
    });

    Ok(())
}
