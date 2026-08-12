pub mod bubbles;
pub mod ccip;
pub mod pipeline;
pub mod types;
pub mod yolo;
pub mod ocr;
pub mod nms;

pub use pipeline::DetectionPipeline;
pub use types::*;
pub use yolo::YoloDetector;
pub use ccip::CCIPModel;
pub use bubbles::{BubbleDetection, MangaBubbleDetector};
pub use ocr::{OcrDetector, OcrDetection};
pub use pipeline::extract_crop;
