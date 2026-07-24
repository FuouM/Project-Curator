pub mod device;
pub mod hash;
pub mod model_manager;
pub mod vector_index;

pub use device::apply_device_preference;
pub use hash::compute_ahash;
pub use model_manager::ModelManager;
pub use vector_index::VectorIndex;

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
