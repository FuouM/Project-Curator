pub mod benchmark;
pub mod concept;
pub mod constants;
pub mod crop_cache;
pub mod db;
pub mod detection;
pub mod filename_parser;
pub mod image_decode;
pub mod ipc;
pub mod onnx;
pub mod preprocess;
pub mod tagger;
pub mod thumbnail;
pub mod vector;

pub use onnx::ManagedSession;

pub use benchmark::{
    benchmark_preprocess, run_detection_benchmark, run_onnx_benchmark,
    run_onnx_benchmark_2d, run_onnx_benchmark_4d, get_benchmark_images, run_single_image_benchmark,
    DetectionBenchmarkResult, SingleImageBenchmarkResult,
};
pub use crop_cache::CropCache;
pub use db::init_db;
pub use db::models;
pub use detection::{CCIPModel, DetectionPipeline, YoloDetector, OcrDetector, OcrDetection};
pub use filename_parser::FilenameParser;
pub use ipc::{DevicePreference, ImageDetails, Request, Response, SearchMatch, TagSummary, OcrResult};
pub use tagger::{TagPrediction, TaggerEngine};
pub use vector::{ModelManager, VectorIndex, apply_device_preference};
pub use image;

pub mod grpc {
    tonic::include_proto!("curator");
}
