use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::{info, warn};

/// Stream & container metadata for a video file, probed without decoding frames.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoInfo {
    pub format: String,
    pub duration_ms: i64,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub audio_bitrate: Option<i64>,
    pub sample_rate: Option<u32>,
    pub bitrate: Option<i64>,
    pub width: u32,
    pub height: u32,
}

/// Import-supported video extensions.
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm"];

/// True when the file is a supported video, detected by extension or magic
/// bytes (ISO BMFF `ftyp` for MP4, EBML `\x1a\x45\xdf\xa3` for WebM/Matroska).
pub fn is_video(path: &Path) -> bool {
    let ext_video = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("mp4") || s.eq_ignore_ascii_case("webm"))
        .unwrap_or(false);
    if ext_video {
        return true;
    }
    matches!(read_magic(path), Ok(true))
}

fn read_magic(path: &Path) -> Result<bool> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 8];
    let n = file.read(&mut buf)?;
    if n >= 4 {
        if &buf[4..8] == b"ftyp" {
            return Ok(true);
        }
        if n >= 4 && buf[0] == 0x1A && buf[1] == 0x45 && buf[2] == 0xDF && buf[3] == 0xA3 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ffmpeg_exe() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn ffprobe_exe() -> &'static str {
    if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    }
}

/// Resolve the FFmpeg executable with the project's fail-fast policy:
///  1. the explicitly configured path (validated), then
///  2. `<data_dir>/bin/ffmpeg(.exe)`, then
///  3. `ffmpeg(.exe)` on `PATH`.
/// Errors loudly when nothing resolves — never silently falls back.
pub fn resolve_ffmpeg_path(data_dir: &Path, explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
        warn!("Explicit ffmpeg path {:?} does not exist; falling through to auto-detect", p);
    }
    let bundled = data_dir.join("bin").join(ffmpeg_exe());
    if bundled.is_file() {
        return Ok(bundled);
    }
    if let Some(path) = which_ffmpeg() {
        return Ok(path);
    }
    bail!(
        "FFmpeg executable not found. Configure it in Settings → FFmpeg (auto-detect, custom path, or one-click download)."
    )
}

/// Search `PATH` for the FFmpeg executable.
fn which_ffmpeg() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(ffmpeg_exe());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Companion `ffprobe` binary next to the resolved ffmpeg (may not exist).
fn ffprobe_path(ffmpeg_path: &Path) -> PathBuf {
    ffmpeg_path.with_file_name(ffprobe_exe())
}

/// Run `ffmpeg -version` and return the first version line.
pub fn probe_ffmpeg_version(ffmpeg_path: &Path) -> Result<String> {
    let out = Command::new(ffmpeg_path)
        .arg("-version")
        .output()
        .with_context(|| format!("Failed to invoke ffmpeg at {:?}", ffmpeg_path))?;
    if !out.status.success() {
        bail!("ffmpeg -version exited with {}", out.status);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or("ffmpeg").trim().to_string())
}

// ── ffprobe JSON parsing ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ProbeOutput {
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}

#[derive(Deserialize, Default)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    sample_rate: Option<String>,
}

#[derive(Deserialize, Default)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
}

fn parse_ratio(s: &str) -> f64 {
    if let Some((num, den)) = s.split_once('/') {
        let n: f64 = num.trim().parse().unwrap_or(0.0);
        let d: f64 = den.trim().parse().unwrap_or(1.0);
        if d > 0.0 {
            return n / d;
        }
    }
    s.trim().parse().unwrap_or(0.0)
}

fn parse_secs_to_ms(s: &str) -> i64 {
    let secs: f64 = s.trim().parse().unwrap_or(0.0);
    (secs * 1000.0).round() as i64
}

fn probe_with_ffprobe(path: &Path, ffprobe: &Path) -> Result<VideoInfo> {
    let out = Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(path)
        .output()
        .with_context(|| format!("ffprobe failed for {:?}", path))?;
    if !out.status.success() {
        bail!(
            "ffprobe exited with {} for {:?}: {}",
            out.status,
            path,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let probe: ProbeOutput = serde_json::from_slice(&out.stdout)
        .with_context(|| format!("Cannot parse ffprobe JSON for {:?}", path))?;

    let video_stream = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    let audio_stream = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let Some(vs) = video_stream else {
        bail!("{:?} has no video stream", path);
    };

    let duration_src = vs
        .duration
        .as_deref()
        .or(probe.format.duration.as_deref())
        .unwrap_or("0");
    let fps_src = vs
        .avg_frame_rate
        .as_deref()
        .filter(|s| parse_ratio(s) > 0.0)
        .unwrap_or("0");
    let bitrate_src = vs
        .bit_rate
        .as_deref()
        .or(probe.format.bit_rate.as_deref());

    Ok(VideoInfo {
        format: probe
            .format
            .format_name
            .unwrap_or_default()
            .split(',')
            .next()
            .unwrap_or("")
            .to_string(),
        duration_ms: parse_secs_to_ms(duration_src),
        fps: parse_ratio(fps_src),
        video_codec: vs.codec_name.clone().unwrap_or_else(|| "unknown".into()),
        audio_codec: audio_stream.and_then(|s| s.codec_name.clone()),
        audio_bitrate: audio_stream
            .and_then(|s| s.bit_rate.as_deref())
            .and_then(|b| b.trim().parse::<i64>().ok()),
        sample_rate: audio_stream
            .and_then(|s| s.sample_rate.as_deref())
            .and_then(|sr| sr.trim().parse::<u32>().ok()),
        bitrate: bitrate_src.and_then(|b| b.trim().parse().ok()),
        width: vs.width.unwrap_or(0),
        height: vs.height.unwrap_or(0),
    })
}

/// Read video metadata from the file. Prefers `ffprobe` (json); falls back to
/// parsing `ffmpeg -i` stderr when `ffprobe` is unavailable next to ffmpeg.
pub fn read_video_metadata(path: &Path, ffmpeg_path: &Path) -> Result<VideoInfo> {
    let probe_bin = ffprobe_path(ffmpeg_path);
    if probe_bin.is_file() {
        return probe_with_ffprobe(path, &probe_bin);
    }
    info!(
        "ffprobe not found next to {:?}; parsing ffmpeg -i stderr for {:?}",
        ffmpeg_path, path
    );
    parse_ffmpeg_i_stderr(path, ffmpeg_path)
}

/// Fallback metadata parser for `ffmpeg -i <file>` stderr output.
fn parse_ffmpeg_i_stderr(path: &Path, ffmpeg_path: &Path) -> Result<VideoInfo> {
    let out = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-i")
        .arg(path)
        .output()
        .with_context(|| format!("Failed to invoke ffmpeg -i for {:?}", path))?;
    let text = String::from_utf8_lossy(&out.stderr).to_string();

    let format;
    let mut duration_ms: i64 = 0;
    let mut bitrate: Option<i64> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("Duration:") {
            let (dur, _rest) = rest.split_once(',').unwrap_or((rest, ""));
            if let Some((h, m, s)) = parse_duration_hms(dur) {
                duration_ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64;
            }
            let bits = rest
                .split("bitrate:")
                .nth(1)
                .and_then(|s| s.trim().split_whitespace().next())
                .and_then(|v| v.parse::<f64>().ok());
            if let Some(kb) = bits {
                bitrate = Some((kb * 1000.0) as i64);
            }
        }
        if let Some(rest) = t.strip_prefix("Stream #") {
            if let Some(v) = rest.find("Video:") {
                let after = &rest[v + "Video:".len()..];
                let codec = after
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .unwrap_or("unknown")
                    .to_string();
                format = codec.clone();
                // find resolution "1920x1080"
                let res = after
                    .split_whitespace()
                    .find_map(|tok| {
                        let (w, h) = tok.split_once('x')?;
                        let w: u32 = w.parse().ok()?;
                        let h: u32 = h.parse().ok()?;
                        Some((w, h))
                    })
                    .unwrap_or((0, 0));
                return Ok(VideoInfo {
                    format: if format.starts_with("vp9")
                        || format.starts_with("vp8")
                        || format.starts_with("av1")
                        || format.starts_with("h264")
                        || format.starts_with("hevc")
                        || format.starts_with("mpeg4")
                    {
                        // container-agnostic fallback guess
                        if format.starts_with("vp9")
                            || format.starts_with("vp8")
                            || format.starts_with("av1")
                        {
                            "webm".to_string()
                        } else {
                            "mp4".to_string()
                        }
                    } else {
                        format.clone()
                    },
                    duration_ms,
                    fps: 0.0,
                    video_codec: codec,
                    audio_codec: None,
                    audio_bitrate: None,
                    sample_rate: None,
                    bitrate,
                    width: res.0,
                    height: res.1,
                });
            }
        }
    }
    bail!("Could not parse video metadata for {:?}", path)
}

fn parse_duration_hms(s: &str) -> Option<(f64, f64, f64)> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    Some((h, m, sec))
}

// ── Frame extraction & preview generation ──────────────────────────────────

/// Extract a single frame at `timestamp_ms` as a decoded image via FFmpeg
/// (`image2pipe` PNG on stdout — no intermediate file on disk).
pub fn extract_video_frame(
    path: &Path,
    timestamp_ms: i64,
    ffmpeg_path: &Path,
) -> Result<image::DynamicImage> {
    let out = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-i")
        .arg(path)
        .arg("-frames:v")
        .arg("1")
        .arg("-f")
        .arg("image2pipe")
        .arg("-vcodec")
        .arg("png")
        .arg("-")
        .output()
        .with_context(|| format!("ffmpeg frame extraction failed for {:?}", path))?;
    if !out.status.success() {
        bail!(
            "ffmpeg frame extraction failed for {:?}: {}",
            path,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    image::load_from_memory(&out.stdout)
        .with_context(|| format!("Cannot decode extracted frame for {:?}", path))
}

/// Encode a decoded frame as PNG bytes (used for the persisted first-frame
/// cache that the AI pipeline reads back from disk).
pub fn frame_to_png_bytes(frame: &image::DynamicImage) -> Result<Vec<u8>> {
    let mut buf = Cursor::new(Vec::new());
    frame
        .write_to(&mut buf, image::ImageFormat::Png)
        .context("Failed to encode first frame as PNG")?;
    Ok(buf.into_inner())
}

/// SHA-256 of the extracted first-frame PNG bytes. Videos are deduplicated by
/// this hash (never by whole-file read, which would pull multi-GB files into
/// memory).
pub fn hash_first_frame(path: &Path, ffmpeg_path: &Path) -> Result<String> {
    let frame = extract_video_frame(path, 0, ffmpeg_path)?;
    let png = frame_to_png_bytes(&frame)?;
    use sha2::Digest;
    Ok(format!("{:x}", sha2::Sha256::digest(&png)))
}

/// Generate an animated WebP preview clip (short, low-fps, ~`width`px) used as
/// the grid thumbnail for videos. Bytes are written to a temp file by FFmpeg
/// and returned; the caller caches them in the thumbnail cache DB.
pub fn extract_video_preview(
    path: &Path,
    ffmpeg_path: &Path,
    width: u32,
    fps: u8,
    quality: u8,
) -> Result<Vec<u8>> {
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("curator_preview_{}.webp", uuid::Uuid::new_v4()));
    let out = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(path)
        .arg("-t")
        .arg("2")
        .arg("-an")
        .arg("-vf")
        .arg(format!("fps={},scale={}:-2", fps, width))
        .arg("-c:v")
        .arg("libwebp")
        .arg("-q:v")
        .arg(quality.to_string())
        .arg("-loop")
        .arg("0")
        .arg("-f")
        .arg("webp")
        .arg(&tmp_path)
        .output()
        .with_context(|| format!("ffmpeg animated preview failed for {:?}", path))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        bail!(
            "ffmpeg animated preview failed for {:?}: {}",
            path,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let bytes = std::fs::read(&tmp_path)
        .with_context(|| format!("Failed to read generated preview {:?}", tmp_path))?;
    let _ = std::fs::remove_file(&tmp_path);
    Ok(bytes)
}

/// The path a downstream decoder should read pixels from. Videos resolve to
/// their persisted extracted first frame; everything else uses the file itself.
/// When the frame is missing (e.g. corrupt extraction), the caller must fail
/// loudly rather than decode the raw container.
pub fn decode_path(current_filepath: &str, video_frame_path: Option<&str>) -> PathBuf {
    if let Some(fp) = video_frame_path {
        let p = Path::new(fp);
        if p.is_file() {
            return p.to_path_buf();
        }
    }
    PathBuf::from(current_filepath)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_video_by_extension() {
        assert!(is_video(Path::new("clip.mp4")));
        assert!(is_video(Path::new("clip.WEBM")));
        assert!(!is_video(Path::new("clip.png")));
    }

    #[test]
    fn is_video_by_magic_ftyp() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("clip");
        std::fs::write(&p, b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00").unwrap();
        assert!(is_video(&p));
    }

    #[test]
    fn is_video_by_magic_ebml() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("clip");
        std::fs::write(&p, [0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00]).unwrap();
        assert!(is_video(&p));
    }

    #[test]
    fn is_video_false_for_non_video() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("clip.bin");
        std::fs::write(&p, b"\x89PNG\r\n\x1a\nhello world").unwrap();
        assert!(!is_video(&p));
    }

    #[test]
    fn parse_ratio_handles_fraction_and_decimal() {
        assert_eq!(parse_ratio("30/1"), 30.0);
        assert_eq!(parse_ratio("0/0"), 0.0);
        assert!((parse_ratio("29.97") - 29.97).abs() < 1e-9);
    }

    #[test]
    fn parse_duration_hms_parses() {
        let (h, m, s) = parse_duration_hms("00:01:24.50").unwrap();
        assert_eq!(h, 0.0);
        assert_eq!(m, 1.0);
        assert!((s - 24.5).abs() < 1e-9);
    }

    #[test]
    fn decode_path_prefers_frame() {
        let dir = tempfile::tempdir().unwrap();
        let frame = dir.path().join("frame.png");
        std::fs::write(&frame, b"png").unwrap();
        let video = dir.path().join("v.mp4");
        std::fs::write(&video, b"video").unwrap();

        assert_eq!(
            decode_path(video.to_str().unwrap(), Some(frame.to_str().unwrap())),
            frame
        );
        // Non-existent frame path falls back to the video path.
        assert_eq!(
            decode_path(video.to_str().unwrap(), Some("C:/does-not-exist/v.png")),
            video
        );
        assert_eq!(
            decode_path(video.to_str().unwrap(), None),
            video
        );
    }
}
