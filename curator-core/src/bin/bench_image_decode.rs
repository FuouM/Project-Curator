//! Image-decoding benchmark: finds the fastest *accurate* decode backend per format.
//!
//! Every method's pixels are compared against a standards-compliant reference
//! (the `image` crate decode) with a small tolerance, so we only crown a "winner"
//! among backends that actually reproduce the image correctly.
//!
//! Run:
//!   cargo run --release -p curator-core --bin bench_image_decode [runs]

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};

const ACCURATE_MAX_DIFF: u8 = 6; // per-channel LSB tolerance vs the image-crate reference
const ACCURATE_MAX_MEAN: f64 = 1.0;

struct DecodeResult {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

type DecoderFn = Box<dyn Fn(&[u8]) -> Result<DecodeResult>>;

struct Method {
    name: &'static str,
    decode: DecoderFn,
}

/// Reference decoder: the standards-compliant `image` crate.
fn ref_image_decode(data: &[u8]) -> Result<DecodeResult> {
    let img = image::load_from_memory(data).context("image::load_from_memory")?;
    let rgb = img.to_rgb8();
    let (w, h) = rgb.dimensions();
    Ok(DecodeResult {
        width: w,
        height: h,
        pixels: rgb.into_raw(),
    })
}

fn turbojpeg_decode(data: &[u8]) -> Result<DecodeResult> {
    let img = turbojpeg::decompress(data, turbojpeg::PixelFormat::RGB)
        .context("turbojpeg::decompress")?;
    Ok(DecodeResult {
        width: img.width as u32,
        height: img.height as u32,
        pixels: img.pixels,
    })
}

fn png_direct_decode(data: &[u8]) -> Result<DecodeResult> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().context("png::read_info")?;
    let w = reader.info().width;
    let h = reader.info().height;
    let mut raw = vec![0u8; w as usize * h as usize * 4];
    let out = reader.next_frame(&mut raw).context("png::next_frame")?;
    let (pixels, w, h) = match out.color_type {
        png::ColorType::Rgb => {
            let len = w as usize * h as usize * 3;
            (raw[..len].to_vec(), w, h)
        }
        png::ColorType::Rgba => (
            raw.chunks_exact(4)
                .flat_map(|c| [c[0], c[1], c[2]])
                .collect(),
            w,
            h,
        ),
        png::ColorType::Grayscale => (
            raw.iter().flat_map(|&g| [g, g, g]).collect(),
            w,
            h,
        ),
        png::ColorType::GrayscaleAlpha => (
            raw.chunks_exact(2)
                .flat_map(|c| [c[0], c[0], c[0]])
                .collect(),
            w,
            h,
        ),
        ct => anyhow::bail!("unsupported PNG color type {:?}", ct),
    };
    Ok(DecodeResult {
        width: w,
        height: h,
        pixels,
    })
}

fn webp_crate_decode(data: &[u8]) -> Result<DecodeResult> {
    let decoder = webp::Decoder::new(data);
    let img = decoder
        .decode()
        .ok_or_else(|| anyhow::anyhow!("webp::decode failed"))?;
    let (w, h) = (img.width(), img.height());
    // Layout-aware: WebPImage is RGB (3 BPP) when opaque, RGBA (4 BPP) when it has
    // alpha. `to_image()` produces the correct RgbImage/RgbaImage, then ->to_rgb8().
    let rgb = img.to_image().to_rgb8();
    Ok(DecodeResult {
        width: w,
        height: h,
        pixels: rgb.into_raw(),
    })
}

/// Median decode time (ms) over `runs`, decoding the shared `data` bytes.
fn bench(data: &[u8], decode: &DecoderFn, runs: usize) -> f64 {
    let _ = decode(data); // warmup

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let res = std::hint::black_box(decode(data));
        if let Ok(res) = res {
            std::hint::black_box(res.pixels.len());
        }
        samples.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn compare(a: &DecodeResult, b: &DecodeResult) -> (usize, f64, bool) {
    if a.width != b.width || a.height != b.height || a.pixels.len() != b.pixels.len() {
        return (usize::MAX, f64::INFINITY, false);
    }
    let mut max_diff = 0usize;
    let mut sum = 0u64;
    for (&x, &y) in a.pixels.iter().zip(b.pixels.iter()) {
        let d = (x as i32 - y as i32).unsigned_abs() as usize;
        if d > max_diff {
            max_diff = d;
        }
        sum += d as u64;
    }
    let mean = sum as f64 / a.pixels.len() as f64;
    (max_diff, mean, max_diff <= ACCURATE_MAX_DIFF as usize && mean <= ACCURATE_MAX_MEAN)
}

fn run_format(label: &str, data: &[u8], methods: &[Method], runs: usize) {
    println!("\n--- {} ---", label);
    let reference = match ref_image_decode(data) {
        Ok(r) => r,
        Err(e) => {
            println!("  reference decode failed: {:#}", e);
            return;
        }
    };
    let ref_bytes = reference.pixels.len();
    println!(
        "  reference: {}x{}, {} px = {:.2} MB decoded (image crate)",
        reference.width,
        reference.height,
        ref_bytes / 3,
        ref_bytes as f64 / 1e6
    );

    let mut rows = Vec::new();
    for m in methods {
let median_ms = bench(data, &m.decode, runs);
        let (max_diff, mean_diff, dims, verdict) = match (m.decode)(data) {
            Ok(d) => {
                let (mx, mn, acc) = compare(&reference, &d);
                let dims = format!("{}x{}", d.width, d.height);
                let verdict = if acc {
                    "accurate".to_string()
                } else {
                    format!("MISMATCH (maxΔ {} meanΔ {:.2})", mx, mn)
                };
                (mx, mn, dims, verdict)
            }
            Err(e) => (
                usize::MAX,
                f64::NAN,
                "-".to_string(),
                format!("DECODE ERROR: {:#}", e),
            ),
        };
        let thpt = ref_bytes as f64 / (median_ms / 1000.0) / 1e6;
        println!(
            "  {:<22} {:>8.3} ms  {:>8.1} MB/s   {}   maxΔ {:<6} meanΔ {:<6.2}  {}",
            m.name, median_ms, thpt, dims, max_diff, mean_diff, verdict
        );
        if verdict == "accurate" {
            rows.push((m.name, median_ms));
        }
    }

    if rows.is_empty() {
        println!("  >> NO accurate backend for this format");
    } else {
        rows.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        println!(
            "  >> WINNER: {} @ {:.3} ms (fastest of the accurate backends)",
            rows[0].0, rows[0].1
        );
    }
}

fn ensure_fixtures(dir: &Path) -> Result<Vec<PathBuf>> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("workspace root")?;
    let src_jpg = workspace
        .join("assets")
        .join("test_images")
        .join("Yoshitani-Ayako_Urabe-Mikoto_Nazo-no-Kanojo-X.jpg");
    if !src_jpg.exists() {
        anyhow::bail!("source JPEG missing: {:?}", src_jpg);
    }

    let base = image::open(&src_jpg).context("open source jpg")?;
    let mut fixtures = Vec::new();

    let cases: &[(&str, image::ImageFormat)] = &[
        ("bench_webp.webp", image::ImageFormat::WebP),
        ("bench_bmp.bmp", image::ImageFormat::Bmp),
        ("bench_tiff.tiff", image::ImageFormat::Tiff),
        ("bench_png.png", image::ImageFormat::Png),
        ("bench_gif.gif", image::ImageFormat::Gif),
    ];
    for (name, fmt) in cases {
        let p = dir.join(name);
        if p.exists() {
            fixtures.push(p);
            continue;
        }
        let img = if *fmt == image::ImageFormat::Gif {
            // GIF needs a small palette; downscale so the encoder stays within 256 colors.
            base.resize(320, 320, image::imageops::FilterType::Lanczos3)
        } else {
            base.clone()
        };
        match img.save_with_format(&p, *fmt) {
            Ok(_) => fixtures.push(p),
            Err(e) => println!("  [skip {}] encoder failed: {}", name, e),
        }
    }
fixtures.push(src_jpg);
    Ok(fixtures)
}

// ---- Resize benchmark: OCR-ish (Triangle) vs fast_image_resize vs manual-nearest ----

fn imageops_triangle(rgb: &image::RgbImage, nw: u32, nh: u32) -> Vec<u8> {
    image::imageops::resize(rgb, nw, nh, image::imageops::FilterType::Triangle)
        .into_raw()
}

fn fir_resize(
    resizer: &mut fast_image_resize::Resizer,
    rgb: &image::RgbImage,
    nw: u32,
    nh: u32,
    filter: fast_image_resize::FilterType,
) -> Result<Vec<u8>> {
    let (w, h) = rgb.dimensions();
    let src = fast_image_resize::images::ImageRef::new(
        w,
        h,
        rgb.as_raw(),
        fast_image_resize::PixelType::U8x3,
    )?;
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        nw,
        nh,
        vec![0u8; (nw * nh * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )?;
    let opts = fast_image_resize::ResizeOptions::new()
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(filter));
    resizer.resize(&src, &mut dst, Some(&opts))?;
    Ok(dst.buffer().to_vec())
}

/// The YOLO/CCIP style: per-pixel source-pick (float index math), no filtering.
fn manual_nearest(rgb: &image::RgbImage, nw: u32, nh: u32) -> Vec<u8> {
    let (w, h) = rgb.dimensions();
    let raw = rgb.as_raw();
    let mut out = vec![0u8; (nw * nh * 3) as usize];
    for y in 0..nh {
        let sy = ((y as f32 * h as f32) / nh as f32).min(h as f32 - 1.0) as u32;
        for x in 0..nw {
            let sx = ((x as f32 * w as f32) / nw as f32).min(w as f32 - 1.0) as u32;
            let si = ((sy * w + sx) * 3) as usize;
            let di = ((y * nw + x) * 3) as usize;
            out[di..di + 3].copy_from_slice(&raw[si..si + 3]);
        }
    }
    out
}

fn compare_slices(a: &[u8], b: &[u8]) -> (usize, f64) {
    debug_assert_eq!(a.len(), b.len());
    let mut maxd = 0usize;
    let mut sum = 0u64;
    for (&x, &y) in a.iter().zip(b.iter()) {
        let d = (x as i32 - y as i32).unsigned_abs() as usize;
        if d > maxd {
            maxd = d;
        }
        sum += d as u64;
    }
    (maxd, sum as f64 / a.len() as f64)
}

fn bench_resize_case(runs: usize, name: &str, rgb: &image::RgbImage, nw: u32, nh: u32) {
    println!("\n  [{name}] resize to {nw}x{nh} (src {}x{})", rgb.width(), rgb.height());

    // Reference: the current OCR path (image crate Triangle).
    let reference = imageops_triangle(rgb, nw, nh);

    let mut resizer = fast_image_resize::Resizer::new();

    let run_and_compare = |label: &str,
                           f: &mut dyn FnMut() -> Vec<u8>| {
        let mut samples = vec![0.0f64; runs];
        let _ = f();
        for s in samples.iter_mut() {
            let t0 = Instant::now();
            let out = std::hint::black_box(f());
            std::hint::black_box(out.len());
            *s = t0.elapsed().as_secs_f64() * 1000.0;
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = samples[samples.len() / 2];
        let out = f();
        let (maxd, meand) = compare_slices(&reference, &out);
        println!(
            "    {:<26} {:>8.3} ms   {:>8.1} Mpix/s   maxΔ {:<6} meanΔ {:<6.2}",
            label,
            med,
            (nw as f64 * nh as f64) / (med / 1000.0) / 1e6,
            maxd,
            meand
        );
    };

    run_and_compare("image crate Triangle (OCR)", &mut || imageops_triangle(rgb, nw, nh));
    run_and_compare("fast_image_resize Bilinear", &mut || {
        fir_resize(&mut resizer, rgb, nw, nh, fast_image_resize::FilterType::Bilinear).unwrap()
    });
    run_and_compare("fast_image_resize Hamming", &mut || {
        fir_resize(&mut resizer, rgb, nw, nh, fast_image_resize::FilterType::Hamming).unwrap()
    });
    run_and_compare("manual nearest (YOLO/CCIP)", &mut || manual_nearest(rgb, nw, nh));
}

fn bench_resizes(runs: usize, fixture: &Path) -> Result<()> {
    let img = image::open(fixture)?.to_rgb8();
    println!("\n--- RESIZE BENCHMARK (source {:?}) ---", fixture);
    println!("reference = small-2 steps? no; reference = image crate Triangle (current OCR)",);

    // OCR detection: max-side <= 960 (1220 -> 960 wide, 702 tall).
    bench_resize_case(runs, "OCR det 960x702", &img, 960, 702);
    // OCR recognition: height = 48.
    let rec_w = (1220.0f64 * 48.0 / 892.0).round() as u32;
    bench_resize_case(runs, "OCR rec 66x48", &img, rec_w, 48);
    // YOLO: fit-to-640 (letterbox to 640x640 afterwards, resize only measured).
    bench_resize_case(runs, "YOLO fit 640x468", &img, 640, 468);
    // CCIP/CLIP crop: 384x384.
    bench_resize_case(runs, "CCIP 384x384", &img, 384, 384);
    Ok(())
}

fn main() -> Result<()> {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    println!("=== Image Decode Benchmark ===");
    println!("runs = {} (median), accuracy tolerance: maxΔ <= {} LSB, meanΔ <= {:.1}", runs, ACCURATE_MAX_DIFF, ACCURATE_MAX_MEAN);
    println!("source: assets/test_images/ (plus generated fixtures for each import format)");

    let fixture_dir = std::env::temp_dir().join("curator_decode_bench");
    std::fs::create_dir_all(&fixture_dir).context("create fixture dir")?;

    let fixtures = ensure_fixtures(&fixture_dir)?;
    for f in &fixtures {
        let ext = f
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let data = std::fs::read(f).context("read fixture")?;
        let fname = f.file_name().unwrap_or_default().to_string_lossy().to_string();
        let ext_owned: String = ext.clone();
        let prod_decode: DecoderFn = Box::new(move |data: &[u8]| {
            let tmp = std::env::temp_dir()
                .join(format!("curator_decode_bench_prod.{}", ext_owned));
            std::fs::write(&tmp, data)?;
            let (pixels, width, height) =
                curator_core::image_decode::decode_rgb(&tmp).context("decode_rgb")?;
            let _ = std::fs::remove_file(&tmp);
            Ok(DecodeResult {
                width,
                height,
                pixels,
            })
        });

        let methods: Vec<Method> = match ext.as_str() {
            "jpg" | "jpeg" => vec![
                Method {
                    name: "prod (decode_rgb)",
                    decode: Box::new(prod_decode),
                },
                Method {
                    name: "turbojpeg",
                    decode: Box::new(turbojpeg_decode),
                },
                Method {
                    name: "image crate (zune-jpeg)",
                    decode: Box::new(ref_image_decode),
                },
            ],
            "png" => vec![
                Method {
                    name: "prod (decode_rgb)",
                    decode: Box::new(prod_decode),
                },
                Method {
                    name: "png 0.18 direct (zlib-rs)",
                    decode: Box::new(png_direct_decode),
                },
                Method {
                    name: "image crate (png 0.17)",
                    decode: Box::new(ref_image_decode),
                },
            ],
            "webp" => vec![
                Method {
                    name: "prod (decode_rgb)",
                    decode: Box::new(prod_decode),
                },
                Method {
                    name: "webp 0.3 (libwebp-sys)",
                    decode: Box::new(webp_crate_decode),
                },
                Method {
                    name: "image crate (image-webp)",
                    decode: Box::new(ref_image_decode),
                },
            ],
            _ => vec![
                Method {
                    name: "prod (decode_rgb)",
                    decode: Box::new(prod_decode),
                },
                Method {
                    name: "image crate",
                    decode: Box::new(ref_image_decode),
                },
            ],
        };
run_format(&format!("{} ({})", fname, ext), &data, &methods, runs);
    }

    // Resize benchmark on the JPEG source (production OCR uses slow imageops::resize;
    // YOLO/CCIP use hand-rolled nearest). Compare against fast_image_resize.
    if let Some(jpg) = fixtures
        .iter()
        .find(|f| f.extension().is_some_and(|e| e == "jpg" || e == "jpeg"))
    {
        bench_resizes(runs, jpg)?;
    }

    println!("\n=== done ===");
    Ok(())
}



