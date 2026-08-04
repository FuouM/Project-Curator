use curator_core::{
    init_db,
    vector::ModelManager,
    ipc::DevicePreference,
    get_benchmark_images,
    run_single_image_benchmark,
};
use tempfile::NamedTempFile;
use std::path::Path;

#[tokio::test]
async fn test_image_processing_benchmark_iterative_paths() {
    // 1. Initialize temporary database
    let db_file = NamedTempFile::new().unwrap();
    let db = init_db(db_file.path()).await.expect("Failed to init db");

    // 2. Set up dummy directories and model structures
    let model_dir = Path::new("dummy_models");
    let model_manager = ModelManager::new(model_dir, DevicePreference::Cpu);

    // 3. Get benchmark images on empty database (should be empty vector)
    let images = get_benchmark_images(&db, 100).await.expect("Failed to get benchmark images");
    assert_eq!(images.len(), 0);

    // 4. Insert an image record that doesn't exist on disk
    sqlx::query("INSERT INTO images (sha256, current_filepath, mtime, is_missing) VALUES ('dummy_sha', 'dummy_path_nonexistent.jpg', 0, 0)")
        .execute(&db)
        .await
        .unwrap();

    // 5. Get benchmark images again (should still be empty vector because file does not exist on disk)
    let images2 = get_benchmark_images(&db, 100).await.expect("Failed to get benchmark images");
    assert_eq!(images2.len(), 0);

    // 6. Test run_single_image_benchmark with nonexistent path (should error out)
    let result = run_single_image_benchmark(
        &model_manager,
        "dummy_path_nonexistent.jpg",
        &curator_core::tagger::CAMIE_SPEC,
    )
    .await;
    assert!(result.is_err());
    let err_msg = result.err().unwrap().to_string();
    assert!(err_msg.contains("Image file does not exist"), "Expected error message to mention nonexistent: {}", err_msg);
}

