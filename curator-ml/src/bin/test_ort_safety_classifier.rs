//! First-principles verification of the `nsfw-detection-2-mini` (5-class) ONNX export
//! (AGENTS.md §3.3 / §6.3 mandates).
//!
//! Loads the staged model(s) via the production `SafetyClassifier`, asserts the ONNX
//! I/O shape is `[1,3,380,380] -> [1,5]` and the output name is `probabilities`/`logits`,
//! runs `classify_image` on every image in `test_images`, asserts the five per-class
//! scores sum to `1.0`, cross-checks the batched path against the single-image path
//! within `1e-4`, then benchmarks per-image latency/FPS.
//!
//! Run: cargo run -p curator-ml --bin test_ort_safety_classifier

use curator_proto::contracts::DevicePreference;
use curator_ml::SafetyClassifier;
use image::RgbImage;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf();

    let staged = vec![
        (
            "Reference fp16",
            workspace.join("reference/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini_fp16.onnx"),
        ),
        (
            "Converted fp16",
            workspace.join(".curator/models/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini_fp16.onnx"),
        ),
        (
            "Converted fp32",
            workspace.join(".curator/models/nsfw-detection-2-mini/onnx/nsfw-detection-2-mini.onnx"),
        ),
    ];

    for (label, path) in staged {
        if !path.exists() {
            println!("Skipping {:?}: ONNX file not found at {:?}", label, path);
            continue;
        }
        println!("\n=======================================================");
        println!("  Testing Model Variant: {}", label);
        println!("=======================================================");
        verify_variant(&workspace, &path)?;
    }

    println!("\nnsfw-detection-2-mini verification PASSED.");
    Ok(())
}

fn verify_variant(workspace: &Path, onnx_path: &Path) -> anyhow::Result<()> {
    println!("=== 1. Verifying ONNX I/O Signature ===");
    let session = ort::session::Session::builder()?.commit_from_file(onnx_path)?;
    let input = session.inputs().first().expect("model has an input");
    let output = session.outputs().first().expect("model has an output");
    let input_shape = input.dtype().tensor_shape().expect("input is tensor");
    let output_shape = output.dtype().tensor_shape().expect("output is tensor");
    println!("  input name='{}', shape={:?}", input.name(), input_shape);
    println!("  output name='{}', shape={:?}", output.name(), output_shape);

    assert_eq!(input.name(), "image", "input name must be 'image'");
    assert!(
        output.name() == "probabilities" || output.name() == "logits",
        "output name must be 'probabilities' or 'logits', got {:?}",
        output.name()
    );
    // Batch dim is dynamic (-1 = any N). Assert the static layout [_,3,380,380] -> [_,5].
    assert_eq!(
        &input_shape[1..],
        &[3i64, 380, 380],
        "expected [_,3,380,380] input, got {:?}",
        input_shape
    );
    assert_eq!(
        &output_shape[..],
        &[-1i64, 5],
        "expected [_,5] output, got {:?}",
        output_shape
    );

    let classifier = SafetyClassifier::new(onnx_path, DevicePreference::Cpu);
    classifier.load()?;

    let images = load_test_images(workspace)?;
    if images.is_empty() {
        println!("No test images found under {:?}; skipping inference.", workspace.join("test_images"));
        return Ok(());
    }
    println!("Found {} test images.", images.len());

    println!("\n=== 2. Single-Image Classification (per-class probabilities) ===");
    let mut singles = Vec::new();
    for (name, rgb) in &images {
        let r = classifier.classify_image(rgb)?;
        let sum = r.safe_score + r.hentai_score + r.porn_score + r.sexy_score + r.drawing_score;
        assert!(
            (sum - 1.0).abs() <= 1e-4,
            "[{}] probabilities sum to {:.6}, expected 1.0",
            name,
            sum
        );
        println!(
            "[{}] sum={:.4}  safe={:.4} hentai={:.4} porn={:.4} sexy={:.4} drawing={:.4}  nsfw={:.4} sfw={:.4}",
            name,
            sum,
            r.safe_score,
            r.hentai_score,
            r.porn_score,
            r.sexy_score,
            r.drawing_score,
            r.nsfw_score(),
            r.sfw_score()
        );
        singles.push(r);
    }

    println!("\n=== 3. Batched Path Parity (classify_images_batch) ===");
    let rgbs: Vec<RgbImage> = images.iter().map(|(_, rgb)| rgb.clone()).collect();
    let batched = classifier.classify_images_batch(&rgbs);
    assert_eq!(batched.len(), rgbs.len(), "batch returned wrong row count");
    let mut max_diff = 0.0f32;
    for (i, b) in batched.iter().enumerate() {
        let b = b.as_ref().map_err(|e| anyhow::anyhow!("{e:#}"))?;
        let s = &singles[i];
        let diff = (b.hentai_score - s.hentai_score)
            .abs()
            .max((b.porn_score - s.porn_score).abs())
            .max((b.sexy_score - s.sexy_score).abs())
            .max((b.safe_score - s.safe_score).abs())
            .max((b.drawing_score - s.drawing_score).abs());
        max_diff = max_diff.max(diff);
        assert!(
            diff <= 1e-4,
            "[{}] batch vs single diff {:.6} > 1e-4",
            images[i].0,
            diff
        );
    }
    println!("Batch == single parity within 1e-4 (max diff {:.2e}).", max_diff);

    if let Some((first_name, first_img)) = images.first() {
        println!("\n=== 4. Throughput & Latency Benchmark (CPU) ===");
        println!("  Using {} for warmup/timing.", first_name);
        for _ in 0..5 {
            let _ = classifier.classify_image(first_img)?;
        }
        let iterations = 50;
        let start = Instant::now();
        for _ in 0..iterations {
            let _ = classifier.classify_image(first_img)?;
        }
        let elapsed = start.elapsed();
        let avg_ms = (elapsed.as_secs_f64() * 1000.0) / iterations as f64;
        let fps = iterations as f64 / elapsed.as_secs_f64();
        println!("  Average latency: {:.2} ms / image", avg_ms);
        println!("  Throughput     : {:.2} images / second (FPS)", fps);
    }

    println!("\n=== 5. Dynamic run_onnx_benchmark ===");
    let (cpu, gpu, gpu_err) = curator_ml::benchmark_safety_classifier(onnx_path)?;
    println!("  CPU benchmark latency: {:.2} ms", cpu);
    if let Some(gpu_time) = gpu {
        println!("  GPU benchmark latency: {:.2} ms", gpu_time);
    } else {
        println!("  GPU benchmark skipped/failed: {:?}", gpu_err);
    }

    println!("\nModel variant PASSED.");
    Ok(())
}

fn load_test_images(workspace: &Path) -> anyhow::Result<Vec<(String, RgbImage)>> {
    let test_images_dir = workspace.join("test_images");
    let mut out = Vec::new();
    if !test_images_dir.is_dir() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(test_images_dir)? {
        let entry = entry?;
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp") {
            match image::open(&p) {
                Ok(img) => out.push((p.file_name().unwrap_or_default().to_string_lossy().into_owned(), img.to_rgb8())),
                Err(e) => eprintln!("Failed to open {:?}: {}", p, e),
            }
        }
    }
    Ok(out)
}