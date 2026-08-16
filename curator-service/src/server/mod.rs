pub mod benchmarks;
pub mod characters;
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

use std::fmt::Display;
use std::sync::Arc;

use tonic::Status;

use crate::ClientContext;

/// Convert any displayable error into a tonic `Status::internal`, so handlers never
/// repeat the same `map_err(|e| Status::internal(e.to_string()))` boilerplate.
pub(crate) fn internal_status<E: Display>(e: E) -> Status {
    Status::internal(e.to_string())
}

/// Resolve the preferred tagger's source name from shared settings.
/// Shared by all gRPC server handlers that need a tag source filter.
pub(crate) async fn preferred_source(ctx: &Arc<ClientContext>) -> String {
    let s = ctx.settings.lock().await;
    s.preferred_tagger.source_name().to_string()
}

