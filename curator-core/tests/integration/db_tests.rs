use curator_core::init_db;
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_db_initialization_and_migrations() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();

    let pool = init_db(db_path)
        .await
        .expect("Failed to initialize database");

    // Verify all essential tables are created by migrations
    let expected_tables = [
        "sources",
        "images",
        "tags",
        "image_tags",
        "image_parsed_metadata",
        "character_identities",
        "character_detections",
        "custom_concepts",
        "custom_concept_samples",
        "custom_concept_vectors",
        "image_ocr_detections",
        "image_ocr_fts",
    ];

    let tables: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table'")
            .fetch_all(&pool)
            .await
            .expect("Failed to query database schema");

    let table_names: Vec<String> = tables.into_iter().map(|(n,)| n).collect();
    for expected in &expected_tables {
        assert!(
            table_names.contains(&expected.to_string()),
            "Expected table '{}' was not found in schema. Present tables: {:?}",
            expected,
            table_names
        );
    }
}

#[tokio::test]
async fn test_cascade_deletions_and_foreign_keys() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();
    let pool = init_db(db_path).await.unwrap();

    // Enable foreign keys
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();

    // 1. Insert base image and source
    sqlx::query("INSERT INTO sources (id, name, type) VALUES (1, 'user', 'builtin')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO images (id, sha256, current_filepath, mtime) VALUES (10, 'sha_test_10', 'path_10.jpg', 1000)"
    )
    .execute(&pool)
    .await
    .unwrap();

    // 2. Insert tag and link in image_tags
    sqlx::query("INSERT INTO tags (id, name, category) VALUES (100, '1girl', 'general')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted) VALUES (10, 100, 1, 0.99, 0)"
    )
    .execute(&pool)
    .await
    .unwrap();

    // 3. Insert parsed metadata
    sqlx::query(
        "INSERT INTO image_parsed_metadata (image_id, match_type, artist, extracted_tags, raw_matched) VALUES (10, 'pixiv_id', 'artist_test', '[\"1girl\"]', 'raw')"
    )
    .execute(&pool)
    .await
    .unwrap();

    // 4. Insert character detection
    sqlx::query(
        "INSERT INTO character_detections (id, image_id, x0, y0, x1, y1, confidence) VALUES (500, 10, 10, 20, 100, 150, 0.95)"
    )
    .execute(&pool)
    .await
    .unwrap();

    // Verify records exist before deletion
    let (tag_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_tags WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_count, 1);

    let (meta_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_parsed_metadata WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(meta_count, 1);

    let (det_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM character_detections WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(det_count, 1);

    // 5. Delete image
    sqlx::query("DELETE FROM images WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();

    // Verify cascading cleanup
    let (tag_count_after,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_tags WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_count_after, 0, "image_tags was not cleaned up on image deletion");

    let (meta_count_after,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM image_parsed_metadata WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(meta_count_after, 0, "image_parsed_metadata was not cleaned up on image deletion");

    let (det_count_after,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM character_detections WHERE image_id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(det_count_after, 0, "character_detections was not cleaned up on image deletion");
}

#[tokio::test]
async fn test_tag_taxonomy_and_conflict_resolution() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();
    let pool = init_db(db_path).await.unwrap();

    // Insert tags across taxonomy categories
    let tags_to_insert = [
        ("hatsune_miku", "character"),
        ("kantoku", "artist"),
        ("vocaloid", "copyright"),
        ("solo", "general"),
        ("highres", "meta"),
    ];

    for (name, category) in &tags_to_insert {
        sqlx::query("INSERT INTO tags (name, category) VALUES (?, ?)")
            .bind(name)
            .bind(category)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Verify duplicate tag insertion with ON CONFLICT DO NOTHING
    let res = sqlx::query("INSERT INTO tags (name, category) VALUES ('hatsune_miku', 'character') ON CONFLICT(name) DO NOTHING")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(res.rows_affected(), 0, "Duplicate tag insertion should affect 0 rows with ON CONFLICT DO NOTHING");

    let (total_tags,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total_tags, 5);
}

#[tokio::test]
async fn test_character_identities_and_detections_crud() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();
    let pool = init_db(db_path).await.unwrap();

    // Create image
    sqlx::query("INSERT INTO images (id, sha256, current_filepath, mtime) VALUES (1, 'hash_1', 'img1.png', 0)")
        .execute(&pool)
        .await
        .unwrap();

    // Create identity
    sqlx::query("INSERT INTO character_identities (id, name, created_at) VALUES (1, 'Chitanda Eru', '2026-08-14 00:00:00')")
        .execute(&pool)
        .await
        .unwrap();

    // Insert detection with coordinates
    sqlx::query(
        "INSERT INTO character_detections (id, image_id, identity_id, x0, y0, x1, y1, confidence) VALUES (10, 1, 1, 50, 60, 200, 300, 0.98)"
    )
    .execute(&pool)
    .await
    .unwrap();

    // Query joined detection and identity
    let row: (i64, i64, String, i32, i32, i32, i32, f32) = sqlx::query_as(
        "SELECT d.id, d.image_id, i.name, d.x0, d.y0, d.x1, d.y1, d.confidence \
         FROM character_detections d \
         JOIN character_identities i ON d.identity_id = i.id \
         WHERE d.id = 10"
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(row.0, 10);
    assert_eq!(row.1, 1);
    assert_eq!(row.2, "Chitanda Eru");
    assert_eq!(row.3, 50);
    assert_eq!(row.4, 60);
    assert_eq!(row.5, 200);
    assert_eq!(row.6, 300);
    assert!((row.7 - 0.98).abs() < 1e-4);

    // Unassign identity (set identity_id to NULL)
    sqlx::query("UPDATE character_detections SET identity_id = NULL WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();

    let (assigned_id,): (Option<i64>,) = sqlx::query_as("SELECT identity_id FROM character_detections WHERE id = 10")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(assigned_id, None);
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
    let detector = curator_core::OcrDetector::new("../.curator/models", curator_core::DevicePreference::Cpu, false, false);
    assert!(!detector.is_loaded());
}

#[test]
fn test_ocr_image_transcription_extraction() {
    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let models_dir = workspace_root.join(".curator").join("models");
    let ref_dir = workspace_root.join("reference");
    
    // Dynamically copy medium models if not present in the .curator/models directory (mimics backend manifest downloads)
    let ocr_files = [
        ("pp-ocrv6-medium/det/inference.onnx", "PP-OCRv6_medium_det_onnx/inference.onnx"),
        ("pp-ocrv6-medium/det/inference.yml", "PP-OCRv6_medium_det_onnx/inference.yml"),
        ("pp-ocrv6-medium/rec/inference.onnx", "PP-OCRv6_medium_rec_onnx/inference.onnx"),
        ("pp-ocrv6-medium/rec/inference.yml", "PP-OCRv6_medium_rec_onnx/inference.yml"),
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

    assert!(!results.is_empty(), "No texts extracted from the reference image");
    let joined_texts = results.iter().map(|d| d.text.to_uppercase()).collect::<Vec<_>>().join(" ");
    assert!(joined_texts.contains("FREEDOM") || joined_texts.contains("DILEMMA") || joined_texts.contains("BOCCHI") || joined_texts.contains("PRETTY"), "Expected OCR results to contain key transcription keywords");
}

