-- Migration: 0018_image_media_metadata.sql

-- Dimensions for every imported image (header-only read, near-zero cost).
-- These rarely change for a given file, so they live on the images table.
ALTER TABLE images ADD COLUMN width INTEGER;
ALTER TABLE images ADD COLUMN height INTEGER;

-- Animated media details (GIF today; animated WebP can reuse this later).
-- Only animated files get a row here; static images have no row.
CREATE TABLE image_animation_metadata (
    image_id    INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    format      TEXT NOT NULL,
    frame_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,          -- raw sum of GCE delays * 10ms
    loop_count  INTEGER,                   -- NULL = no Netscape loop ext; 0 = infinite
    is_animated INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
