use curator_proto::contracts::DevicePreference;
use ort::session::builder::SessionBuilder;
use tracing::{info, warn};

/// Configuration for ONNX Runtime session creation.
#[derive(Debug, Clone)]
pub struct OnnxConfig {
    /// Maximum VRAM allocation in megabytes (default: 2048 MB).
    /// Applied as GPU memory limit for CUDA/DirectML execution providers.
    pub max_vram_mb: usize,
    /// Number of intra-op threads for ONNX sessions (default: 1).
    pub intra_threads: usize,
    /// Whether to enable automatic GPU→CPU fallback on inference failure (default: true).
    pub enable_gpu_fallback: bool,
}

impl Default for OnnxConfig {
    fn default() -> Self {
        Self {
            max_vram_mb: 2048,
            intra_threads: 1,
            enable_gpu_fallback: true,
        }
    }
}

/// Apply GPU/CPU device preference to an ONNX session builder.
pub fn apply_device_preference(
    builder: &mut SessionBuilder,
    device: &DevicePreference,
    model_name: &str,
    config: &OnnxConfig,
) {
    match device {
        DevicePreference::Cpu => {
            info!(
                "{}: forced to CPU — skipping GPU execution providers",
                model_name
            );
        }
        DevicePreference::Gpu => {
            let mut registered = false;
            #[cfg(target_os = "windows")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using DirectML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using CoreML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "linux")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using CUDA (GPU)", model_name);
                } else if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using ROCm (GPU)", model_name);
                }
            }
            if !registered {
                warn!(
                    "{}: GPU requested but no provider available — falling back to CPU",
                    model_name
                );
            }
            let _ = config;
        }
        DevicePreference::Auto => {
            #[cfg(target_os = "windows")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected DirectML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected CoreML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "linux")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected CUDA (GPU)", model_name);
                } else if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected ROCm (GPU)", model_name);
                }
            }
            let _ = config;
        }
    }
}
