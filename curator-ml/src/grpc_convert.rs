//! Conversions between `curator-ml`-owned domain types and the prost-generated
//! protobuf structs.
//!
//! These impls live here (not in `curator-core`) because the orphan rule
//! requires at least one of the impl'd types to be local to the implementing
//! crate, and the detection/tagger/concept types now live in `curator-ml`
//! while the gRPC structs live in `curator-proto`. Downstream consumers
//! (`curator-service`) use `.into()` on `curator_core::detection::*` /
//! `curator_core::tagger::*` re-exports, which resolve to these impls.

use crate::detection::{
    CharacterIdentity, CharacterSearchEntry, DetectionCropEntry, DetectionResult, ReidentifyResult,
    StoredDetection,
};
use crate::tagger::TaggerStatusInfo;
use curator_proto::grpc::common as commonpb;

impl From<TaggerStatusInfo> for commonpb::TaggerStatusInfo {
    fn from(v: TaggerStatusInfo) -> Self {
        commonpb::TaggerStatusInfo {
            key: v.key,
            name: v.name,
            source_name: v.source_name,
            loaded: v.loaded,
            model_path: v.model_path,
            total_tags: v.total_tags as u32,
            default_threshold: v.default_threshold,
            input_size: v.input_size,
        }
    }
}

impl From<StoredDetection> for commonpb::StoredDetection {

    fn from(v: StoredDetection) -> Self {
        commonpb::StoredDetection {
            id: v.id,
            image_id: v.image_id,
            x0: v.x0,
            y0: v.y0,
            x1: v.x1,
            y1: v.y1,
            confidence: v.confidence,
            has_embedding: v.has_embedding,
            identity_id: v.identity_id,
        }
    }
}

impl From<DetectionResult> for commonpb::DetectionResult {
    fn from(v: DetectionResult) -> Self {
        commonpb::DetectionResult {
            image_id: v.image_id,
            detections: v.detections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<DetectionCropEntry> for commonpb::DetectionCropEntry {
    fn from(v: DetectionCropEntry) -> Self {
        commonpb::DetectionCropEntry {
            detection_id: v.detection_id,
            crop_webp_bytes: v.crop_webp_bytes,
        }
    }
}

impl From<CharacterSearchEntry> for commonpb::CharacterSearchEntry {
    fn from(v: CharacterSearchEntry) -> Self {
        commonpb::CharacterSearchEntry {
            identity_id: v.identity_id,
            image_ids: v.image_ids,
        }
    }
}

impl From<CharacterIdentity> for commonpb::CharacterIdentity {
    fn from(v: CharacterIdentity) -> Self {
        commonpb::CharacterIdentity {
            id: v.id,
            name: v.name,
            detection_count: v.detection_count,
            created_at: v.created_at,
        }
    }
}

impl From<ReidentifyResult> for commonpb::ReidentifyResult {
    fn from(v: ReidentifyResult) -> Self {
        commonpb::ReidentifyResult {
            total_detections: v.total_detections,
            matched: v.matched,
            unmatched: v.unmatched,
        }
    }
}