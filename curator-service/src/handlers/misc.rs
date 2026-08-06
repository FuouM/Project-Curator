use curator_core::ipc::Response;
use std::path::Path;

pub async fn path_exists(path: &str) -> Response {
    let exists = Path::new(path).exists();
    Response::PathExistsResult { exists }
}
