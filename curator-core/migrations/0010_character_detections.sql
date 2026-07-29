CREATE TABLE IF NOT EXISTS character_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS character_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    x0 INTEGER NOT NULL,
    y0 INTEGER NOT NULL,
    x1 INTEGER NOT NULL,
    y1 INTEGER NOT NULL,
    confidence REAL NOT NULL,
    ccip_embedding BLOB,
    identity_id INTEGER REFERENCES character_identities(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_char_det_image ON character_detections(image_id);
CREATE INDEX IF NOT EXISTS idx_char_det_identity ON character_detections(identity_id);
