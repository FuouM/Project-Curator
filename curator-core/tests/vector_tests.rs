use curator_core::ipc::DevicePreference;
use curator_core::vector::{ModelManager, VectorIndex};
use tempfile::tempdir;

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PAD_COLOR: [u8; 3] = [124, 116, 104];

#[test]
fn test_decode_benchmark() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("test_images")
        .join("Yoshitani-Ayako_Urabe-Mikoto_Nazo-no-Kanojo-X.jpg");
    let path = path.as_path();
    if !path.exists() {
        println!("Test image not found, skipping");
        return;
    }
    let data = std::fs::read(path).unwrap();
    let runs = 10;

    let _ = image::open(path).unwrap();

    let t0 = std::time::Instant::now();
    for _ in 0..runs {
        let img = image::open(path).unwrap();
        let _rgb = img.to_rgb8();
    }
    let image_ms = t0.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    let t1 = std::time::Instant::now();
    for _ in 0..runs {
        let _image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB).unwrap();
    }
    let turbo_ms = t1.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    println!(
        "\n=== Decode Benchmark ({}, {} runs) ===\n\
         image crate:  {:.1} ms\n\
         turbojpeg:    {:.1} ms  ({:.1}x faster)",
        path.file_name().unwrap().to_string_lossy(),
        runs,
        image_ms,
        turbo_ms,
        image_ms / turbo_ms,
    );
}

#[test]
fn test_full_preprocess_benchmark() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("test_images")
        .join("Yoshitani-Ayako_Urabe-Mikoto_Nazo-no-Kanojo-X.jpg");
    let path = path.as_path();
    if !path.exists() {
        println!("Test image not found, skipping");
        return;
    }
    let data = std::fs::read(path).unwrap();
    let target: u32 = 512;
    let runs = 5;
    use fast_image_resize::{FilterType as FirFilter, ResizeAlg, ResizeOptions, Resizer};

    let _ = image::open(path).unwrap();

    let t_a = std::time::Instant::now();
    for _ in 0..runs {
        preprocess_a_image_crate(path, target);
    }
    let ms_a = t_a.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    let t_b = std::time::Instant::now();
    for _ in 0..runs {
        preprocess_b_turbo_img_resize(&data, target);
    }
    let ms_b = t_b.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    let mut resizer = Resizer::new();
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FirFilter::Bilinear));
    {
        let (buf, ow, oh) = decode_turbo(&data);
        let aspect = ow as f32 / oh as f32;
        let (nw, nh) = if aspect > 1.0 {
            (target, (target as f32 / aspect).round() as u32)
        } else {
            ((target as f32 * aspect).round() as u32, target)
        };
        let src = fast_image_resize::images::ImageRef::new(
            ow,
            oh,
            &buf,
            fast_image_resize::PixelType::U8x3,
        )
        .unwrap();
        let mut dst = fast_image_resize::images::Image::from_vec_u8(
            nw,
            nh,
            vec![0u8; (nw * nh * 3) as usize],
            fast_image_resize::PixelType::U8x3,
        )
        .unwrap();
        resizer.resize(&src, &mut dst, Some(&opts)).unwrap();
    }
    let t_c = std::time::Instant::now();
    for _ in 0..runs {
        preprocess_c_turbo_fir(&data, target, &mut resizer, &opts);
    }
    let ms_c = t_c.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    let mut resizer2 = Resizer::new();
    let t_d = std::time::Instant::now();
    for _ in 0..runs {
        preprocess_d_image_fir(path, target, &mut resizer2, &opts);
    }
    let ms_d = t_d.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    println!(
        "\n=== Full Preprocess Benchmark (512x512, {} runs) ===\n\
         A) image crate + img resize (current):  {:.1} ms\n\
         B) turbojpeg  + img resize:             {:.1} ms  ({:.1}x)\n\
         C) turbojpeg  + FIR Bilinear:           {:.1} ms  ({:.1}x)\n\
         D) image crate + FIR Bilinear:          {:.1} ms  ({:.1}x)",
        runs,
        ms_a,
        ms_b,
        ms_a / ms_b,
        ms_c,
        ms_a / ms_c,
        ms_d,
        ms_a / ms_d,
    );
}

fn decode_turbo(data: &[u8]) -> (Vec<u8>, u32, u32) {
    let image = turbojpeg::decompress(data, turbojpeg::PixelFormat::RGB).unwrap();
    let w = image.width as u32;
    let h = image.height as u32;
    (image.pixels.to_vec(), w, h)
}

fn preprocess_a_image_crate(path: &std::path::Path, target: u32) {
    let img = image::open(path).unwrap();
    let rgb = img.to_rgb8();
    let (ow, oh) = rgb.dimensions();
    let aspect = ow as f32 / oh as f32;
    let (nw, nh) = if aspect > 1.0 {
        (target, (target as f32 / aspect).round() as u32)
    } else {
        ((target as f32 * aspect).round() as u32, target)
    };
    let resized = image::imageops::resize(&rgb, nw, nh, image::imageops::FilterType::Triangle);
    build_tensor(resized.as_raw(), target, nw, nh);
}

fn preprocess_b_turbo_img_resize(data: &[u8], target: u32) {
    let (buf, ow, oh) = decode_turbo(data);
    let aspect = ow as f32 / oh as f32;
    let (nw, nh) = if aspect > 1.0 {
        (target, (target as f32 / aspect).round() as u32)
    } else {
        ((target as f32 * aspect).round() as u32, target)
    };
    let src_img = image::RgbImage::from_raw(ow, oh, buf).unwrap();
    let resized = image::imageops::resize(&src_img, nw, nh, image::imageops::FilterType::Triangle);
    build_tensor(resized.as_raw(), target, nw, nh);
}

fn preprocess_c_turbo_fir(
    data: &[u8],
    target: u32,
    resizer: &mut fast_image_resize::Resizer,
    opts: &fast_image_resize::ResizeOptions,
) {
    let (buf, ow, oh) = decode_turbo(data);
    let aspect = ow as f32 / oh as f32;
    let (nw, nh) = if aspect > 1.0 {
        (target, (target as f32 / aspect).round() as u32)
    } else {
        ((target as f32 * aspect).round() as u32, target)
    };
    let src =
        fast_image_resize::images::ImageRef::new(ow, oh, &buf, fast_image_resize::PixelType::U8x3)
            .unwrap();
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        nw,
        nh,
        vec![0u8; (nw * nh * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )
    .unwrap();
    resizer.resize(&src, &mut dst, Some(opts)).unwrap();
    build_tensor(dst.buffer(), target, nw, nh);
}

fn preprocess_d_image_fir(
    path: &std::path::Path,
    target: u32,
    resizer: &mut fast_image_resize::Resizer,
    opts: &fast_image_resize::ResizeOptions,
) {
    let img = image::open(path).unwrap();
    let rgb = img.to_rgb8();
    let (ow, oh) = rgb.dimensions();
    let aspect = ow as f32 / oh as f32;
    let (nw, nh) = if aspect > 1.0 {
        (target, (target as f32 / aspect).round() as u32)
    } else {
        ((target as f32 * aspect).round() as u32, target)
    };
    let src_buf = rgb.as_raw();
    let src = fast_image_resize::images::ImageRef::new(
        ow,
        oh,
        src_buf.as_slice(),
        fast_image_resize::PixelType::U8x3,
    )
    .unwrap();
    let mut dst = fast_image_resize::images::Image::from_vec_u8(
        nw,
        nh,
        vec![0u8; (nw * nh * 3) as usize],
        fast_image_resize::PixelType::U8x3,
    )
    .unwrap();
    resizer.resize(&src, &mut dst, Some(opts)).unwrap();
    build_tensor(dst.buffer(), target, nw, nh);
}

fn build_tensor(data: &[u8], target: u32, nw: u32, nh: u32) {
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
}

#[tokio::test]
async fn test_vector_indexing_and_clip_inference() {
    let temp_dir = tempdir().unwrap();
    let model_dir = temp_dir.path().join("models");
    let index_path = temp_dir.path().join("vector_index.usearch");

    let model_manager = ModelManager::new(&model_dir, DevicePreference::Auto);
    model_manager
        .init()
        .expect("Failed to initialize CLIP models");

    assert!(model_dir.join("clip-vit-b32").join("vision_model.onnx").exists());
    assert!(model_dir.join("clip-vit-b32").join("text_model.onnx").exists());
    assert!(model_dir.join("clip-vit-b32").join("tokenizer.json").exists());

    let test_image_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("test_images")
        .join("augh.png");
    let test_image_path = test_image_path.to_str().expect("path is valid UTF-8");

    let image_embedding = model_manager
        .generate_image_embedding(test_image_path)
        .expect("Failed to generate image embedding");
    assert_eq!(image_embedding.len(), 512);

    let text_embedding = model_manager
        .generate_text_embedding("a picture of a cat")
        .expect("Failed to generate text embedding");
    assert_eq!(text_embedding.len(), 512);

    let index = VectorIndex::new(&index_path, 512).expect("Failed to initialize vector index");
    index
        .add(42, &image_embedding)
        .expect("Failed to add vector to index");

    let search_results = index
        .search(&text_embedding, 1)
        .expect("Failed to search index");
    assert_eq!(search_results.len(), 1);
    assert_eq!(search_results[0].0, 42);
}

#[tokio::test]
async fn test_text_similarity_and_padding_behavior() {
    use curator_core::ipc::EmbeddingModel;
    // Resolve models dir from CURATOR_DATA_DIR env var or workspace-relative .curator/models.
    // Run with: CURATOR_DATA_DIR=.curator cargo test -p curator-core test_text_similarity
    let data_dir_env = std::env::var("CURATOR_DATA_DIR").ok();
    let default_data_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join(".curator");
    let model_dir = match &data_dir_env {
        Some(p) => std::path::PathBuf::from(p).join("models"),
        None => default_data_dir.join("models"),
    };
    let model_dir = model_dir.as_path();

    let model_manager = ModelManager::new(&model_dir, DevicePreference::Cpu);
    model_manager
        .init()
        .expect("Failed to initialize CLIP models");

    for model in [EmbeddingModel::ClipVitB32, EmbeddingModel::MobileClipS2] {
        model_manager.set_active_model(model);
        model_manager.init().expect("Failed to init model");

        let cat = model_manager.generate_text_embedding("a picture of a cat").unwrap();
        let kitten = model_manager.generate_text_embedding("a cute kitten").unwrap();
        let car = model_manager.generate_text_embedding("a sports car on a highway").unwrap();

        let sim_cat_kitten: f32 = cat.iter().zip(&kitten).map(|(a, b)| a * b).sum();
        let sim_cat_car: f32 = cat.iter().zip(&car).map(|(a, b)| a * b).sum();

        println!("\n=== Text Similarity Test ({:?}) ===", model);
        println!("Similarity('a picture of a cat', 'a cute kitten'): {:.4}", sim_cat_kitten);
        println!("Similarity('a picture of a cat', 'a sports car on a highway'): {:.4}", sim_cat_car);
    }
}

