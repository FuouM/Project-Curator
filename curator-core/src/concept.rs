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

/// Centers a vector by subtracting an optional global mean vector, then L2-normalizes it.
/// This is the core operation of Centered L2 Normalization (CL2N / SimpleShot).
pub fn center_and_normalize_vector(v: &[f32], global_mean: Option<&[f32]>) -> Vec<f32> {
    if v.is_empty() {
        return Vec::new();
    }

    let mut result = vec![0.0f32; v.len()];
    if let Some(gm) = global_mean {
        if gm.len() == v.len() {
            for i in 0..v.len() {
                result[i] = v[i] - gm[i];
            }
        } else {
            result.copy_from_slice(v);
        }
    } else {
        result.copy_from_slice(v);
    }

    let norm: f32 = result.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for val in &mut result {
            *val /= norm;
        }
    }
    result
}

/// Calculates the normalized prototype centroid vector from multiple support sample vectors.
/// If a global mean vector is provided, CL2N (Centered L2 Normalization) is applied to each sample.
pub fn compute_prototype_vector(vectors: &[Vec<f32>]) -> Vec<f32> {
    compute_cl2n_prototype(vectors, None, None)
}

/// Computes a multimodal concept prototype vector using SimpleShot / Centered L2 Normalization (CL2N).
/// 1. Each visual exemplar vector is mean-centered (using global_mean) and L2-normalized.
/// 2. Optional text prompt embedding vector is mean-centered and fused.
/// 3. The resulting vector sum is L2-normalized to produce the final discriminative prototype.
pub fn compute_cl2n_prototype(
    sample_vectors: &[Vec<f32>],
    global_mean: Option<&[f32]>,
    text_vector: Option<&[f32]>,
) -> Vec<f32> {
    let dim = if !sample_vectors.is_empty() {
        sample_vectors[0].len()
    } else if let Some(tv) = text_vector {
        tv.len()
    } else {
        return Vec::new();
    };

    let mut sum = vec![0.0f32; dim];

    // 1. Accumulate CL2N-transformed visual exemplars
    if !sample_vectors.is_empty() {
        let sample_weight = if text_vector.is_some() { 0.70f32 } else { 1.0f32 };
        let mut visual_sum = vec![0.0f32; dim];
        let mut count = 0;

        for v in sample_vectors {
            if v.len() == dim {
                let centered = center_and_normalize_vector(v, global_mean);
                for i in 0..dim {
                    visual_sum[i] += centered[i];
                }
                count += 1;
            }
        }

        if count > 0 {
            let vis_norm: f32 = visual_sum.iter().map(|x| x * x).sum::<f32>().sqrt();
            if vis_norm > 0.0 {
                for i in 0..dim {
                    sum[i] += (visual_sum[i] / vis_norm) * sample_weight;
                }
            }
        }
    }

    // 2. Fuse CL2N-transformed text embedding anchor if present
    if let Some(tv) = text_vector {
        if tv.len() == dim {
            let text_weight = if !sample_vectors.is_empty() { 0.30f32 } else { 1.0f32 };
            let centered_text = center_and_normalize_vector(tv, global_mean);
            for i in 0..dim {
                sum[i] += centered_text[i] * text_weight;
            }
        }
    }

    // 3. Final L2 Normalize onto hypersphere
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
    compute_cl2n_prototype(sample_vectors, global_mean, text_vector)
}

/// Trains a discriminative concept decision vector using SimpleShot / Centered L2 Normalization (CL2N),
/// separating positive concept sample vectors from negative background vectors.
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

    // Calculate background mean if negative samples are provided
    let global_mean = if !negative_samples.is_empty() {
        let mut mean = vec![0.0f32; dim];
        let mut count = 0;
        for neg in negative_samples {
            if neg.len() == dim {
                for i in 0..dim {
                    mean[i] += neg[i];
                }
                count += 1;
            }
        }
        if count > 0 {
            for i in 0..dim {
                mean[i] /= count as f32;
            }
        }
        Some(mean)
    } else {
        None
    };

    let w = compute_cl2n_prototype(positive_samples, global_mean.as_deref(), text_anchor);
    (w, 0.0)
}

/// Scores a candidate vector against a concept prototype using CL2N (Centered L2 Normalization).
pub fn score_cl2n_concept(candidate: &[f32], prototype: &[f32], global_mean: Option<&[f32]>) -> f32 {
    if candidate.len() != prototype.len() || prototype.is_empty() {
        return 0.0;
    }
    let centered_candidate = center_and_normalize_vector(candidate, global_mean);
    cosine_similarity(&centered_candidate, prototype)
}

/// Computes temperature-scaled Softmax / Sigmoid decision probability [0.0, 1.0]
/// for a candidate vector against trained weights w and bias b.
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

    #[test]
    fn test_cl2n_feature_centering_and_scoring() {
        let global_mean = vec![10.0, 10.0, 10.0];
        // Two samples with background bias + concept direction
        let sample1 = vec![11.0, 10.0, 10.0]; // Centered: [1.0, 0.0, 0.0] -> norm [1.0, 0.0, 0.0]
        let sample2 = vec![12.0, 10.0, 10.0]; // Centered: [2.0, 0.0, 0.0] -> norm [1.0, 0.0, 0.0]

        let proto = compute_cl2n_prototype(&[sample1.clone(), sample2], Some(&global_mean), None);
        assert_eq!(proto.len(), 3);
        assert!((proto[0] - 1.0).abs() < 1e-5);
        assert!(proto[1].abs() < 1e-5);
        assert!(proto[2].abs() < 1e-5);

        // Matching test candidate with background bias
        let candidate_match = vec![15.0, 10.0, 10.0];
        let score = score_cl2n_concept(&candidate_match, &proto, Some(&global_mean));
        assert!((score - 1.0).abs() < 1e-5);

        // Non-matching test candidate in orthogonal direction
        let candidate_other = vec![10.0, 15.0, 10.0];
        let score_other = score_cl2n_concept(&candidate_other, &proto, Some(&global_mean));
        assert!(score_other.abs() < 1e-5);
    }

    #[test]
    fn test_online_constant_time_exemplar_updates() {
        let global_mean = vec![0.5, 0.5];
        let e1 = vec![1.5, 0.5]; // centered: [1.0, 0.0] -> normalized: [1.0, 0.0]
        let e2 = vec![0.5, 2.5]; // centered: [0.0, 2.0] -> normalized: [0.0, 1.0]

        // Full batch calculation
        let proto_batch = compute_cl2n_prototype(&[e1.clone(), e2.clone()], Some(&global_mean), None);

        // Online incremental calculation: S = \sum \tilde{e}_i
        let c1 = center_and_normalize_vector(&e1, Some(&global_mean));
        let c2 = center_and_normalize_vector(&e2, Some(&global_mean));
        let mut sum = vec![0.0f32; 2];
        for i in 0..2 {
            sum[i] += c1[i];
            sum[i] += c2[i];
        }
        let norm: f32 = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
        let proto_online: Vec<f32> = sum.iter().map(|x| x / norm).collect();

        assert_eq!(proto_batch.len(), proto_online.len());
        for i in 0..2 {
            assert!((proto_batch[i] - proto_online[i]).abs() < 1e-5);
        }
    }
}
