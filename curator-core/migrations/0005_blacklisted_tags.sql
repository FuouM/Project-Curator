-- Add is_blacklisted column to image_tags for AI negative samples
ALTER TABLE image_tags ADD COLUMN is_blacklisted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_image_tags_blacklisted ON image_tags(image_id, is_blacklisted);
