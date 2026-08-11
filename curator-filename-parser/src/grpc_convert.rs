//! Conversions between filename parsing domain types and the prost-generated
//! protobuf structs.
//!
//! These impls live here (not in `curator-core`) because the orphan rule
//! requires at least one of the impl'd types to be local to the implementing
//! crate, and both `ParsedMetadata`/`TokenBlock`/`BatchPreviewItem` and the
//! `curator-proto` gRPC structs are non-local to `curator-core`.
//! `curator-core` re-exports `curator-filename-parser`, so downstream
//! consumers using `.into()` still resolve these impls transparently.

use crate::{BatchPreviewItem, ParsedMetadata, TokenBlock};
use curator_proto::grpc::common as commonpb;

impl From<ParsedMetadata> for commonpb::ParsedMetadata {
    fn from(v: ParsedMetadata) -> Self {
        commonpb::ParsedMetadata {
            match_type: v.match_type,
            raw_matched: v.raw_matched,
            artist: v.artist,
            pixiv_id: v.pixiv_id,
            twitter_id: v.twitter_id,
            timestamp_4chan: v.timestamp_4chan,
            datetime_iso: v.datetime_iso,
            extracted_tags: v.extracted_tags,
            partial: v.partial,
        }
    }
}

impl From<commonpb::TokenBlock> for TokenBlock {
    fn from(v: commonpb::TokenBlock) -> Self {
        TokenBlock {
            token_type: v.token_type,
            value: v.value,
            label: v.label,
            enabled: v.enabled,
            optional_prefix: v.optional_prefix,
        }
    }
}

impl From<TokenBlock> for commonpb::TokenBlock {
    fn from(v: TokenBlock) -> Self {
        commonpb::TokenBlock {
            token_type: v.token_type,
            value: v.value,
            label: v.label,
            enabled: v.enabled,
            optional_prefix: v.optional_prefix,
        }
    }
}

impl From<BatchPreviewItem> for commonpb::BatchPreviewItem {
    fn from(v: BatchPreviewItem) -> Self {
        commonpb::BatchPreviewItem {
            image_id: v.image_id,
            filename: v.filename,
            filepath: v.filepath,
            match_result: v.match_result.map(Into::into),
        }
    }
}