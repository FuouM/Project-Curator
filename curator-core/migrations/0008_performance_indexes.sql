-- Performance indexes for gallery listing and sorting
CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC);
