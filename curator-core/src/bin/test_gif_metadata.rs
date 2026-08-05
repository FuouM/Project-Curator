//! Standalone verification binary for GIF animation metadata extraction.
//!
//! Hand-builds minimal GIF byte fixtures (per the GIF89a spec) with known
//! frame counts, per-frame delays, and Netscape loop counts, then verifies
//! `curator_core::media` extracts them exactly.
//!
//! Run: `cargo run -p curator-core --bin test_gif_metadata`

use curator_core::media::{is_gif, read_dimensions, read_gif_animation};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn build_gif(frame_count: usize, loop_ext: Option<u16>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"GIF89a");
    out.extend_from_slice(&[0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
    if let Some(repeat) = loop_ext {
        out.extend_from_slice(&[0x21, 0xFF]);
        out.push(11);
        out.extend_from_slice(b"NETSCAPE2.0");
        out.push(3);
        out.push(0x01);
        out.extend_from_slice(&repeat.to_le_bytes());
        out.push(0);
    }
    for i in 0..frame_count {
        let delay_cs = (10 + i as u16 * 5) as u8;
        out.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, delay_cs, 0x00, 0x00, 0x00]);
        out.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x10, 0x00, 0x08, 0x00, 0x00]);
        out.push(2);
        out.push(0x02);
        out.extend_from_slice(&[0x44, 0x01, 0x00]);
    }
    out.push(0x3B);
    out
}

fn check(name: &str, ok: bool, detail: &str) {
    println!("[{}] {}: {}", if ok { "PASS" } else { "FAIL" }, name, detail);
    assert!(ok, "FAILED: {name} ({detail})");
}

fn main() {
    let dir = std::env::temp_dir().join(format!(
        "test_gif_metadata_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();

    fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    let single = write_fixture(&dir, "single.gif", &build_gif(1, None));
    let info = read_gif_animation(&single).unwrap();
    check("single frame count", info.frame_count == 1, &format!("got {}", info.frame_count));
    check("single duration", info.duration_ms == 100, &format!("got {}", info.duration_ms));
    check("single loop absent", info.loop_count.is_none(), "expected None");

    let (w, h) = read_dimensions(&single).unwrap();
    check("dimensions", w == 16 && h == 8, &format!("got {w}x{h}"));
    check("is_gif magic", is_gif(&single), "expected true");

    let multi = write_fixture(&dir, "multi.gif", &build_gif(4, Some(0)));
    let info2 = read_gif_animation(&multi).unwrap();
    check("multi frame count", info2.frame_count == 4, &format!("got {}", info2.frame_count));
    let expected_duration: i64 = (0..4).map(|i| (10 + i * 5) as i64 * 10).sum();
    check(
        "multi duration sum",
        info2.duration_ms == expected_duration,
        &format!("got {} expected {}", info2.duration_ms, expected_duration),
    );
    check("multi infinite loop", info2.loop_count == Some(0), "expected Some(0)");

    let loop3 = write_fixture(&dir, "loop3.gif", &build_gif(2, Some(3)));
    let info3 = read_gif_animation(&loop3).unwrap();
    check("loop count 3", info3.loop_count == Some(3), "expected Some(3)");

    let not_gif = write_fixture(&dir, "not_gif.bin", b"this is not a gif");
    check("non-gif rejected", read_gif_animation(&not_gif).is_err(), "expected error");

    let _ = fs::remove_dir_all(&dir);
    println!("All GIF metadata checks passed.");
}
