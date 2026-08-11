-- Migration: 0020_add_note_to_images.sql

ALTER TABLE images ADD COLUMN note TEXT;
