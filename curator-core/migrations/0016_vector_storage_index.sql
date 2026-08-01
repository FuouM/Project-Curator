-- Migration: 0016_vector_storage_index.sql

-- 1. Store the CLIP embedding BLOB on image_vectors so concept prototype
--    rebuilds reuse persisted vectors instead of falling back to full
--    ONNX inference per sample image on every concept create/update.
--    Existing 'ready' rows keep a NULL blob until the next reindex.
ALTER TABLE image_vectors ADD COLUMN vector BLOB;

-- 2. Index for the background worker's pending-state poll and status
--    counts. Previously a full-table scan of image_vectors ran every
--    3 seconds plus on every status/dashboard refresh.
CREATE INDEX IF NOT EXISTS idx_image_vectors_src_state ON image_vectors(source_id, vector_state);
