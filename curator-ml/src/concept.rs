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
        } else if (c == ' ' || c == '-' || c == '_') && !last_was_underscore && !result.is_empty() {
            result.push('_');
            last_was_underscore = true;
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

/// Fuses a CLIP vision embedding with an AI tagger probability vector.
/// Both input vectors are L2-normalized first. The tagger vector is weighted by `tag_weight`
/// (default 0.50), concatenated with the CLIP vector, and L2-normalized onto the unit sphere.
pub fn fuse_clip_and_tag_features(clip_vec: &[f32], tag_vec: &[f32], tag_weight: f32) -> Vec<f32> {
    if clip_vec.is_empty() {
        return Vec::new();
    }
    if tag_vec.is_empty() {
        return normalize_vector(clip_vec);
    }

    let norm_clip = normalize_vector(clip_vec);
    let norm_tag = normalize_vector(tag_vec);

    let mut fused = Vec::with_capacity(norm_clip.len() + norm_tag.len());
    fused.extend_from_slice(&norm_clip);
    for &t in &norm_tag {
        fused.push(t * tag_weight);
    }

    normalize_vector(&fused)
}

/// L2-normalizes a vector onto the unit hypersphere.
pub fn normalize_vector(v: &[f32]) -> Vec<f32> {
    let norm_sq: f32 = v.iter().map(|x| x * x).sum();
    if norm_sq > 0.0 {
        let norm = norm_sq.sqrt();
        v.iter().map(|x| x / norm).collect()
    } else {
        v.to_vec()
    }
}

/// Solves Dual Ridge Regression: w = X^T (X X^T + alpha * I)^(-1) y
/// where positive samples get target y_i = +1.0 and negative samples get y_i = -1.0.
pub fn train_ridge_classifier_decision_boundary(
    positive_samples: &[Vec<f32>],
    negative_samples: &[Vec<f32>],
    alpha: f32,
) -> (Vec<f32>, f32) {
    let dim = if !positive_samples.is_empty() {
        positive_samples[0].len()
    } else if !negative_samples.is_empty() {
        negative_samples[0].len()
    } else {
        return (Vec::new(), 0.0);
    };

    let n_pos = positive_samples.len();
    let n_neg = negative_samples.len();
    let n_total = n_pos + n_neg;

    if n_total == 0 {
        return (Vec::new(), 0.0);
    }

    let mut samples: Vec<&[f32]> = Vec::with_capacity(n_total);
    let mut y = vec![0.0f32; n_total];

    for (i, pos) in positive_samples.iter().enumerate() {
        if pos.len() == dim {
            samples.push(pos);
            y[i] = 1.0;
        }
    }
    for (i, neg) in negative_samples.iter().enumerate() {
        if neg.len() == dim {
            samples.push(neg);
            y[n_pos + i] = -1.0;
        }
    }

    let n = samples.len();
    if n == 0 {
        return (Vec::new(), 0.0);
    }

    // Compute Kernel Matrix K = X X^T + alpha * I (n x n)
    let reg = if alpha > 0.0 { alpha } else { 1.0 };
    let mut k = vec![vec![0.0f32; n]; n];

    for i in 0..n {
        for j in i..n {
            let dot: f32 = samples[i].iter().zip(samples[j].iter()).map(|(a, b)| a * b).sum();
            k[i][j] = dot;
            k[j][i] = dot;
        }
        k[i][i] += reg;
    }

    // Solve Linear System K * a = y via Gaussian Elimination
    let a = solve_linear_system(&mut k, &y);

    // Compute weight vector w = sum_i (a_i * sample_i)
    let mut w = vec![0.0f32; dim];
    for (i, sample) in samples.iter().enumerate() {
        let alpha_i = a[i];
        for d in 0..dim {
            w[d] += alpha_i * sample[d];
        }
    }

    let w_norm = normalize_vector(&w);
    (w_norm, 0.0)
}

fn solve_linear_system(k: &mut [Vec<f32>], b: &[f32]) -> Vec<f32> {
    let n = b.len();
    let mut a = vec![vec![0.0f32; n + 1]; n];

    for i in 0..n {
        for j in 0..n {
            a[i][j] = k[i][j];
        }
        a[i][n] = b[i];
    }

    // Forward elimination with partial pivoting
    for i in 0..n {
        let mut max_row = i;
        for row in (i + 1)..n {
            if a[row][i].abs() > a[max_row][i].abs() {
                max_row = row;
            }
        }
        a.swap(i, max_row);

        let pivot = a[i][i];
        if pivot.abs() < 1e-7 {
            continue;
        }

        for j in (i + 1)..n {
            let factor = a[j][i] / pivot;
            let (row_i, row_j) = if i < j {
                let (left, right) = a.split_at_mut(j);
                (&left[i], &mut right[0])
            } else {
                let (left, right) = a.split_at_mut(i);
                (&right[0], &mut left[j])
            };
            for (aj_val, &ai_val) in row_j[i..=n].iter_mut().zip(&row_i[i..=n]) {
                *aj_val -= factor * ai_val;
            }
        }
    }

    // Back substitution
    let mut x = vec![0.0f32; n];
    for i in (0..n).rev() {
        let pivot = a[i][i];
        if pivot.abs() < 1e-7 {
            x[i] = 0.0;
            continue;
        }
        let mut sum = a[i][n];
        for j in (i + 1)..n {
            sum -= a[i][j] * x[j];
        }
        x[i] = sum / pivot;
    }

    x
}

/// Trains a discriminative concept decision vector using Dual Ridge Classification,
/// separating positive concept sample vectors from negative background vectors.
pub fn train_linear_svm_decision_boundary(
    positive_samples: &[Vec<f32>],
    negative_samples: &[Vec<f32>],
    _text_anchor: Option<&[f32]>,
) -> (Vec<f32>, f32) {
    if !positive_samples.is_empty() && !negative_samples.is_empty() {
        train_ridge_classifier_decision_boundary(positive_samples, negative_samples, 1.0)
    } else if !positive_samples.is_empty() {
        let w = compute_cl2n_prototype(positive_samples, None, _text_anchor);
        (w, 0.0)
    } else {
        (Vec::new(), 0.0)
    }
}

/// Scores a candidate vector against a concept prototype using CL2N (Centered L2 Normalization).
///
/// Zero-allocation equivalent of `cosine_similarity(center_and_normalize_vector(candidate, gm),
/// prototype)`: it reproduces the legacy arithmetic exactly (per-element `centered/norm`,
/// then a plain dot product), so results are bit-identical to the allocating path while
/// avoiding the per-comparison heap churn during high-volume concept matching.
pub fn score_cl2n_concept(candidate: &[f32], prototype: &[f32], global_mean: Option<&[f32]>) -> f32 {
    if candidate.len() != prototype.len() || prototype.is_empty() {
        return 0.0;
    }
    let gm = global_mean.filter(|m| m.len() == candidate.len());
    let mut norm_sq = 0.0f32;
    for i in 0..candidate.len() {
        let centered = candidate[i] - gm.map_or(0.0, |m| m[i]);
        norm_sq += centered * centered;
    }
    let norm = norm_sq.sqrt();
    let mut dot = 0.0f32;
    if norm > 0.0 {
        for i in 0..candidate.len() {
            let centered = candidate[i] - gm.map_or(0.0, |m| m[i]);
            dot += (centered / norm) * prototype[i];
        }
    } else {
        for i in 0..candidate.len() {
            let centered = candidate[i] - gm.map_or(0.0, |m| m[i]);
            dot += centered * prototype[i];
        }
    }
    dot
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
        let mut sum = [0.0f32; 2];
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

    #[test]
    fn test_fuse_clip_and_tag_features() {
        let clip = vec![1.0, 0.0];
        let tag = vec![0.0, 1.0];
        let fused = fuse_clip_and_tag_features(&clip, &tag, 0.5);
        assert_eq!(fused.len(), 4);
        assert!((fused[0] - 1.0 / 1.25f32.sqrt()).abs() < 1e-5);
        assert_eq!(fused[1], 0.0);
        assert_eq!(fused[2], 0.0);
        assert!((fused[3] - 0.5 / 1.25f32.sqrt()).abs() < 1e-5);
    }

    #[test]
    fn test_train_ridge_classifier_decision_boundary() {
        let pos1 = vec![1.0, 0.0];
        let pos2 = vec![0.9, 0.1];
        let neg1 = vec![-1.0, 0.0];
        let neg2 = vec![-0.9, -0.1];

        let (w, _bias) = train_ridge_classifier_decision_boundary(&[pos1, pos2], &[neg1, neg2], 1.0);
        assert_eq!(w.len(), 2);
        // Positives are along +x, negatives along -x; decision weight should point along +x
        assert!(w[0] > 0.8);
        assert!(w[1].abs() < 0.2);
    }

    /// The zero-allocation closed form must be bit-identical to the allocating
    /// `cosine_similarity(center_and_normalize_vector(...), prototype)` path,
    /// including gm length-mismatch and all-zero vector edge cases.
    #[test]
    fn score_cl2n_concept_closed_form_matches_allocating_path() {
        let legacy = |candidate: &[f32], prototype: &[f32], gm: Option<&[f32]>| -> f32 {
            let centered = center_and_normalize_vector(candidate, gm);
            cosine_similarity(&centered, prototype)
        };

        type Case = (Vec<f32>, Vec<f32>, Option<Vec<f32>>);
        let cases: Vec<Case> = vec![
            (vec![1.0, 2.0, 3.0], vec![0.1, 0.2, 0.3], Some(vec![0.5, 0.5, 0.5])),
            (vec![0.0, 0.0, 0.0], vec![0.1, 0.2, 0.3], Some(vec![0.5, 0.5, 0.5])),
            (vec![1.0, 2.0], vec![0.1, 0.2], Some(vec![0.5, 0.5, 0.5])), // gm length mismatch
            (vec![1.0, 2.0], vec![0.1, 0.2], None),                       // no mean
            (vec![0.3, -0.7, 1.1, 2.2], vec![0.2, 0.4, 0.6, 0.8], Some(vec![0.0, 0.0, 0.0, 0.0])),
        ];

        for (candidate, prototype, gm) in cases {
            let expected = legacy(&candidate, &prototype, gm.as_deref());
            let actual = score_cl2n_concept(&candidate, &prototype, gm.as_deref());
            assert_eq!(
                expected.to_bits(),
                actual.to_bits(),
                "mismatch for candidate={:?} prototype={:?} gm={:?}",
                candidate,
                prototype,
                gm
            );
        }
    }
}
