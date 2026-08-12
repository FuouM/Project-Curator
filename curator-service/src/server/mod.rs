pub mod benchmarks;
pub mod characters;
pub mod concepts;
pub mod convert;
pub mod folders;
pub mod gallery;
pub mod import;
pub mod models;
pub mod ocr;
pub mod parser;
pub mod plugins;
pub mod search;
pub mod system;
pub mod tagging;
pub mod tags;
pub mod tools;

use std::sync::Arc;

use crate::ClientContext;

/// Resolve the preferred tagger's source name from shared settings.
/// Shared by all gRPC server handlers that need a tag source filter.
pub(crate) async fn preferred_source(ctx: &Arc<ClientContext>) -> String {
    let s = ctx.settings.lock().await;
    s.preferred_tagger.source_name().to_string()
}

