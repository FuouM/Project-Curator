-- Migration: 0012_db_performance_tuning.sql

-- 1. Covering composite index for phash queries to prevent table scans
DROP INDEX IF EXISTS idx_images_phash_covering;
CREATE INDEX IF NOT EXISTS idx_images_phash_covering ON images(phash) WHERE deleted_at IS NULL AND phash IS NOT NULL;

-- 2. Covering index for gallery listing and sorting - starts with is_missing to supersede idx_images_is_missing
DROP INDEX IF EXISTS idx_images_list_covering;
CREATE INDEX IF NOT EXISTS idx_images_list_covering ON images(is_missing, deleted_at, created_at DESC, id DESC);

-- 3. Composite index on image_tags to optimize tag statistics grouping/counting
DROP INDEX IF EXISTS idx_image_tags_stat;
CREATE INDEX IF NOT EXISTS idx_image_tags_stat ON image_tags(is_deleted, tag_id);

-- 4. Composite index on image_tags to optimize joins on image_id and avoid scans
DROP INDEX IF EXISTS idx_image_tags_join;
CREATE INDEX IF NOT EXISTS idx_image_tags_join ON image_tags(image_id, is_deleted);
