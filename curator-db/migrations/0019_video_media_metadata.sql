-- Migration: 0019_video_media_metadata.sql
-- Video stream & container metadata (MP4, WebM).
-- Note: width and height are stored on the parent `images` table (added in 0018).
CREATE TABLE video_media_metadata (
    image_id     INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
    format       TEXT NOT NULL,          -- 'mp4', 'webm'
    duration_ms  INTEGER NOT NULL,       -- Total video duration in ms
    fps          REAL NOT NULL,          -- Frame rate (e.g. 29.97, 60.0)
    video_codec  TEXT NOT NULL,          -- e.g. 'h264', 'vp9', 'av1', 'hevc'
    audio_codec  TEXT,                   -- e.g. 'aac', 'opus', NULL if silent
    bitrate      INTEGER,                -- Total container bitrate in bps
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Absolute path to the extracted representative first-frame image used by the
-- AI pipeline (tagger / CLIP / perceptual hash) and static thumbnail fallback.
-- NULL for non-video assets. Derived cache data lives under the data dir, so
-- original video files are never mutated or decoded in full.
ALTER TABLE images ADD COLUMN video_frame_path TEXT;
