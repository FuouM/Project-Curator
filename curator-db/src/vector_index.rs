use anyhow::{Context, Error};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::info;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

pub struct VectorIndex {
    index: Index,
    path: PathBuf,
}

impl VectorIndex {
    pub fn new<P: AsRef<Path>>(index_path: P, dimensions: usize) -> Result<Self, Error> {
        let path = index_path.as_ref().to_path_buf();
        let options = IndexOptions {
            dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F32,
            ..Default::default()
        };

        let index =
            Index::new(&options).map_err(|e| anyhow::anyhow!("Failed to create Index: {:?}", e))?;
        index
            .reserve(1000)
            .map_err(|e| anyhow::anyhow!("Failed to reserve initial capacity: {:?}", e))?;

        let mut instance = Self { index, path };
        if instance.path.exists() {
            info!("Loading existing vector index from {:?}", instance.path);
            instance.load()?;
        } else {
            info!("Creating new vector index at {:?}", instance.path);
            if let Some(parent) = instance.path.parent() {
                fs::create_dir_all(parent)?;
            }
            instance.save()?;
        }

        Ok(instance)
    }

    pub fn add_without_save(&self, id: u64, vector: &[f32]) -> Result<(), Error> {
        let size = self.index.size();
        let capacity = self.index.capacity();
        if size >= capacity {
            self.index
                .reserve(capacity + 1000)
                .map_err(|e| anyhow::anyhow!("Failed to expand capacity: {:?}", e))?;
        }
        self.index
            .add(id, vector)
            .map_err(|e| anyhow::anyhow!("Failed to add vector: {:?}", e))?;
        Ok(())
    }

    pub fn add(&self, id: u64, vector: &[f32]) -> Result<(), Error> {
        self.add_without_save(id, vector)?;
        self.save()?;
        Ok(())
    }

    pub fn add_batch(&self, items: &[(u64, &[f32])]) -> Result<(), Error> {
        for (id, vector) in items {
            self.add_without_save(*id, vector)?;
        }
        self.save()?;
        Ok(())
    }

    pub fn contains(&self, id: u64) -> bool {
        self.index.contains(id)
    }

    pub fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(u64, f32)>, Error> {
        let results = self
            .index
            .search(query, limit)
            .map_err(|e| anyhow::anyhow!("Search failed: {:?}", e))?;

        let mut matches = Vec::new();
        for i in 0..results.keys.len() {
            matches.push((results.keys[i], results.distances[i]));
        }
        Ok(matches)
    }

    pub fn save(&self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .save(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to save index: {:?}", e))?;
        Ok(())
    }

    pub fn load(&mut self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .load(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to load index: {:?}", e))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), Error> {
        self.index
            .reset()
            .map_err(|e| anyhow::anyhow!("Failed to reset index: {:?}", e))?;
        self.index
            .reserve(1000)
            .map_err(|e| anyhow::anyhow!("Failed to reserve capacity: {:?}", e))?;
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .save(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to save cleared index: {:?}", e))?;
        Ok(())
    }
}
