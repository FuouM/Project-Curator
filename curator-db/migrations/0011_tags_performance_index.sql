-- Add covering composite index on tags (category, name) to make filtering and sorting instant
CREATE INDEX IF NOT EXISTS idx_tags_category_name ON tags (category, name);
