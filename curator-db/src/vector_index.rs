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
            let new_capacity = (capacity * 3 / 2).max(capacity + 5000);
            self.index
                .reserve(new_capacity)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_index_path() -> PathBuf {
        std::env::temp_dir().join(format!("test_vector_index_{}.usearch", uuid::Uuid::new_v4()))
    }

    #[test]
    fn test_vector_index_lifecycle_and_search() {
        let path = temp_index_path();
        let index = VectorIndex::new(&path, 4).expect("Failed to create index");

        let v1 = [1.0f32, 0.0, 0.0, 0.0];
        let v2 = [0.0f32, 1.0, 0.0, 0.0];
        let v3 = [
            std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2,
            0.0,
            0.0,
        ];

        index.add(101, &v1).expect("Failed to add v1");
        index.add(102, &v2).expect("Failed to add v2");
        index.add(103, &v3).expect("Failed to add v3");

        assert!(index.contains(101));
        assert!(index.contains(102));
        assert!(index.contains(103));
        assert!(!index.contains(999));

        // Query nearest to v1
        let results = index.search(&v1, 3).expect("Search failed");
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].0, 101, "v1 should be closest to itself");
        assert!((results[0].1).abs() < 1e-4, "Self-cosine distance should be near 0");

        // v3 is at 45 degrees, closer than v2 at 90 degrees
        assert_eq!(results[1].0, 103);
        assert_eq!(results[2].0, 102);

        // Test save & reload
        let mut loaded = VectorIndex::new(&path, 4).expect("Failed to open saved index");
        loaded.load().expect("Failed to load");
        assert!(loaded.contains(101));
        let loaded_results = loaded.search(&v1, 1).expect("Search on reloaded failed");
        assert_eq!(loaded_results[0].0, 101);

        // Test clear
        index.clear().expect("Failed to clear");
        assert!(!index.contains(101));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_vector_index_batch_insert() {
        let path = temp_index_path();
        let index = VectorIndex::new(&path, 3).expect("Failed to create index");

        let v1 = [1.0f32, 0.0, 0.0];
        let v2 = [0.0f32, 1.0, 0.0];
        let items: Vec<(u64, &[f32])> = vec![(1, &v1), (2, &v2)];

        index.add_batch(&items).expect("Batch insert failed");
        assert!(index.contains(1));
        assert!(index.contains(2));

        let results = index.search(&v2, 1).expect("Search failed");
        assert_eq!(results[0].0, 2);

        let _ = fs::remove_file(&path);
    }
}

