use curator_core::ipc::DevicePreference;
use curator_core::vector::{ModelManager, VectorIndex};
use tempfile::tempdir;

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PAD_COLOR: [u8; 3] = [124, 116, 104];

#[test]
fn test_turbojpeg_decode_dimensions_and_channels() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("assets")
        .join("test_images")
        .join("Yoshitani-Ayako_Urabe-Mikoto_Nazo-no-Kanojo-X.jpg");
    if !path.exists() {
        return;
    }
    let data = std::fs::read(&path).unwrap();

    let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB).unwrap();
    assert!(image.width > 0);
    assert!(image.height > 0);
    assert_eq!(image.pixels.len(), (image.width * image.height * 3) as usize);

    // Verify comparison with image crate decoding
    let img = image::open(&path).unwrap().to_rgb8();
    assert_eq!(img.width(), image.width as u32);
    assert_eq!(img.height(), image.height as u32);
}

#[test]
fn test_letterbox_preprocess_invariants() {
    let target = 512u32;
    let (ow, oh) = (1920u32, 1080u32); // 16:9 wide aspect ratio
    let aspect = ow as f32 / oh as f32;
    let (nw, nh) = if aspect > 1.0 {
        (target, (target as f32 / aspect).round() as u32)
    } else {
        ((target as f32 * aspect).round() as u32, target)
    };

    assert_eq!(nw, 512);
    assert_eq!(nh, 288); // 512 / (1920/1080) = 288

    let px = ((target - nw) / 2) as usize;
    let py = ((target - nh) / 2) as usize;
    assert_eq!(px, 0);
    assert_eq!(py, 112); // (512 - 288) / 2 = 112

    // Synthetic buffer filled with known RGB pattern
    let synthetic_rgb = vec![128u8; (nw * nh * 3) as usize];
    let tensor = build_test_tensor(&synthetic_rgb, target, nw, nh);

    assert_eq!(tensor.shape(), &[1, 3, 512, 512]);

    // Check padding value for channel 0 (Red)
    let expected_pad_val = (PAD_COLOR[0] as f32 / 255.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    let top_pad_sample = tensor[[0, 0, 10, 256]];
    assert!(
        (top_pad_sample - expected_pad_val).abs() < 1e-4,
        "Padding region did not match expected ImageNet normalized value"
    );

    // Check inner content value for channel 0 (Red)
    let expected_content_val = (128.0 / 255.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    let center_sample = tensor[[0, 0, 256, 256]];
    assert!(
        (center_sample - expected_content_val).abs() < 1e-4,
        "Center region did not match expected ImageNet normalized content value"
    );
}

fn build_test_tensor(data: &[u8], target: u32, nw: u32, nh: u32) -> ndarray::Array4<f32> {
    let s = target as usize;
    let mut tensor = ndarray::Array4::<f32>::zeros((1, 3, s, s));
    let slice = tensor.as_slice_mut().unwrap();
    let px = ((target - nw) / 2) as usize;
    let py = ((target - nh) / 2) as usize;
    let nw = nw as usize;
    let nh = nh as usize;
    for c in 0..3usize {
        let mean = IMAGENET_MEAN[c];
        let std_dev = IMAGENET_STD[c];
        let pad_val = (PAD_COLOR[c] as f32 / 255.0 - mean) / std_dev;
        let db = c * s * s;
        for y in 0..s {
            let rs = db + y * s;
            for x in 0..s {
                slice[rs + x] = pad_val;
            }
        }
        for y in 0..nh {
            let sr = y * nw * 3 + c;
            let dr = db + (py + y) * s + px;
            for x in 0..nw {
                let val = data[sr + x * 3] as f32 / 255.0;
                slice[dr + x] = (val - mean) / std_dev;
            }
        }
    }
    tensor
}

#[tokio::test]
async fn test_vector_indexing_and_clip_inference() {
    let temp_dir = tempdir().unwrap();
    let index_path = temp_dir.path().join("vector_index.usearch");

    let data_dir_env = std::env::var("CURATOR_DATA_DIR").ok();
    let default_data_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".curator");
    let model_dir = match &data_dir_env {
        Some(p) => std::path::PathBuf::from(p).join("models"),
        None => default_data_dir.join("models"),
    };
    let model_dir = model_dir.as_path();

    let model_manager = ModelManager::new(model_dir, DevicePreference::Auto);
    model_manager
        .init()
        .expect("Failed to initialize CLIP models");

    assert!(model_dir.join("clip-vit-b32").join("vision_model.onnx").exists());
    assert!(model_dir.join("clip-vit-b32").join("text_model.onnx").exists());
    assert!(model_dir.join("clip-vit-b32").join("tokenizer.json").exists());

    let test_image_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("assets")
        .join("test_images")
        .join("augh.png");
    let test_image_path = test_image_path.to_str().expect("path is valid UTF-8");

    let image_embedding = model_manager
        .generate_image_embedding(test_image_path)
        .expect("Failed to generate image embedding");
    assert_eq!(image_embedding.len(), 512);

    // Verify L2 unit norm
    let img_norm: f32 = image_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((img_norm - 1.0).abs() < 1e-4, "Image embedding must be unit normalized");

    let text_embedding = model_manager
        .generate_text_embedding("a picture of a cat")
        .expect("Failed to generate text embedding");
    assert_eq!(text_embedding.len(), 512);

    let txt_norm: f32 = text_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((txt_norm - 1.0).abs() < 1e-4, "Text embedding must be unit normalized");

    let index = VectorIndex::new(&index_path, 512).expect("Failed to initialize vector index");
    index
        .add(42, &image_embedding)
        .expect("Failed to add vector to index");

    assert!(index.contains(42));
    assert!(!index.contains(99));

    let search_results = index
        .search(&text_embedding, 1)
        .expect("Failed to search index");
    assert_eq!(search_results.len(), 1);
    assert_eq!(search_results[0].0, 42);
}

#[tokio::test]
async fn test_text_similarity_and_padding_behavior() {
    use curator_core::ipc::EmbeddingModel;
    let data_dir_env = std::env::var("CURATOR_DATA_DIR").ok();
    let default_data_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join(".curator");
    let model_dir = match &data_dir_env {
        Some(p) => std::path::PathBuf::from(p).join("models"),
        None => default_data_dir.join("models"),
    };
    let model_dir = model_dir.as_path();

    let model_manager = ModelManager::new(model_dir, DevicePreference::Cpu);
    model_manager
        .init()
        .expect("Failed to initialize CLIP models");

    for model in [EmbeddingModel::ClipVitB32, EmbeddingModel::MobileClipS2] {
        model_manager.set_active_model(model);
        model_manager.init().expect("Failed to init model");

        let cat = model_manager.generate_text_embedding("a picture of a cat").unwrap();
        let kitten = model_manager.generate_text_embedding("a cute kitten").unwrap();
        let car = model_manager.generate_text_embedding("a sports car on a highway").unwrap();

        // 1. Verify L2 unit norm
        for (name, emb) in [("cat", &cat), ("kitten", &kitten), ("car", &car)] {
            let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!(
                (norm - 1.0).abs() < 1e-4,
                "{:?} embedding for '{}' was not unit normalized (norm: {})",
                model,
                name,
                norm
            );
        }

        // 2. Cosine similarities
        let sim_cat_kitten: f32 = cat.iter().zip(&kitten).map(|(a, b)| a * b).sum();
        let sim_cat_car: f32 = cat.iter().zip(&car).map(|(a, b)| a * b).sum();

        // 3. Explicit semantic similarity assertions
        assert!(
            sim_cat_kitten > 0.80,
            "{:?}: Expected 'cat' and 'kitten' similarity > 0.80, got {}",
            model,
            sim_cat_kitten
        );
        assert!(
            sim_cat_kitten > sim_cat_car + 0.08,
            "{:?}: 'cat' should be closer to 'kitten' ({}) than 'car' ({})",
            model,
            sim_cat_kitten,
            sim_cat_car
        );
    }
}

#[tokio::test]
async fn test_single_vs_batch_embedding_equivalence() {
    use curator_core::ipc::EmbeddingModel;

    let data_dir_env = std::env::var("CURATOR_DATA_DIR").ok();
    let default_data_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join(".curator");
    let model_dir = match &data_dir_env {
        Some(p) => std::path::PathBuf::from(p).join("models"),
        None => default_data_dir.join("models"),
    };
    let model_dir = model_dir.as_path();

    let vision_file = model_dir.join("clip-vit-b32").join("vision_model.onnx");
    if !vision_file.exists() {
        return;
    }

    let test_image_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("assets")
        .join("test_images")
        .join("augh.png");
    if !test_image_path.exists() {
        return;
    }

    for model in [EmbeddingModel::ClipVitB32, EmbeddingModel::MobileClipS2] {
        let mm = ModelManager::new(model_dir, DevicePreference::Cpu);
        mm.init().expect("Failed to initialize models");
        mm.set_active_model(model);
        mm.init().expect("Failed to init model");

        let single = mm
            .generate_image_embedding(&test_image_path)
            .expect("single-path embedding failed");
        let batch = mm
            .generate_image_embeddings(&[&test_image_path])
            .expect("batch-path embeddings failed");
        let batch = batch.into_iter().next().unwrap().expect("batch item failed");

        assert_eq!(single.len(), batch.len(), "embedding dim mismatch for {:?}", model);
        let max_delta = single
            .iter()
            .zip(&batch)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_delta <= 1e-5,
            "{:?} single vs batch max delta = {}",
            model,
            max_delta
        );
    }
}

