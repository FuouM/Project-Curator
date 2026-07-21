-- Migration: 0003_add_folders.sql

-- Folders table to track imported folder paths
CREATE TABLE folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Link images to their source folder
ALTER TABLE images ADD COLUMN folder_id INTEGER REFERENCES folders(id);

-- Indexes for performance
CREATE INDEX idx_images_folder_id ON images(folder_id);
CREATE INDEX idx_folders_path ON folders(path);
