pub mod ccip;
pub mod pipeline;
pub mod types;
pub mod yolo;

pub use pipeline::DetectionPipeline;
pub use types::*;
pub use yolo::YoloDetector;
pub use ccip::CCIPModel;
