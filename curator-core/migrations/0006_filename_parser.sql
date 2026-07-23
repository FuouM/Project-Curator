-- Migration: 0006_filename_parser.sql

CREATE TABLE IF NOT EXISTS filename_parser_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL, -- 'preset', 'custom_regex', 'token_builder'
    pattern TEXT,            -- regex pattern or preset identifier
    token_config TEXT,       -- JSON string of token blocks
    is_enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_parsed_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL UNIQUE REFERENCES images(id) ON DELETE CASCADE,
    rule_id INTEGER REFERENCES filename_parser_rules(id) ON DELETE SET NULL,
    match_type TEXT NOT NULL,
    artist TEXT,
    pixiv_id TEXT,
    twitter_id TEXT,
    timestamp_4chan TEXT,
    datetime_iso TEXT,
    extracted_tags TEXT, -- JSON string array of tags
    raw_matched TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_image_parsed_metadata_image ON image_parsed_metadata(image_id);
CREATE INDEX IF NOT EXISTS idx_image_parsed_metadata_artist ON image_parsed_metadata(artist);
