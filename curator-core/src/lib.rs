pub mod grpc_convert;
pub mod ipc;
pub mod vector;

// ── curator-proto (gRPC stubs + shared kernel contracts) ────────────────
pub use curator_proto::grpc;
pub use curator_proto::{constants, pipeline, util};
pub use curator_proto::pipeline::{NodeInfo, NodeRegistry, Port, SystemNode};
pub use curator_proto::contracts::{DevicePreference, EmbeddingModel, ModelPrecision, TaggerModel};

// ── curator-filename-parser ─────────────────────────────────────────────
pub use curator_filename_parser as filename_parser;
pub use curator_filename_parser::{FilenameParser, ParsedMetadata};

// ── curator-media ───────────────────────────────────────────────────────
pub use curator_media as media_engine;
pub use curator_media::convert;
pub use curator_media::crop_cache;
pub use curator_media::decode as image_decode;
pub use curator_media::gif;
pub use curator_media::media;
pub use curator_media::thumbnail;
pub use curator_media::transcode;
pub use curator_media::video;
pub use curator_media::CropCache;
pub use curator_media::media::{is_gif, read_dimensions, read_gif_animation, sha256_file, AnimationInfo};
pub use curator_media::video::{decode_path, is_video, VideoInfo};


// ── curator-db ──────────────────────────────────────────────────────────
pub use curator_db as db;
pub use curator_db::{
    init_db, models, open_plugin_db, plugin_data_root, plugin_db_execute, plugin_db_query,
    FolderRepo, ImageRepo, SourceRepo, TagRepo, VectorIndex,
};


// ── curator-ml ──────────────────────────────────────────────────────────
pub use curator_ml::{benchmark, detection, onnx, preprocess, tagger};
pub use curator_ml::onnx::ManagedSession;
pub use curator_ml::detection::{
    BubbleDetection, CCIPModel, DetectionPipeline, MangaBubbleDetector, OcrDetection, OcrDetector,
    YoloDetector,
};
pub use curator_ml::tagger::{TagPrediction, TaggerEngine, TaggerManager};


// ── image crate re-export (historical `curator_core::image::*` path) ─────
pub use image;