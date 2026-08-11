-- Migration: Add OCR detection and search schema
CREATE TABLE IF NOT EXISTS image_ocr_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    -- 4-point polygon representation for rotated text lines
    x0 INTEGER NOT NULL,
    y0 INTEGER NOT NULL,
    x1 INTEGER NOT NULL,
    y1 INTEGER NOT NULL,
    x2 INTEGER NOT NULL,
    y2 INTEGER NOT NULL,
    x3 INTEGER NOT NULL,
    y3 INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ocr_det_image ON image_ocr_detections(image_id);

-- FTS5 Virtual Table for full-text searching OCR text
CREATE VIRTUAL TABLE IF NOT EXISTS image_ocr_fts USING fts5(
    image_id UNINDEXED,
    text
);

-- Triggers to synchronize FTS with the primary OCR detection table
CREATE TRIGGER IF NOT EXISTS trg_ocr_insert AFTER INSERT ON image_ocr_detections BEGIN
    INSERT INTO image_ocr_fts(image_id, text) VALUES (new.image_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_ocr_delete BEFORE DELETE ON image_ocr_detections BEGIN
    DELETE FROM image_ocr_fts WHERE image_id = old.image_id;
END;
