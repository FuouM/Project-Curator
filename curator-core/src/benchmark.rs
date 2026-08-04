use anyhow::{Context, Result};
use ndarray::{Array2, Array4};
use ort::{inputs, session::Session, value::TensorRef};
use std::path::Path;
use std::time::Instant;

use crate::image_decode;

use crate::thumbnail;
use crate::vector::ModelManager;
use serde::{Deserialize, Serialize};



const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PAD_COLOR: [u8; 3] = [124, 116, 104];

/// Benchmark image preprocessing stages: decode, resize, normalize.
pub fn benchmark_preprocess(
    image_path: &Path,
    target_size: u32,
    runs: usize,
) -> Result<(f64, f64, f64, String)> {
    // Warmup
    let _ = image::open(image_path)?;

    let (t_tri_decode, t_tri_resize, t_tri_norm) = bench_resize_method(
        image_path,
        target_size,
        runs,
        image::imageops::FilterType::Triangle,
        "image::Triangle",
    )?;

    let (t_near_decode, t_near_resize, t_near_norm) = bench_resize_method(
        image_path,
        target_size,
        runs,
        image::imageops::FilterType::Nearest,
        "image::Nearest",
    )?;

    let (t_cat_decode, t_cat_resize, t_cat_norm) = bench_resize_method(
        image_path,
        target_size,
        runs,
        image::imageops::FilterType::CatmullRom,
        "image::CatmullRom",
    )?;

    let (t_fir_decode, t_fir_resize, t_fir_norm) =
        bench_fast_image_resize(image_path, target_size, runs)?;

    let report = format!(
        "Preprocess benchmark ({}, {}x{}, {} runs):\n\
         {:<25} decode={:>7.1}ms  resize={:>7.1}ms  normalize={:>7.1}ms  total={:>7.1}ms\n\
         {:<25} decode={:>7.1}ms  resize={:>7.1}ms  normalize={:>7.1}ms  total={:>7.1}ms\n\
         {:<25} decode={:>7.1}ms  resize={:>7.1}ms  normalize={:>7.1}ms  total={:>7.1}ms\n\
         {:<25} decode={:>7.1}ms  resize={:>7.1}ms  normalize={:>7.1}ms  total={:>7.1}ms",
        image_path.file_name().unwrap_or_default().to_string_lossy(),
        target_size,
        target_size,
        runs,
        "image::Triangle",
        t_tri_decode,
        t_tri_resize,
        t_tri_norm,
        t_tri_decode + t_tri_resize + t_tri_norm,
        "image::Nearest",
        t_near_decode,
        t_near_resize,
        t_near_norm,
        t_near_decode + t_near_resize + t_near_norm,
        "image::CatmullRom",
        t_cat_decode,
        t_cat_resize,
        t_cat_norm,
        t_cat_decode + t_cat_resize + t_cat_norm,
        "fast_image_resize::Bilinear",
        t_fir_decode,
        t_fir_resize,
        t_fir_norm,
        t_fir_decode + t_fir_resize + t_fir_norm,
    );

    Ok((t_tri_decode, t_tri_resize, t_tri_norm, report))
}

fn bench_resize_method(
    image_path: &Path,
    target_size: u32,
    runs: usize,
    filter: image::imageops::FilterType,
    _label: &str,
) -> Result<(f64, f64, f64)> {
    let mut total_decode = 0.0;
    let mut total_resize = 0.0;
    let mut total_norm = 0.0;

    for _ in 0..runs {
        let t0 = Instant::now();
        let img = image::open(image_path)?;
        let img = img.to_rgb8();
        let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let (ow, oh) = img.dimensions();
        let aspect = ow as f32 / oh as f32;
        let (nw, nh) = if aspect > 1.0 {
            (target_size, (target_size as f32 / aspect).round() as u32)
        } else {
            ((target_size as f32 * aspect).round() as u32, target_size)
        };

        let t1 = Instant::now();
        let resized = image::imageops::resize(&img, nw, nh, filter);
        let resize_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        let data = resized.as_raw();
        let s = target_size as usize;
        let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
        let slice = tensor.as_slice_mut().unwrap();
        let px = ((target_size - nw) / 2) as usize;
        let py = ((target_size - nh) / 2) as usize;
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
        let norm_ms = t2.elapsed().as_secs_f64() * 1000.0;

        total_decode += decode_ms;
        total_resize += resize_ms;
        total_norm += norm_ms;
    }

    Ok((
        total_decode / runs as f64,
        total_resize / runs as f64,
        total_norm / runs as f64,
    ))
}

fn bench_fast_image_resize(
    image_path: &Path,
    target_size: u32,
    runs: usize,
) -> Result<(f64, f64, f64)> {
    use fast_image_resize::images::{Image, ImageRef};
    use fast_image_resize::{FilterType as FirFilter, ResizeAlg, ResizeOptions, Resizer};

    let mut total_decode = 0.0;
    let mut total_resize = 0.0;
    let mut total_norm = 0.0;

    let mut resizer = Resizer::new();
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FirFilter::Bilinear));

    for _ in 0..runs {
        let t0 = Instant::now();
        let img = image::open(image_path)?;
        let img = img.to_rgb8();
        let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let (ow, oh) = img.dimensions();
        let aspect = ow as f32 / oh as f32;
        let (nw, nh) = if aspect > 1.0 {
            (target_size, (target_size as f32 / aspect).round() as u32)
        } else {
            ((target_size as f32 * aspect).round() as u32, target_size)
        };

        let t1 = Instant::now();
        let src_buf = img.as_raw();
        let src = ImageRef::new(
            ow,
            oh,
            src_buf.as_slice(),
            fast_image_resize::PixelType::U8x3,
        )?;
        let dst_buf = vec![0u8; (nw * nh * 3) as usize];
        let mut dst = Image::from_vec_u8(nw, nh, dst_buf, fast_image_resize::PixelType::U8x3)?;
        resizer.resize(&src, &mut dst, Some(&opts))?;
        let resized_buf = dst.buffer();
        let resize_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        let s = target_size as usize;
        let mut tensor = Array4::<f32>::zeros((1, 3, s, s));
        let slice = tensor.as_slice_mut().unwrap();
        let px = ((target_size - nw) / 2) as usize;
        let py = ((target_size - nh) / 2) as usize;
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
                    let val = resized_buf[sr + x * 3] as f32 / 255.0;
                    slice[dr + x] = (val - mean) / std_dev;
                }
            }
        }
        let norm_ms = t2.elapsed().as_secs_f64() * 1000.0;

        total_decode += decode_ms;
        total_resize += resize_ms;
        total_norm += norm_ms;
    }

    Ok((
        total_decode / runs as f64,
        total_resize / runs as f64,
        total_norm / runs as f64,
    ))
}

pub fn run_onnx_benchmark(
    model_path: &Path,
    img_size: usize,
) -> Result<(f64, Option<f64>, Option<String>, bool)> {
    if !model_path.exists() {
        anyhow::bail!("Model path does not exist: {:?}", model_path);
    }

    let mut cpu_session = Session::builder()?
        .with_intra_threads(1)?
        .commit_from_file(model_path)
        .context("Failed to load benchmark model on CPU")?;

    let dummy_input = Array4::<f32>::zeros((1, 3, img_size, img_size));

    let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;

    let runs = 5;
    let start = Instant::now();
    for _ in 0..runs {
        let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;
    }
    let cpu_time = start.elapsed().as_secs_f64() * 1000.0 / (runs as f64);

    let has_gpu = cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ));
    let mut gpu_time = None;
    let mut gpu_err = None;

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut builder = Session::builder()?.with_intra_threads(1)?;
        let mut provider_registered = false;

        #[cfg(target_os = "windows")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::DirectML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::CoreML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let mut registered = false;
            if builder
                .clone()
                .with_execution_providers([ort::ep::CUDA::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                    registered = true;
                }
            }
            if !registered {
                if builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                    .is_ok()
                {
                    if let Ok(b) = builder
                        .clone()
                        .with_execution_providers([ort::ep::ROCm::default().build()])
                    {
                        builder = b;
                        provider_registered = true;
                    }
                }
            }
        }

        if provider_registered {
            match builder.commit_from_file(model_path) {
                Ok(mut gpu_session) => {
                    if gpu_session
                        .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                        .is_ok()
                    {
                        let start = Instant::now();
                        let mut success = true;
                        for _ in 0..runs {
                            if gpu_session
                                .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                                .is_err()
                            {
                                success = false;
                                break;
                            }
                        }
                        if success {
                            gpu_time = Some(start.elapsed().as_secs_f64() * 1000.0 / (runs as f64));
                        } else {
                            gpu_err = Some("GPU run loop failed".to_string());
                        }
                    } else {
                        gpu_err = Some("GPU warmup run failed".to_string());
                    }
                }
                Err(e) => {
                    gpu_err = Some(format!("Failed to commit GPU session: {:?}", e));
                }
            }
        } else {
            gpu_err = Some("No GPU provider registered successfully".to_string());
        }
    }

    Ok((cpu_time, gpu_time, gpu_err, has_gpu))
}

pub fn run_onnx_benchmark_2d(
    model_path: &Path,
    rows: usize,
    cols: usize,
) -> Result<(f64, Option<f64>, Option<String>, bool)> {
    if !model_path.exists() {
        anyhow::bail!("Model path does not exist: {:?}", model_path);
    }

    let mut cpu_session = Session::builder()?
        .with_intra_threads(1)?
        .commit_from_file(model_path)
        .context("Failed to load benchmark model on CPU")?;

    let dummy_input = Array2::<f32>::zeros((rows, cols));

    let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;

    let runs = 5;
    let start = Instant::now();
    for _ in 0..runs {
        let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;
    }
    let cpu_time = start.elapsed().as_secs_f64() * 1000.0 / (runs as f64);

    let has_gpu = cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ));
    let mut gpu_time = None;
    let mut gpu_err = None;

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut builder = Session::builder()?.with_intra_threads(1)?;
        let mut provider_registered = false;

        #[cfg(target_os = "windows")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::DirectML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::CoreML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let mut registered = false;
            if builder
                .clone()
                .with_execution_providers([ort::ep::CUDA::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                    registered = true;
                }
            }
            if !registered {
                if builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                    .is_ok()
                {
                    if let Ok(b) = builder
                        .clone()
                        .with_execution_providers([ort::ep::ROCm::default().build()])
                    {
                        builder = b;
                        provider_registered = true;
                    }
                }
            }
        }

        if provider_registered {
            match builder.commit_from_file(model_path) {
                Ok(mut gpu_session) => {
                    if gpu_session
                        .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                        .is_ok()
                    {
                        let start = Instant::now();
                        let mut success = true;
                        for _ in 0..runs {
                            if gpu_session
                                .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                                .is_err()
                            {
                                success = false;
                                break;
                            }
                        }
                        if success {
                            gpu_time = Some(start.elapsed().as_secs_f64() * 1000.0 / (runs as f64));
                        } else {
                            gpu_err = Some("GPU run loop failed".to_string());
                        }
                    } else {
                        gpu_err = Some("GPU warmup run failed".to_string());
                    }
                }
                Err(e) => {
                    gpu_err = Some(format!("Failed to commit GPU session: {:?}", e));
                }
            }
        } else {
            gpu_err = Some("No GPU provider registered successfully".to_string());
        }
    }

    Ok((cpu_time, gpu_time, gpu_err, has_gpu))
}

pub fn run_onnx_benchmark_4d(
    model_path: &Path,
    height: usize,
    width: usize,
) -> Result<(f64, Option<f64>, Option<String>, bool)> {
    if !model_path.exists() {
        anyhow::bail!("Model path does not exist: {:?}", model_path);
    }

    let mut cpu_session = Session::builder()?
        .with_intra_threads(1)?
        .commit_from_file(model_path)
        .context("Failed to load benchmark model on CPU")?;

    let dummy_input = Array4::<f32>::zeros((1, 3, height, width));

    let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;

    let runs = 5;
    let start = Instant::now();
    for _ in 0..runs {
        let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;
    }
    let cpu_time = start.elapsed().as_secs_f64() * 1000.0 / (runs as f64);

    let has_gpu = cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ));
    let mut gpu_time = None;
    let mut gpu_err = None;

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut builder = Session::builder()?.with_intra_threads(1)?;
        let mut provider_registered = false;

        #[cfg(target_os = "windows")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::DirectML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if builder
                .clone()
                .with_execution_providers([ort::ep::CoreML::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let mut registered = false;
            if builder
                .clone()
                .with_execution_providers([ort::ep::CUDA::default().build()])
                .is_ok()
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    builder = b;
                    provider_registered = true;
                    registered = true;
                }
            }
            if !registered {
                if builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                    .is_ok()
                {
                    if let Ok(b) = builder
                        .clone()
                        .with_execution_providers([ort::ep::ROCm::default().build()])
                    {
                        builder = b;
                        provider_registered = true;
                    }
                }
            }
        }

        if provider_registered {
            match builder.commit_from_file(model_path) {
                Ok(mut gpu_session) => {
                    if gpu_session
                        .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                        .is_ok()
                    {
                        let start = Instant::now();
                        let mut success = true;
                        for _ in 0..runs {
                            if gpu_session
                                .run(inputs![TensorRef::from_array_view(&dummy_input)?])
                                .is_err()
                            {
                                success = false;
                                break;
                            }
                        }
                        if success {
                            gpu_time = Some(start.elapsed().as_secs_f64() * 1000.0 / (runs as f64));
                        } else {
                            gpu_err = Some("GPU run loop failed".to_string());
                        }
                    } else {
                        gpu_err = Some("GPU warmup run failed".to_string());
                    }
                }
                Err(e) => {
                    gpu_err = Some(format!("Failed to commit GPU session: {:?}", e));
                }
            }
        } else {
            gpu_err = Some("No GPU provider registered successfully".to_string());
        }
    }

    Ok((cpu_time, gpu_time, gpu_err, has_gpu))
}

pub struct DetectionBenchmarkResult {
    pub yolo_cpu_ms: f64,
    pub yolo_gpu_ms: Option<f64>,
    pub yolo_gpu_error: Option<String>,
    pub ccip_feat_cpu_ms: f64,
    pub ccip_feat_gpu_ms: Option<f64>,
    pub ccip_feat_gpu_error: Option<String>,
    pub ccip_metrics_cpu_ms: f64,
    pub ccip_metrics_gpu_ms: Option<f64>,
    pub ccip_metrics_gpu_error: Option<String>,
    pub has_gpu: bool,
}

pub fn run_detection_benchmark(
    yolo_path: &Path,
    ccip_feat_path: &Path,
    ccip_metrics_path: &Path,
) -> Result<DetectionBenchmarkResult> {
    let (yolo_cpu, yolo_gpu, yolo_err, has_gpu) =
        run_onnx_benchmark(yolo_path, 640)?;

    let (ccip_feat_cpu, ccip_feat_gpu, ccip_feat_err, _) =
        run_onnx_benchmark(ccip_feat_path, 384)?;

    let (ccip_metrics_cpu, ccip_metrics_gpu, ccip_metrics_err, _) =
        run_onnx_benchmark_2d(ccip_metrics_path, 16, 768)?;

    Ok(DetectionBenchmarkResult {
        yolo_cpu_ms: yolo_cpu,
        yolo_gpu_ms: yolo_gpu,
        yolo_gpu_error: yolo_err,
        ccip_feat_cpu_ms: ccip_feat_cpu,
        ccip_feat_gpu_ms: ccip_feat_gpu,
        ccip_feat_gpu_error: ccip_feat_err,
        ccip_metrics_cpu_ms: ccip_metrics_cpu,
        ccip_metrics_gpu_ms: ccip_metrics_gpu,
        ccip_metrics_gpu_error: ccip_metrics_err,
        has_gpu,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SingleImageBenchmarkResult {
    pub decode_time_ms: f64,
    pub thumbnail_time_ms: f64,
    pub clip_preprocess_time_ms: f64,
    pub tagger_preprocess_time_ms: f64,
    pub yolo_preprocess_time_ms: f64,
    pub ccip_extract_preprocess_time_ms: f64,
    pub ocr_det_preprocess_time_ms: f64,
    pub ocr_rec_preprocess_time_ms: f64,
}

pub async fn get_benchmark_images(
    db: &sqlx::SqlitePool,
    limit: usize,
) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT current_filepath FROM images WHERE deleted_at IS NULL AND is_missing = 0 LIMIT ?"
    )
    .bind(limit as i64)
    .fetch_all(db)
    .await?;

    let mut valid_paths = Vec::new();
    for (filepath,) in rows {
        if std::path::Path::new(&filepath).exists() {
            valid_paths.push(filepath);
        }
    }
    Ok(valid_paths)
}

pub async fn run_single_image_benchmark(
    model_manager: &ModelManager,
    filepath: &str,
    tagger_spec: &'static crate::tagger::TaggerModelSpec,
) -> Result<SingleImageBenchmarkResult> {
    let path = std::path::Path::new(filepath);
    if !path.exists() {
        anyhow::bail!("Image file does not exist: {}", filepath);
    }
    benchmark_image(model_manager, path, tagger_spec).await
}

async fn benchmark_image(
    model_manager: &ModelManager,
    path: &std::path::Path,
    tagger_spec: &'static crate::tagger::TaggerModelSpec,
) -> Result<SingleImageBenchmarkResult> {
    let mut resizer = fast_image_resize::Resizer::new();

    // 1. Decode
    let start_decode = Instant::now();
    let (rgb_buf, width, height) = image_decode::decode_rgb(path)?;
    let decode_time_ms = start_decode.elapsed().as_secs_f64() * 1000.0;

    let img = image::RgbImage::from_raw(width, height, rgb_buf).ok_or_else(|| anyhow::anyhow!("Failed to parse raw RgbImage"))?;

    // 2. Thumbnail
    let start_thumb = Instant::now();
    let _ = thumbnail::generate_thumbnail(path, 200);
    let thumbnail_time_ms = start_thumb.elapsed().as_secs_f64() * 1000.0;

    // 3. CLIP Preprocess
    let start_clip_pre = Instant::now();
    let _ = model_manager.preprocess_image_batch(&[path]);
    let clip_preprocess_time_ms = start_clip_pre.elapsed().as_secs_f64() * 1000.0;

    // 4. Tagger Preprocess (uses the preferred tagger's size + normalization)
    let start_tagger_pre = Instant::now();
    let _ = crate::tagger::preprocess::preprocess_image(
        path,
        tagger_spec.input_size,
        &tagger_spec.mean,
        &tagger_spec.std,
        &tagger_spec.pad_color,
        &mut resizer,
    );
    let tagger_preprocess_time_ms = start_tagger_pre.elapsed().as_secs_f64() * 1000.0;

    // 5. YOLO Preprocess
    let start_yolo_pre = Instant::now();
    let _ = crate::detection::yolo::preprocess_yolo(&img, 640);
    let yolo_preprocess_time_ms = start_yolo_pre.elapsed().as_secs_f64() * 1000.0;

    // 6. CCIP Crop & Preprocess
    let start_ccip_pre = Instant::now();
    let _ = crate::detection::ccip::preprocess_ccip(&img, 384);
    let ccip_extract_preprocess_time_ms = start_ccip_pre.elapsed().as_secs_f64() * 1000.0;

    // 7. OCR Preprocessing (Det & Rec)
    let start_ocr_det = Instant::now();
    let _ = crate::detection::ocr::preprocess_det(&img);
    let ocr_det_preprocess_time_ms = start_ocr_det.elapsed().as_secs_f64() * 1000.0;

    let start_ocr_rec = Instant::now();
    let _ = crate::detection::ocr::preprocess_rec(&img);
    let ocr_rec_preprocess_time_ms = start_ocr_rec.elapsed().as_secs_f64() * 1000.0;

    Ok(SingleImageBenchmarkResult {
        decode_time_ms,
        thumbnail_time_ms,
        clip_preprocess_time_ms,
        tagger_preprocess_time_ms,
        yolo_preprocess_time_ms,
        ccip_extract_preprocess_time_ms,
        ocr_det_preprocess_time_ms,
        ocr_rec_preprocess_time_ms,
    })
}

