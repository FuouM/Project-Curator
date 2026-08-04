-- Migration: 0017_tagger_models.sql
-- Registers the two tagger models that coexist in the system. Camie is the
-- default; the WD EVA02 tagger is the second, selectable tagger. The engine
-- specs live in curator-core (TaggerModelSpec); this table is the canonical
-- runtime registry mirroring those specs for tooling and future features.

CREATE TABLE IF NOT EXISTS tagger_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    source_name TEXT UNIQUE NOT NULL,
    input_size INTEGER NOT NULL,
    default_threshold REAL NOT NULL,
    mean_json TEXT NOT NULL,
    std_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO tagger_models (key, display_name, source_name, input_size, default_threshold, mean_json, std_json)
VALUES ('camie-tagger-v2', 'Camie Tagger v2', 'ai:camie-tagger-v2', 512, 0.50, '[0.485,0.456,0.406]', '[0.229,0.224,0.225]'),
       ('wd-eva02-tagger-2026-canary', 'WD EVA02 Tagger 2026 Canary', 'ai:wd-eva02-tagger-2026-canary', 448, 0.6094, '[0.5,0.5,0.5]', '[0.5,0.5,0.5]');
