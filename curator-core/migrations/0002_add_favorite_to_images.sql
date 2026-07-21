-- Migration: 0002_add_favorite_to_images.sql

ALTER TABLE images ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
