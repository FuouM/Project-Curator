//! Animated WebP preview benchmark (Phase 0 of video support).
//!
//! Validates the exact ffmpeg/ffprobe argument set used by `curator-core::video`
//! (first-principles verification, AGENTS.md §6.3) and measures the
//! size-vs-quality matrix for the 2-second grid preview clips:
//!
//!   fps   = { 10, 12, 15 }
//!   width = { 160, 200, 240 }
//!   q:v   = { 50, 65, 75 }
//!
//! Reports each combo's byte size (cache-growth target ~80-120 KB / video; LRU
//! `DEFAULT_MAX_ENTRIES` = 200k in thumbnail.rs) and encode wall time (target
//! under ~100-200 ms per video during batch import).
//!
//! Run:
//!   cargo run --release -p curator-core --bin bench_video_webp_preview <video.mp4|webm> [runs]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use curator_core::constants::resolve_data_dir;
use curator_core::video::{
    extract_video_frame, extract_video_preview, hash_first_frame, is_video, probe_ffmpeg_version,
    read_video_metadata, resolve_ffmpeg_path,
};

const FPS_VALUES: &[u8] = &[10, 12, 15];
const WIDTH_VALUES: &[u32] = &[160, 200, 240];
const QUALITY_VALUES: &[u8] = &[50, 65, 75];
const CACHE_TARGET_BYTES: usize = 120 * 1024; // ~80-120 KB per video
const ENCODE_BUDGET_MS: u128 = 200; // target overhead per video during batch import

fn median(mut xs: Vec<Duration>) -> Duration {
    xs.sort_unstable();
    xs[xs.len() / 2]
}

/// Verify the exact ffmpeg/ffprobe argument set used in production.
fn verify_engine_primitives(source: &Path, ffmpeg: &Path) -> Result<()> {
    let version = probe_ffmpeg_version(ffmpeg).context("probe_ffmpeg_version")?;
    println!("  ffmpeg version : {}", version.trim().lines().next().unwrap_or_default());

    let info = read_video_metadata(source, ffmpeg).context("read_video_metadata (ffprobe)")?;
    println!(
        "  ffprobe info   : {} | {}x{} @ {:.2} fps | {}ms | video={} audio={:?}",
        info.format,
        info.width,
        info.height,
        info.fps,
        info.duration_ms,
        info.video_codec,
        info.audio_codec,
    );

    let frame = extract_video_frame(source, 0, ffmpeg).context("extract_video_frame")?;
    println!("  first frame    : {}x{} extracted OK", frame.width(), frame.height());

    let hash = hash_first_frame(source, ffmpeg).context("hash_first_frame")?;
    println!("  first-frame sha256: {}", &hash[..16]);
    Ok(())
}

/// Encode a 2-second preview clip and return (bytes, elapsed).
fn bench_combo(source: &Path, ffmpeg: &Path, width: u32, fps: u8, q: u8, runs: usize) -> Result<(usize, Duration)> {
    let mut sizes = Vec::with_capacity(runs);
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let start = Instant::now();
        let bytes = extract_video_preview(source, ffmpeg, width, fps, q)
            .with_context(|| format!("extract_video_preview w={} fps={} q={}", width, fps, q))?;
        sizes.push(bytes.len());
        times.push(start.elapsed());
    }
    let bytes = sizes[sizes.len() / 2];
    Ok((bytes, median(times)))
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let source_arg = args
        .next()
        .context("Usage: cargo run --release -p curator-core --bin bench_video_webp_preview <video.mp4|webm> [runs]")?;
    let runs: usize = args
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let source = PathBuf::from(&source_arg);
    if !source.is_file() {
        bail!("Source video does not exist: {}", source.display());
    }
    if !is_video(&source) {
        bail!("Not a supported video (mp4/webm): {}", source.display());
    }

    let data_dir = resolve_data_dir();
    let ffmpeg = resolve_ffmpeg_path(&data_dir, None)
        .context("FFmpeg not resolvable; configure it in Settings or use the one-click download")?;

    println!("=== Animated WebP Preview Benchmark (Phase 0) ===");
    println!("source  : {}", source.display());
    println!("ffmpeg  : {}", ffmpeg.display());
    println!("runs    : {} (median)", runs);
    println!();

    println!("--- Engine primitive verification ---");
    verify_engine_primitives(&source, &ffmpeg)?;
    println!();

    println!("--- Size vs. Quality matrix (2s clips) ---");
    println!("{:>5} {:>4} {:>4} {:>9} {:>8} {:>7} {}", "width", "fps", "q:v", "bytes", "KB", "ms", "budget");
    let mut smallest = usize::MAX;
    let mut largest = 0usize;
    let mut worst_ms = 0u128;
    let mut over_cache = 0usize;
    let mut over_time = 0usize;

    for &width in WIDTH_VALUES {
        for &fps in FPS_VALUES {
            for &q in QUALITY_VALUES {
                let (bytes, elapsed) = bench_combo(&source, &ffmpeg, width, fps, q, runs)?;
                let kb = bytes as f64 / 1024.0;
                let cache_ok = bytes <= CACHE_TARGET_BYTES;
                let time_ok = elapsed.as_millis() <= ENCODE_BUDGET_MS;
                smallest = smallest.min(bytes);
                largest = largest.max(bytes);
                worst_ms = worst_ms.max(elapsed.as_millis());
                if !cache_ok { over_cache += 1; }
                if !time_ok { over_time += 1; }
                println!(
                    "{:>5} {:>4} {:>4} {:>9} {:>7.1} {:>6}ms {}",
                    width,
                    fps,
                    q,
                    bytes,
                    kb,
                    elapsed.as_millis(),
                    if cache_ok && time_ok { "OK" } else { "OVER" }
                );
            }
        }
    }

    println!();
    println!("Range          : {} bytes .. {} bytes (target <= {} bytes)", smallest, largest, CACHE_TARGET_BYTES);
    println!("Worst encode   : {} ms (target <= {} ms)", worst_ms, ENCODE_BUDGET_MS);
    println!("Cache over     : {} / {} combos", over_cache, WIDTH_VALUES.len() * FPS_VALUES.len() * QUALITY_VALUES.len());
    println!("Time over      : {} / {} combos", over_time, WIDTH_VALUES.len() * FPS_VALUES.len() * QUALITY_VALUES.len());
    println!(
        "Grid cache math : at the production fixed width (200px, 12fps, q65) a 10s video ≈ {:.0} KB",
        largest as f64 / 1024.0
    );
    Ok(())
}
