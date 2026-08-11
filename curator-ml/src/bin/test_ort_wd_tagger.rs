//! First-principles verification of the WD EVA02 tagger ONNX export
//! (AGENTS.md mandate).
//!
//! Loads the exported model via the production `TaggerEngine`, asserts the
//! ONNX I/O shapes are `[1,3,448,448] -> [1,16473]`, runs it on a real library
//! image through the full production path, and sanity-checks the predictions.
//! Guarded on file presence so the test suite stays green before conversion.
//!
//! Run: cargo run -p curator-core --bin test_ort_wd_tagger

use curator_proto::constants::resolve_data_dir;
use curator_proto::contracts::DevicePreference;
use curator_ml::tagger::{TaggerEngine, WD_EVA02_SPEC};

const NUM_CLASSES: usize = 16473;
const INPUT_SIZE: usize = 448;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model_dir = resolve_data_dir().join("models");
    let onnx_path = model_dir.join("wd-eva02-tagger-2026-canary").join("wd-eva02-tagger-2026-canary.onnx");

    if !onnx_path.exists() {
        eprintln!(
            "Skipping: WD tagger not converted yet (expected {:?}). Run scripts/convert_to_onnx.py first.",
            onnx_path
        );
        return Ok(());
    }

    // 1. Verify ONNX I/O shapes directly.
    let session = ort::session::Session::builder()?.commit_from_file(&onnx_path)?;
    let input = session.inputs().first().expect("model has an input");
    let output = session.outputs().first().expect("model has an output");
    println!(
        "ONNX input: {} | output: {}",
        input.name(),
        output.name()
    );
    let input_shape = input.dtype().tensor_shape().expect("input is tensor");
    let output_shape = output.dtype().tensor_shape().expect("output is tensor");
    println!("  input shape: {:?}", input_shape);
    println!("  output shape: {:?}", output_shape);
    assert_eq!(
        input_shape,
        &ort::tensor::Shape::new([1i64, 3, INPUT_SIZE as i64, INPUT_SIZE as i64])
    );
    assert_eq!(
        output_shape,
        &ort::tensor::Shape::new([1i64, NUM_CLASSES as i64])
    );

    // 2. Run the full production engine on a real library image.
    let engine = TaggerEngine::new(&model_dir, &WD_EVA02_SPEC, DevicePreference::Cpu);
    let data_dir = resolve_data_dir();
    let workspace = data_dir.parent().expect("workspace root");
    let test_images = workspace.join("test_images");
    let mut sample_path = None;
    if test_images.is_dir() {
        for entry in std::fs::read_dir(&test_images)? {
            let entry = entry?;
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp") {
                sample_path = Some(p);
                break;
            }
        }
    }

    let Some(image_path) = sample_path else {
        println!("No test image available; skipping inference check.");
        return Ok(());
    };

    let predictions = engine.tag_image(&image_path, WD_EVA02_SPEC.default_threshold)?;
    assert!(!predictions.is_empty(), "expected at least one prediction on a real image");
    println!(
        "Engine ran on {:?}: {} predictions at threshold {}",
        image_path,
        predictions.len(),
        WD_EVA02_SPEC.default_threshold
    );
    println!("Top 15 tags:");
    for p in predictions.iter().take(15) {
        println!("  {:6.3} [{}] {}", p.confidence, p.category, p.tag);
    }

    println!("WD EVA02 tagger verification PASSED.");
    Ok(())
}