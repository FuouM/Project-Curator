-- Migration: 0004_custom_concepts.sql

CREATE TABLE custom_concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL DEFAULT 'character',
    threshold REAL NOT NULL DEFAULT 0.70,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE custom_concept_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES custom_concepts(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    is_negative INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(concept_id, image_id)
);

CREATE TABLE custom_concept_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES custom_concepts(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    vector BLOB NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(concept_id, source_id)
);

CREATE INDEX idx_custom_concept_samples_concept ON custom_concept_samples(concept_id);
CREATE INDEX idx_custom_concept_vectors_concept ON custom_concept_vectors(concept_id);
