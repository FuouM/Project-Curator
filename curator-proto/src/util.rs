use std::time::{SystemTime, UNIX_EPOCH};

/// Returns the current time as seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Returns a sort priority for a tag category string.
/// Lower values sort first: user > character > copyright > meta > other.
pub fn tag_sort_priority(category: &str) -> i32 {
    match category {
        "user" => 0,
        "character" => 1,
        "copyright" => 2,
        "meta" => 3,
        _ => 4,
    }
}
