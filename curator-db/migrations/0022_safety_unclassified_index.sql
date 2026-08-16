-- Migration: 0022_safety_unclassified_index.sql
-- Partial index to accelerate background safety classification queries.
CREATE INDEX IF NOT EXISTS idx_images_safety_unclassified 
ON images (id) 
WHERE safe_score IS NULL AND deleted_at IS NULL AND is_missing = 0;
