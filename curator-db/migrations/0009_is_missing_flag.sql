-- Add is_missing column for background file-existence reconciliation
ALTER TABLE images ADD COLUMN is_missing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_images_is_missing ON images(is_missing);
