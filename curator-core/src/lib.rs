pub mod benchmark;
pub mod concept;
pub mod constants;
pub mod crop_cache;
pub mod db;
pub mod detection;
pub mod filename_parser;
pub mod grpc_convert;
pub mod image_decode;
pub mod ipc;
pub mod media;
pub mod onnx;
pub mod pipeline;
pub mod preprocess;
pub mod tagger;
pub mod thumbnail;
pub mod util;
pub mod vector;
pub mod video;

pub use onnx::ManagedSession;

pub use pipeline::{NodeInfo, NodeRegistry, Port, SystemNode};

pub use benchmark::{
    benchmark_preprocess, run_detection_benchmark, run_onnx_benchmark,
    run_onnx_benchmark_2d, run_onnx_benchmark_4d, get_benchmark_images, run_single_image_benchmark,
    DetectionBenchmarkResult, SingleImageBenchmarkResult,
};
pub use crop_cache::CropCache;
pub use db::init_db;
pub use db::models;
pub use detection::{CCIPModel, DetectionPipeline, YoloDetector, OcrDetector, OcrDetection, BubbleDetection, MangaBubbleDetector};
pub use filename_parser::FilenameParser;
pub use ipc::{DevicePreference, ImageDetails, SearchMatch, TagSummary, OcrResult};
pub use media::{is_gif, read_dimensions, read_gif_animation, sha256_file, AnimationInfo};
pub use video::{decode_path, is_video, VideoInfo};
pub use tagger::{TagPrediction, TaggerEngine, TaggerManager};
pub use vector::{ModelManager, VectorIndex, apply_device_preference, OnnxConfig};
pub use image;

pub mod grpc {
    pub mod common {
        tonic::include_proto!("curator.common");
    }
    pub mod system {
        tonic::include_proto!("curator.system");
    }
    pub mod import {
        tonic::include_proto!("curator.import");
    }
    pub mod gallery {
        tonic::include_proto!("curator.gallery");
    }
    pub mod search {
        tonic::include_proto!("curator.search");
    }
    pub mod tags {
        tonic::include_proto!("curator.tags");
    }
    pub mod tagging {
        tonic::include_proto!("curator.tagging");
    }
    pub mod characters {
        tonic::include_proto!("curator.characters");
    }
    pub mod ocr {
        tonic::include_proto!("curator.ocr");
    }
    pub mod concepts {
        tonic::include_proto!("curator.concepts");
    }
    pub mod models {
        tonic::include_proto!("curator.models");
    }
    pub mod tools {
        tonic::include_proto!("curator.tools");
    }
    pub mod folders {
        tonic::include_proto!("curator.folders");
    }
    pub mod benchmarks {
        tonic::include_proto!("curator.benchmarks");
    }
    pub mod plugins {
        tonic::include_proto!("curator.plugins");
    }
    pub mod parser {
        tonic::include_proto!("curator.parser");
    }
}
