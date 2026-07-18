use curator_core::vector::{ModelManager, VectorIndex};
use tempfile::tempdir;

#[tokio::test]
async fn test_vector_indexing_and_clip_inference() {
    let temp_dir = tempdir().unwrap();
    let model_dir = temp_dir.path().join("models");
    let index_path = temp_dir.path().join("vector_index.usearch");

    // Initialize ModelManager (downloads ONNX models)
    let mut model_manager = ModelManager::new(&model_dir);
    
    // We run the initialization (which downloads the models)
    model_manager.init().expect("Failed to initialize CLIP models");

    // Verify model files exist in models folder
    assert!(model_dir.join("vision_model.onnx").exists());
    assert!(model_dir.join("text_model.onnx").exists());
    assert!(model_dir.join("tokenizer.json").exists());

    // Generate image embedding for a test image
    let test_image_path = ".\\test_images\\augh.png";
    let image_embedding = model_manager.generate_image_embedding(test_image_path)
        .expect("Failed to generate image embedding");

    // 512 dimensions for CLIP ViT-B/32
    assert_eq!(image_embedding.len(), 512);

    // Generate text embedding
    let text_embedding = model_manager.generate_text_embedding("a picture of a cat")
        .expect("Failed to generate text embedding");
    assert_eq!(text_embedding.len(), 512);

    // Test VectorIndex insertion and query
    let index = VectorIndex::new(&index_path, 512).expect("Failed to initialize vector index");
    index.add(42, &image_embedding).expect("Failed to add vector to index");

    // Search nearest neighbor
    let search_results = index.search(&text_embedding, 1).expect("Failed to search index");
    assert_eq!(search_results.len(), 1);
    assert_eq!(search_results[0].0, 42);
}
