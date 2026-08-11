-- Track all known file paths for each image, so files can be recovered
-- after external moves or deduplication.
CREATE TABLE image_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    UNIQUE(image_id, path)
);

CREATE INDEX idx_image_paths_image_id ON image_paths(image_id);
CREATE INDEX idx_image_paths_path ON image_paths(path);

-- Backfill from existing current_filepath
INSERT OR IGNORE INTO image_paths (image_id, path)
SELECT id, current_filepath FROM images WHERE deleted_at IS NULL;
