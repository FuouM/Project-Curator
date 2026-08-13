# Porting Machine Learning Inference Pipelines to Rust: A Field Guide

This guide documents the architecture, patterns, pitfalls, and debugging workflows for porting Python ML inference models (ONNX / Safetensors) to Rust using `ort` (ONNX Runtime bindings) within the `curator-ml` crate.

All lessons here were extracted from production model implementations in `curator-ml/src/` (PaddleOCR detection & recognition, CCIP character identification, YOLO detection, WD EVA02 & Camie taggers, and NSFW safety classification).

---

## 1. The Porting Mental Model

An inference pipeline is a chain of pure transformations:

```txt
raw image → preprocess → model input tensor → ONNX model → raw output tensor → postprocess → domain result
```

Each stage must be reproduced **bit-for-bit**. Even minor deviations (wrong channel order, wrong normalization scale, inverted transform direction) produce silently wrong results — the code compiles, runs, and returns garbage.

> **The Golden Rule:** Reproduce the reference Python implementation, not what you think the Python does. Always inspect the actual reference source code and configuration files.

---

## 2. Start with Python — Validate Before Porting

Before writing any Rust code, validate the full pipeline in Python on the target model and a real test image.

Write a self-contained diagnostic script with your local environment (`python` with `onnxruntime`, `numpy`, and `opencv-python`):

```python
import sys
import numpy as np
import onnxruntime as ort

# Ensure terminal output properly handles CJK characters
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

sess = ort.InferenceSession("model.onnx", providers=["CPUExecutionProvider"])
print("Inputs:", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
print("Outputs:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])
```

### Key Data to Extract Before Porting

- **Exact Input/Output Names**: E.g. `"x"`, `"images"`, `"fetch_name_0"`, `"output"`.
- **Dynamic Dimensions**: Whether batch size, width, or height are dynamic dimensions (`-1` or `"DynamicDimension"`).
- **Output Representation**: Raw logits, log-softmax, or normalized probabilities.
- **Preprocessing Formulas**: Channel conventions (BGR vs RGB), normalization constants (mean and standard deviation), and resize interpolation methods (bilinear, bicubic, area).

---

## 3. Preprocessing Conventions Across Supported Models

| Pipeline | Model | Input Dimensions | Channel Order | Normalization Formula |
| :--- | :--- | :--- | :--- | :--- |
| **Embeddings** | `clip-vit-b32` | `[1, 3, 224, 224]` | RGB | `(pixel / 255.0 - [0.4814, 0.4578, 0.4082]) / [0.2686, 0.2613, 0.2757]` |
| **Embeddings** | `mobileclip-s2` | `[1, 3, 256, 256]` | RGB | `(pixel / 255.0 - [0.4814, 0.4578, 0.4082]) / [0.2686, 0.2613, 0.2757]` |
| **Danbooru** | `camie-tagger-v2` | `[1, 3, 448, 448]` | RGB | `(pixel / 255.0 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]` |
| **Danbooru** | `wd-eva02` | `[1, 3, 448, 448]` | BGR/RGB | Bbox aspect padding, normalized to `[0.0, 255.0]` or standard mean/std |
| **Safety** | `nsfw-detection-2-mini`| `[1, 3, 380, 380]` | RGB | `(pixel / 255.0 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]` |
| **Detection**| `yolo-person` | `[1, 3, 640, 640]` | RGB | Letterboxed pad, normalized `pixel / 255.0` |
| **OCR Det** | `pp-ocrv6-medium` | `[1, 3, H, W]` (dyn 32) | **BGR** | `(pixel / 255.0 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]` |
| **OCR Rec** | `pp-ocrv6-medium` | `[1, 3, 48, W]` (dyn) | Symmetric | `(pixel / 255.0 - 0.5) / 0.5` |
| **OCR Cls** | `pp-lcnet-cls` | `[1, 3, 48, 192]` | **BGR** | `(pixel / 255.0 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]` |

---

## 4. ONNX Runtime (`ort`) Patterns in Rust

The `curator-ml` crate uses `ort` bindings for ONNX Runtime. Standard session setup and invocation:

### Creating an Optimized Session

```rust
use ort::session::{Session, builder::GraphOptimizationLevel};

let session = Session::builder()?
    .with_optimization_level(GraphOptimizationLevel::Level3)?
    .commit_from_file(model_path)?;
```

### Running Inference & Extracting Outputs

```rust
use ndarray::Array4;
use ort::inputs;

let tensor: Array4<f32> = Array4::zeros((1, 3, height, width));
// Preprocess image bytes into tensor...

let outputs = session.run(inputs!["x" => tensor.view()])?;
let output_tensor = outputs["fetch_name_0"].try_extract_tensor::<f32>()?;
let view = output_tensor.view(); // ndarray view
```

### Tensor Layout

For a 4D NCHW tensor `[N, C, H, W]`, the index at `[n, c, h, w]` maps in row-major C-contiguous memory to:

$$\text{index} = n \times (C \times H \times W) + c \times (H \times W) + h \times W + w$$

---

## 5. Critical Pitfalls & Engineering Gotchas

### 5.1. Perspective Transform Direction (Inverse Warp)

When implementing an inverse warp to extract oriented bounding boxes:

```rust
// WRONG: H maps src -> dst, but we are looking up src pixels from dst grid
let h = get_perspective_transform(src_pts, dst_pts)?;

// CORRECT: Swap arguments so H maps dst -> src directly
let h = get_perspective_transform(dst_pts, src_pts)?;
```

OpenCV's `warpPerspective` takes an $H$ that maps *source* to *destination* and internally inverts it. If iterating over destination pixels and back-projecting into source coordinates, swap arguments so $H$ is computed directly as $H(\text{dst} \to \text{src})$.

*Symptom:* Recognition model output is completely blank (argmax all zeros), despite having correct crop dimensions.

---

### 5.2. PaddleOCR `inference.yml` Character Dictionary Parsing

PaddleOCR's `inference.yml` character dict contains 18,000+ entries, has blank lines within lists, and uses YAML single-quoted scalars escaping quotes as `''` (e.g. `''` $\to$ `'`). Furthermore, `use_space_char=True` models require appending a space character (`" "`) to map the final CTC class.

```rust
for line in content.lines() {
    let s = line.trim_end_matches('\r').trim();
    if s.is_empty() { continue; } // skip blanks, remain in section
    if s == "character_dict:" { in_dict = true; continue; }
    if in_dict {
        if let Some(rest) = s.strip_prefix("- ") {
            let ch = if rest.starts_with('\'') && rest.ends_with('\'') {
                let inner = &rest[1..rest.len()-1];
                inner.replace("''", "'")
            } else if rest.starts_with('"') && rest.ends_with('"') {
                rest[1..rest.len()-1].to_string()
            } else {
                rest.to_string()
            };
            chars.push(ch);
        } else if s == "-" {
            chars.push(String::new());
        } else {
            in_dict = false;
        }
    }
}
// Manually append trailing space character for CTC index 18709
chars.push(" ".to_string());
```

---

### 5.3. CTC Confidence: Raw Maximum vs Softmax

PaddleOCR's `CTCLabelDecode` uses the **raw maximum score** as confidence:

```python
preds_prob = preds.max(axis=2)   # Raw max, NOT softmax
```

```rust
// WRONG: Computing softmax on already post-softmax probability values
let prob = softmax_prob(data, offset, num_classes, max_idx);

// CORRECT: Take raw maximum value matching Python
let prob = max_val;
```

---

### 5.4. Detection Dynamic Resizing: Multiple of 32

DB text detection models require input dimensions to be strictly divisible by 32:

```rust
// limit_type="max": only downscale if max side > 960
let ratio = if orig_h.max(orig_w) > 960 {
    if orig_h > orig_w { 960.0 / orig_h as f32 } else { 960.0 / orig_w as f32 }
} else {
    1.0 // no upscale — pass through unchanged
};
let h = (((orig_h as f32 * ratio) / 32.0).round() as usize * 32).max(32);
let w = (((orig_w as f32 * ratio) / 32.0).round() as usize * 32).max(32);
```

---

### 5.5. Dynamic Model Width for Recognition (No Hard Caps)

The text recognition model has a dynamic width dimension `[N, 3, 48, DynamicDimension]`. In Python, `imgW = int(imgH * max_wh_ratio)` without a hard cap.

```rust
// CORRECT: Dynamic width without arbitrary capping
let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32);

// WRONG: Hard cap at 320 — crushes long lines into illegible strips
let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32).min(320);
```

---

### 5.6. Text Box Ordering & Merging

Between detection and recognition, two postprocessing steps preserve natural reading order:

1. **`sorted_boxes`**: Primary sort by top-left Y, secondary by top-left X. Boxes within 10px vertically are considered on the same line and sorted left-to-right.
2. **`merge_fragmented`**: Iteratively merges boxes within 10px on both X and Y axes to prevent split line fragments.

---

### 5.7. Orientation Classifier (180° Inversion)

Binary classifier (`0` = 0°, `1` = 180°). If the 180° score exceeds the 0° score with confidence > 0.9, rotate the cropped patch by 180° before feeding it into the recognition model:

```rust
let score_0 = cls_data[0];
let score_180 = cls_data[1];
if score_180 > score_0 && score_180 > 0.9 {
    cropped_line = image::imageops::rotate180(&cropped_line);
}
```

---

## 6. Step-by-Step Debugging Workflow

1. **Verify Preprocessing Statistics**: Compare tensor min, max, and mean against Python.
2. **Verify Detection Signal**: Ensure detector output max is > 0.2 and pixel counts above threshold match Python.
3. **Inspect Argmax Indices**: Verify first 10 argmax predictions before dictionary decoding.
4. **Run Standalone Verification Binaries**: Execute isolated test binaries in `curator-ml/src/bin/`:

   ```powershell
   cargo run -p curator-ml --bin test_ort_wd_tagger
   cargo run -p curator-ml --bin test_ort_safety_classifier
   ```

---

## 7. Checklist for Porting New Models

- [ ] Inspect model manifest, config files, and original Python repository source code.
- [ ] Write a minimal Python diagnostic script to record input/output tensor shapes and statistics.
- [ ] Confirm dynamic dimensions, fixed dimensions, and tensor data types (`f32`, `i64`).
- [ ] Identify channel order convention (BGR vs RGB) and normalization mean/std constants.
- [ ] Implement Rust preprocessing and compare intermediate tensor stats against Python.
- [ ] Run inference via `ort::Session` and verify output tensor shapes.
- [ ] Implement postprocessing (NMS, CTC decode, argmax classification, softmax thresholds).
- [ ] Create a standalone verification test binary in `curator-ml/src/bin/`.
- [ ] Integrate into `model_manifest.json` catalog and gRPC service dispatcher.
