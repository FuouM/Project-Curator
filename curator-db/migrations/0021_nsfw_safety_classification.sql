-- Migration: 0021_nsfw_safety_classification.sql

-- Per-class probabilities, treated as optional metadata (NULL = not yet classified).
-- No aggregate columns and no computed is_nsfw: the browser derives
-- nsfw_score = hentai + porn + sexy and compares it to a localStorage threshold,
-- so re-thresholding never needs a re-write.
ALTER TABLE images ADD COLUMN safe_score REAL;
ALTER TABLE images ADD COLUMN hentai_score REAL;
ALTER TABLE images ADD COLUMN porn_score REAL;
ALTER TABLE images ADD COLUMN sexy_score REAL;
ALTER TABLE images ADD COLUMN drawing_score REAL;