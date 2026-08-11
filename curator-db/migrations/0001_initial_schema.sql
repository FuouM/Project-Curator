-- Migration: 0001_initial_schema.sql

-- Sources table
CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    manifest TEXT, -- Stored as JSON string
    installed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Images table
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT UNIQUE NOT NULL,
    phash TEXT,
    current_filepath TEXT NOT NULL,
    os_file_id TEXT,
    mtime INTEGER NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

-- Tags table
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL
);

-- Image tags table (for auditing and rollback)
CREATE TABLE image_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    source_id INTEGER NOT NULL REFERENCES sources(id),
    confidence REAL,
    transaction_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER NOT NULL DEFAULT 0, -- SQLite uses 0/1 for booleans
    deleted_at TIMESTAMP NULL,
    UNIQUE (image_id, tag_id, source_id, transaction_id)
);

-- Image vectors table
CREATE TABLE image_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    vector_id TEXT NOT NULL,
    vector_checksum TEXT,
    vector_state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (image_id, source_id)
);

-- Tag aliases
CREATE TABLE tag_aliases (
    alias TEXT PRIMARY KEY,
    canonical_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);

-- Tag hierarchy
CREATE TABLE tag_hierarchy (
    parent_tag_id INTEGER NOT NULL REFERENCES tags(id),
    child_tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (parent_tag_id, child_tag_id)
);

-- Create indexes for performance
CREATE INDEX idx_images_sha256 ON images(sha256);
CREATE INDEX idx_image_tags_query ON image_tags(tag_id, is_deleted);
CREATE INDEX idx_image_tags_image_id ON image_tags(image_id);
CREATE INDEX idx_image_vectors_image_id ON image_vectors(image_id);
