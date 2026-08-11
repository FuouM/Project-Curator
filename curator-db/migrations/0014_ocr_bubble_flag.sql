-- Migration: Add is_from_bubble flag to OCR detections
-- Tracks whether a detection was grouped by the manga bubble detector
ALTER TABLE image_ocr_detections ADD COLUMN is_from_bubble INTEGER NOT NULL DEFAULT 0;
