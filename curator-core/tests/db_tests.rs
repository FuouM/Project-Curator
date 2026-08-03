use curator_core::init_db;
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_db_initialization_and_migrations() {
    // Create a temporary file path for the SQLite database
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();

    // Initialize database (which runs migrations programmatically)
    let pool = init_db(db_path)
        .await
        .expect("Failed to initialize database");

    // Verify migrations by querying one of the created tables
    let tables: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='sources'")
            .fetch_all(&pool)
            .await
            .expect("Failed to query database schema");

    assert_eq!(
        tables.len(),
        1,
        "The 'sources' table was not created by migrations"
    );
}

#[tokio::test]
async fn test_ocr_db_schema() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();
    let pool = init_db(db_path).await.unwrap();

    // Verify image_ocr_detections and image_ocr_fts tables exist
    let tables: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_ocr_detections', 'image_ocr_fts')"
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert!(tables.iter().any(|t| t.0 == "image_ocr_detections"));

    // Verify FTS table synchronization trigger works
    sqlx::query("INSERT INTO images (id, sha256, current_filepath, mtime) VALUES (1, 'hash', 'path.jpg', 0)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO image_ocr_detections (image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3) VALUES (1, 'HELLO OCR WORLD', 0.99, 0, 0, 10, 0, 10, 5, 0, 5)")
        .execute(&pool)
        .await
        .unwrap();

    let fts_rows: Vec<(String,)> = sqlx::query_as("SELECT text FROM image_ocr_fts WHERE rowid = 1")
        .fetch_all(&pool)
        .await
        .unwrap();

    assert_eq!(fts_rows[0].0, "HELLO OCR WORLD");
}

#[test]
fn test_ocr_detector_sanity() {
    // Basic structural checks of OcrDetector instantiation
    let detector = curator_core::OcrDetector::new("../.curator/models", curator_core::DevicePreference::Cpu, false, false);
    assert!(!detector.is_loaded());
}

#[test]
fn test_ocr_image_transcription_extraction() {
    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let models_dir = workspace_root.join(".curator").join("models");
    let ref_dir = workspace_root.join("reference");
    
    // Dynamically copy models if not present in the .curator/models directory (mimics backend download_detection_models)
    let ocr_files = [
        ("PP-OCRv6_small_det_onnx/inference.onnx", "PP-OCRv6_small_det_onnx/inference.onnx"),
        ("PP-OCRv6_small_det_onnx/inference.yml", "PP-OCRv6_small_det_onnx/inference.yml"),
        ("PP-OCRv6_small_rec_onnx/inference.onnx", "PP-OCRv6_small_rec_onnx/inference.onnx"),
        ("PP-OCRv6_small_rec_onnx/inference.yml", "PP-OCRv6_small_rec_onnx/inference.yml"),
        ("PP-OCRv6_medium_det_onnx/inference.onnx", "PP-OCRv6_medium_det_onnx/inference.onnx"),
        ("PP-OCRv6_medium_det_onnx/inference.yml", "PP-OCRv6_medium_det_onnx/inference.yml"),
        ("PP-OCRv6_medium_rec_onnx/inference.onnx", "PP-OCRv6_medium_rec_onnx/inference.onnx"),
        ("PP-OCRv6_medium_rec_onnx/inference.yml", "PP-OCRv6_medium_rec_onnx/inference.yml"),
    ];
    for (dest_rel, ref_rel) in &ocr_files {
        let dest = models_dir.join(dest_rel);
        if !dest.exists() {
            let ref_path = ref_dir.join(ref_rel);
            if ref_path.exists() {
                std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
                std::fs::copy(&ref_path, &dest).unwrap();
            }
        }
    }

    let img_path = workspace_root.join("assets").join("test_images").join("1533999207878.png");
    if !img_path.exists() {
        return;
    }

    let detector = curator_core::OcrDetector::new(models_dir, curator_core::DevicePreference::Cpu, false, false);
    let (rgb_buf, width, height) = curator_core::image_decode::decode_rgb(&img_path).unwrap();
    let img = curator_core::image::ImageBuffer::<curator_core::image::Rgb<u8>, Vec<u8>>::from_raw(width, height, rgb_buf).unwrap();

    let (results, bubbles) = detector.run_ocr(&img).expect("Failed to run OCR");
    println!("Extracted {} text blocks, {} bubble detections:", results.len(), bubbles.len());
    for (idx, det) in results.iter().enumerate() {
        println!("[{}] \"{}\" (conf: {:.2}, bubble: {})", idx, det.text, det.confidence, det.is_from_bubble);
    }

    // Direct inspect detection probability map values if 0 text blocks were found
    if results.is_empty() {
        let (det_tensor, det_w, det_h) = curator_core::detection::ocr::preprocess_det(&img).unwrap();
        let (shape, data) = detector.det_session.with_session(|det_session| {
            let outputs = det_session.run(ort::inputs![ort::value::TensorRef::from_array_view(&det_tensor).unwrap()]).unwrap();
            let out_tensor = outputs.get("fetch_name_0").or_else(|| outputs.get("maps")).unwrap();
            let (shape, data) = out_tensor.try_extract_tensor::<f32>().unwrap();
            Ok((shape.to_owned(), data.to_vec()))
        }).unwrap();
        let mut max_val = 0.0f32;
        let mut count_above = 0;
        for v in data {
            if v > max_val { max_val = v; }
            if v > 0.2 { count_above += 1; }
        }
        println!("DEBUG DET MAP: resize={}x{}, shape={:?}, max_val={:.4}, count_above_0.2={}", det_w, det_h, shape, max_val, count_above);
    }

    // Verify we found some texts and check typical OTAKU keyword
    assert!(!results.is_empty(), "No texts extracted from the reference image");
    let joined_texts = results.iter().map(|d| d.text.to_uppercase()).collect::<Vec<_>>().join(" ");
    assert!(joined_texts.contains("OTAKU") || joined_texts.contains("GIRLS") || joined_texts.contains("WANTED"), "Expected OCR results to contain key transcription keywords");
}

