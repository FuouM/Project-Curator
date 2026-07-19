use std::path::Path;
use std::time::Instant;
use anyhow::{Context, Result};
use ndarray::Array4;
use ort::{inputs, session::Session, value::TensorRef};

pub fn run_onnx_benchmark(model_path: &Path, img_size: usize) -> Result<(f64, Option<f64>, Option<String>, bool)> {
    if !model_path.exists() {
        anyhow::bail!("Model path does not exist: {:?}", model_path);
    }

    // 1. Run CPU Benchmark
    let mut cpu_session = Session::builder()?
        .with_intra_threads(1)?
        .commit_from_file(model_path)
        .context("Failed to load benchmark model on CPU")?;

    let dummy_input = Array4::<f32>::zeros((1, 3, img_size, img_size));

    // Warmup
    let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;

    // Benchmark loop
    let runs = 5;
    let start = Instant::now();
    for _ in 0..runs {
        let _ = cpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?])?;
    }
    let cpu_time = start.elapsed().as_secs_f64() * 1000.0 / (runs as f64);

    // 2. Run GPU Benchmark
    let mut has_gpu = false;
    let mut gpu_time = None;
    let mut gpu_err = None;

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        has_gpu = true;
        let mut builder = Session::builder()?.with_intra_threads(1)?;
        let mut provider_registered = false;

        #[cfg(target_os = "windows")]
        {
            if builder.clone().with_execution_providers([ort::ep::DirectML::default().build()]).is_ok() {
                if let Ok(b) = builder.clone().with_execution_providers([ort::ep::DirectML::default().build()]) {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if builder.clone().with_execution_providers([ort::ep::CoreML::default().build()]).is_ok() {
                if let Ok(b) = builder.clone().with_execution_providers([ort::ep::CoreML::default().build()]) {
                    builder = b;
                    provider_registered = true;
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let mut registered = false;
            if builder.clone().with_execution_providers([ort::ep::CUDA::default().build()]).is_ok() {
                if let Ok(b) = builder.clone().with_execution_providers([ort::ep::CUDA::default().build()]) {
                    builder = b;
                    provider_registered = true;
                    registered = true;
                }
            }
            if !registered {
                if builder.clone().with_execution_providers([ort::ep::ROCm::default().build()]).is_ok() {
                    if let Ok(b) = builder.clone().with_execution_providers([ort::ep::ROCm::default().build()]) {
                        builder = b;
                        provider_registered = true;
                    }
                }
            }
        }

        if provider_registered {
            match builder.commit_from_file(model_path) {
                Ok(mut gpu_session) => {
                    // Warmup
                    if gpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?]).is_ok() {
                        // Benchmark loop
                        let start = Instant::now();
                        let mut success = true;
                        for _ in 0..runs {
                            if gpu_session.run(inputs![TensorRef::from_array_view(&dummy_input)?]).is_err() {
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
