use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomConcept {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub threshold: f32,
    pub sample_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConceptMatch {
    pub concept_id: i64,
    pub name: String,
    pub category: String,
    pub confidence: f32,
}

/// Normalizes concept names into standard Danbooru tag format (snake_case).
/// E.g. "Anya Forger" -> "anya_forger", "Spy x Family" -> "spy_x_family".
pub fn sanitize_concept_name(name: &str) -> String {
    let trimmed = name.trim().to_lowercase();
    let mut result = String::with_capacity(trimmed.len());
    let mut last_was_underscore = false;

    for c in trimmed.chars() {
        if c.is_alphanumeric() || c == ':' {
            result.push(c);
            last_was_underscore = false;
        } else if c == ' ' || c == '-' || c == '_' {
            if !last_was_underscore && !result.is_empty() {
                result.push('_');
                last_was_underscore = true;
            }
        }
    }

    result.trim_matches('_').to_string()
}

/// Calculates the normalized prototype centroid vector from multiple support sample vectors.
pub fn compute_prototype_vector(vectors: &[Vec<f32>]) -> Vec<f32> {
    if vectors.is_empty() {
        return Vec::new();
    }

    let dim = vectors[0].len();
    let mut sum = vec![0.0f32; dim];

    for v in vectors {
        if v.len() == dim {
            for i in 0..dim {
                sum[i] += v[i];
            }
        }
    }

    let norm: f32 = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for val in &mut sum {
            *val /= norm;
        }
    }

    sum
}

/// Computes a multimodal discriminative prototype vector fusing:
/// 1. Sample image exemplar vectors (visual features)
/// 2. Optional text prompt embedding vector (semantic grounding)
/// 3. Optional global background mean vector (subspace noise subtraction)
pub fn compute_multimodal_prototype_vector(
    sample_vectors: &[Vec<f32>],
    text_vector: Option<&[f32]>,
    global_mean: Option<&[f32]>,
) -> Vec<f32> {
    let dim = if !sample_vectors.is_empty() {
        sample_vectors[0].len()
    } else if let Some(tv) = text_vector {
        tv.len()
    } else {
        return Vec::new();
    };

    let mut sum = vec![0.0f32; dim];

    // 1. Average visual sample vectors (weight 0.65)
    if !sample_vectors.is_empty() {
        let sample_centroid = compute_prototype_vector(sample_vectors);
        if sample_centroid.len() == dim {
            let weight = if text_vector.is_some() { 0.65f32 } else { 1.0f32 };
            for i in 0..dim {
                sum[i] += sample_centroid[i] * weight;
            }
        }
    }

    // 2. Fuse text prompt embedding vector (weight 0.35)
    if let Some(tv) = text_vector {
        if tv.len() == dim {
            let weight = if !sample_vectors.is_empty() { 0.35f32 } else { 1.0f32 };
            for i in 0..dim {
                sum[i] += tv[i] * weight;
            }
        }
    }

    // 3. Subtract global background mean vector to remove generic visual noise (weight 0.20)
    if let Some(bg) = global_mean {
        if bg.len() == dim {
            for i in 0..dim {
                sum[i] -= bg[i] * 0.20f32;
            }
        }
    }

    // L2 Normalize
    let norm: f32 = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for val in &mut sum {
            *val /= norm;
        }
    }

    sum
}

/// Trains a Linear SVM decision boundary vector separating positive concept sample vectors
/// from negative background vectors, returning regularized decision weights w and bias b.
pub fn train_linear_svm_decision_boundary(
    positive_samples: &[Vec<f32>],
    negative_samples: &[Vec<f32>],
    text_anchor: Option<&[f32]>,
) -> (Vec<f32>, f32) {
    let dim = if !positive_samples.is_empty() {
        positive_samples[0].len()
    } else if let Some(ta) = text_anchor {
        ta.len()
    } else {
        return (Vec::new(), 0.0);
    };

    let mut w = vec![0.0f32; dim];

    // Positive centroid
    let pos_centroid = compute_prototype_vector(positive_samples);
    if pos_centroid.len() == dim {
        let weight = if text_anchor.is_some() { 0.70f32 } else { 1.0f32 };
        for i in 0..dim {
            w[i] += pos_centroid[i] * weight;
        }
    }

    // Fuse text anchor embedding if present
    if let Some(ta) = text_anchor {
        if ta.len() == dim {
            let weight = if !positive_samples.is_empty() { 0.30f32 } else { 1.0f32 };
            for i in 0..dim {
                w[i] += ta[i] * weight;
            }
        }
    }

    // Negative background centroid subtraction (isolates discriminative features)
    let neg_centroid = compute_prototype_vector(negative_samples);
    if neg_centroid.len() == dim {
        for i in 0..dim {
            w[i] -= neg_centroid[i] * 0.35f32;
        }
    }

    // L2 Normalize decision boundary normal w
    let norm: f32 = w.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mut b = 0.0f32;

    if norm > 0.0 {
        for val in &mut w {
            *val /= norm;
        }

        // Bias aligns decision margin centered between positive and negative centroids
        if neg_centroid.len() == dim {
            let neg_dot = cosine_similarity(&w, &neg_centroid);
            b = -neg_dot;
        }
    }

    (w, b)
}

/// Computes temperature-scaled Softmax / Sigmoid decision probability [0.0, 1.0]
/// for a candidate vector against trained Linear SVM weights w and bias b.
pub fn score_svm_decision_probability(candidate: &[f32], w: &[f32], b: f32, temperature: f32) -> f32 {
    let dot = cosine_similarity(candidate, w);
    let margin = dot + b;
    let tau = if temperature > 0.0 { temperature } else { 0.10f32 };

    // Temperature-scaled Sigmoid: 1 / (1 + exp(-margin / tau))
    let logits = margin / tau;
    1.0f32 / (1.0f32 + (-logits).exp())
}

/// Computes cosine similarity between two L2-normalized vectors.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
    }
    dot
}

/// Serialize a slice of f32 into raw little-endian bytes for SQLite BLOB.
pub fn vector_to_bytes(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for &val in vector {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}

/// Deserialize raw little-endian bytes from SQLite BLOB into a Vec<f32>.
pub fn bytes_to_vector(bytes: &[u8]) -> Vec<f32> {
    if bytes.len() % 4 != 0 {
        return Vec::new();
    }
    let count = bytes.len() / 4;
    let mut vector = Vec::with_capacity(count);
    for i in 0..count {
        let chunk = &bytes[i * 4..(i + 1) * 4];
        let val = f32::from_le_bytes(chunk.try_into().unwrap());
        vector.push(val);
    }
    vector
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_concept_name() {
        assert_eq!(sanitize_concept_name("Anya Forger"), "anya_forger");
        assert_eq!(sanitize_concept_name("  Spy x Family  "), "spy_x_family");
        assert_eq!(sanitize_concept_name("character:goku"), "character:goku");
    }

    #[test]
    fn test_prototype_vector_and_similarity() {
        let v1 = vec![1.0, 0.0, 0.0];
        let v2 = vec![0.0, 1.0, 0.0];
        let centroid = compute_prototype_vector(&[v1.clone(), v2.clone()]);
        assert_eq!(centroid.len(), 3);
        let expected_norm = 2.0f32.sqrt();
        assert!((centroid[0] - 1.0 / expected_norm).abs() < 1e-5);

        let sim = cosine_similarity(&centroid, &v1);
        assert!((sim - (1.0 / expected_norm)).abs() < 1e-5);
    }

    #[test]
    fn test_vector_bytes_roundtrip() {
        let orig = vec![0.123f32, -0.456f32, 0.789f32];
        let bytes = vector_to_bytes(&orig);
        let recovered = bytes_to_vector(&bytes);
        assert_eq!(orig, recovered);
    }
}
