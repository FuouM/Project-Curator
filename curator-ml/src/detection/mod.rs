pub mod bubbles;
pub mod ccip;
pub mod nms;
pub mod ocr;
pub mod pipeline;
pub mod types;
pub mod yolo;

pub use bubbles::{BubbleDetection, MangaBubbleDetector};
pub use ccip::CCIPModel;
pub use ocr::{OcrDetection, OcrDetector};
pub use pipeline::DetectionPipeline;
pub use pipeline::extract_crop;
pub use types::*;
pub use yolo::YoloDetector;
