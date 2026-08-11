CREATE TABLE IF NOT EXISTS image_ocr_bubble_boxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    x1 REAL NOT NULL,
    y1 REAL NOT NULL,
    x2 REAL NOT NULL,
    y2 REAL NOT NULL,
    confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocr_bubble_image ON image_ocr_bubble_boxes(image_id);
