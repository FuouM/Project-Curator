# Porting ML Inference Pipelines to Rust: A Field Guide

This guide is written for future agents working on this codebase. It documents
the patterns, pitfalls, and debugging workflow for porting Python ML inference
(particularly PaddleOCR) to Rust using `ort` (ONNX Runtime bindings).

> All lessons here were learned the hard way during the PaddleOCR port in
> `curator-core/src/detection/ocr.rs`. Read the code alongside this guide.

---

## 1. The Porting Mental Model

A Python inference pipeline is a chain of pure transformations:

```
raw image → preprocess → model input tensor → ONNX model → raw output tensor → postprocess → result
```

Each stage must be reproduced **bit-for-bit**. Even minor deviations (wrong
channel order, wrong normalization scale, wrong transform direction) produce
silently wrong results — the code compiles, runs, and returns garbage.

**The golden rule: reproduce the Python, not what you think the Python does.**
Always read the actual reference source, not a summary of it.

---

## 2. Start with Python — Validate Before Porting

Before writing any Rust, validate the full pipeline in Python on the target
model and a real test image. Ask the user for their Python environment path,
or locate a local virtual environment where `onnxruntime`, `numpy`, and `opencv-python`
are installed.

Write a self-contained diagnostic script (see the scratch artifact
`diagnose_ocr.py` in this conversation for a template). Your script must:

1. Load the ONNX model with `onnxruntime`
2. Print input/output **names** and **shapes** (including dynamic dims)
3. Run the full preprocessing → inference → postprocessing chain
4. Print intermediate tensors: shape, min, max, mean, first few values
5. Print the final decoded result

```python
import onnxruntime as ort
sess = ort.InferenceSession("model.onnx", providers=["CPUExecutionProvider"])
print("inputs:", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
print("outputs:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])
```

**Key things to learn from this step:**
- Exact input/output tensor **names** (e.g. `"x"`, `"fetch_name_0"`)
- Whether width/height are **dynamic** dims — critical for recognition models
- What the model actually outputs (logits? log-softmax? softmax probabilities?)
- The exact preprocessing formulas from the reference code

---

## 3. Reading the Reference Source

PaddleOCR config YML files (`inference.yml`) describe the full pipeline.
Cross-reference them against the Python source in `reference/PaddleOCR/ppocr/`:

| YAML key | Python implementation |
|----------|----------------------|
| `PreProcess.transform_ops` | `ppocr/data/imaug/operators.py` |
| `PostProcess` | `ppocr/postprocess/db_postprocess.py`, `rec_postprocess.py` |
| `DetResizeForTest` | Resizes the **longest** side to `limit_side_len` (default 960, `limit_type="max"`), rounds to 32. Only downscales — images smaller than the limit pass through unchanged. |
| `NormalizeImage` | `(pixel/scale - mean) / std`, applied in **BGR channel order** |
| `RecResizeImg` | Resize to fixed height (48), **dynamic width** via `imgW = int(imgH * max_wh_ratio)` per batch — no hard cap |
| `CTCLabelDecode` | Argmax per timestep, remove blanks (index 0) and consecutive duplicates |

### Detection normalization (BGR order!)
```python
mean = [0.485, 0.456, 0.406]   # applied to BGR channels
std  = [0.229, 0.224, 0.225]
pixel_norm = (pixel_bgr / 255.0 - mean) / std
```

### Recognition normalization (symmetric, channel-agnostic)
```python
pixel_norm = (pixel / 255.0 - 0.5) / 0.5  # range [-1, 1]
```

---

## 4. The `ort` Crate in Rust

This project uses `ort` (ONNX Runtime Rust bindings). Key patterns:

### Creating a session
```rust
use ort::{Session, GraphOptimizationLevel};

let session = Session::builder()?
    .with_optimization_level(GraphOptimizationLevel::Level3)?
    .commit_from_file(model_path)?;
```

### Running inference
```rust
use ort::inputs;
use ndarray::Array4;

let tensor: Array4<f32> = Array4::zeros((1, 3, height, width));
// fill tensor...
let outputs = session.run(inputs![TensorRef::from_array_view(&tensor)?])?;
```

`inputs![]` passes tensors **positionally** (matching input order, not by name).
For multi-input models, use named inputs: `inputs!["x" => tensor]`.

### Extracting output
```rust
let out = outputs.get("fetch_name_0")
    .or_else(|| outputs.get("output_0"))
    .or_else(|| outputs.get("output"))
    .context("output tensor not found")?;
let (shape, data) = out.try_extract_tensor::<f32>()?;
// shape: Vec<i64>, data: ndarray view coercible to &[f32]
// layout: C-contiguous row-major (same as numpy default)
```

### Tensor layout
For a tensor of shape `[N, C, H, W]`, the element at `[n, c, h, w]` is at:
```
data[n*(C*H*W) + c*(H*W) + h*W + w]
```
This matches numpy's default C order.

---

## 5. Critical Pitfalls (Learned the Hard Way)

### 5.1 Perspective transform direction

When implementing an inverse warp (fill destination pixels by looking up source):

```rust
// WRONG: H maps src→dst, but we're using it to look up src from dst
let h = get_perspective_transform(src_pts, dst_pts)?;

// CORRECT: swap so H maps dst→src directly
let h = get_perspective_transform(dst_pts, src_pts)?;
```

OpenCV's `warpPerspective` takes an `H` that maps *source* to *destination*
and internally inverts it. If you implement the warp loop yourself (iterating
over destination pixels and back-projecting into source), you need `H(dst→src)`,
so **swap the arguments**.

**Symptom:** All recognition model outputs are blank (argmax all zeros).
The crop has correct dimensions but samples pixels from a wrong image region.

PaddleOCR's `inference.yml` character dict has 18000+ entries and may contain
blank lines in the middle of the block sequence. YAML allows this; naive parsers
don't. Furthermore, YAML single-quoted strings escape single quotes with two single quotes (`''` -> `'`). Also, PP-OCRv6 uses `use_space_char=True`, which means a space character (`" "`) must be manually appended to the dictionary to map the final CTC class (index 18709).

```rust
for line in content.lines() {
    let s = line.trim_end_matches('\r').trim();
    if s.is_empty() { continue; }           // skip blanks, stay in section
    if s == "character_dict:" { in_dict = true; continue; }
    if in_dict {
        if let Some(rest) = s.strip_prefix("- ") {
            let ch = if rest.starts_with('\'') && rest.ends_with('\'') {
                // YAML single-quoted scalar: '' inside means literal '
                let inner = &rest[1..rest.len()-1];
                inner.replace("''", "'")
            } else if rest.starts_with('"') && rest.ends_with('"') {
                rest[1..rest.len()-1].to_string()
            } else {
                rest.to_string()
            };
            chars.push(ch);
        } else if s == "-" {
            chars.push(String::new());       // bare dash = empty string
        } else {
            in_dict = false;                 // non-list line ends section
        }
    }
}
// Manually append the space character for use_space_char=True models
chars.push(" ".to_string());
```

**Symptom:** `dict_len=1749` instead of 18709, and words are joined without spaces (e.g. `TOBUYTHISBOOK` instead of `TO BUY THIS BOOK`). Double single-quotes show up as `''` (e.g. `I COULO''VE` instead of `I COULO'VE`).

### 5.3 CTC confidence: raw max vs softmax

PaddleOCR's `CTCLabelDecode` uses the **raw max value** as confidence:

```python
preds_prob = preds.max(axis=2)   # raw max, NOT softmax
```

```rust
// WRONG: computing softmax of already-probability values
let prob = softmax_prob(data, offset, num_classes, max_idx);

// CORRECT: raw max value, matching Python exactly
let prob = max_val;
```

**Symptom:** Text decoded correctly but `conf=0.000` for every result.
Everything filtered out by the confidence threshold.

### 5.4 Channel order (BGR vs RGB)

PaddleOCR models are trained on **BGR** input (OpenCV convention).
The Rust `image` crate returns **RGB**. For detection:

```rust
let r = data[base] as f32 / 255.0;   // image crate: R first
let g = data[base+1] as f32 / 255.0;
let b = data[base+2] as f32 / 255.0;
// Write in BGR order to match PaddleOCR training
tensor[[0, 0, y, x]] = (b - 0.485) / 0.229;  // channel 0 = B
tensor[[0, 1, y, x]] = (g - 0.456) / 0.224;  // channel 1 = G
tensor[[0, 2, y, x]] = (r - 0.406) / 0.225;  // channel 2 = R
```

### 5.5 Detection resize: longest side to 960, multiple of 32

```rust
// limit_type="max": only downscale if max side > 960
let ratio = if orig_h.max(orig_w) > 960 {
    if orig_h > orig_w { 960.0 / orig_h as f32 } else { 960.0 / orig_w as f32 }
} else {
    1.0  // no upscale — pass through unchanged
};
let h = (((orig_h as f32 * ratio) / 32.0).round() as usize * 32).max(32);
let w = (((orig_w as f32 * ratio) / 32.0).round() as usize * 32).max(32);
```

**Gotcha:** `inference.yml` may specify `limit_type: "min"` with `limit_side_len: 736`, but the actual Python defaults (from `utility.py`) are `limit_type: "max"` and `limit_side_len: 960`. Always cross-reference against `tools/infer/utility.py`, not the YAML.

### 5.6 Dynamic model width for recognition (NO hard cap)

The recognition model has a dynamic width: `[N, 3, 48, DynamicDimension]`.
The ONNX model accepts variable-width inputs up to ~3200 (from TRT dynamic shapes).

**Critical:** PaddleOCR's inference path computes `imgW = int(imgH * max_wh_ratio)`
per batch with no hard upper cap. The width is determined by the widest aspect ratio
in the current batch. A detected line with aspect ratio 20:1 gets a 960px canvas.

```rust
// CORRECT: dynamic width, no cap
let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32);

// WRONG: hard cap at 320 — crushes long document text
let target_w = ((target_h as f32 * ratio).ceil() as usize).max(32).min(320);
```

**Symptom of capping:** Document paragraphs produce gibberish or words run together
(e.g., `TOBUYTHISBOOK` instead of `TO BUY THIS BOOK`). Long text lines are
compressed into a 320px-wide strip, destroying recognition quality.

The `max_wh_ratio` in PaddleOCR's `predict_rec.py` is initialized to
`imgW / imgH = 320 / 48 ≈ 6.67` but expands freely for wider crops. There is
no `max_text_length` constraint on image width — that parameter only applies to
certain decoder algorithms (VisionLAN), not CTC models.

### 5.7 Detection thresholds: reference defaults vs inference.yml

The `inference.yml` shipped with PP-OCRv6 models contains conservative thresholds
(e.g., `det_db_thresh: 0.2`, `det_db_box_thresh: 0.45`, `det_db_unclip_ratio: 1.4`).
However, the actual Python inference defaults in `tools/infer/utility.py` are different:

| Parameter | inference.yml | Python default | Effect |
|-----------|--------------|----------------|--------|
| `det_db_thresh` | 0.2 | **0.3** | Higher = fewer false-positive text detections |
| `det_db_box_thresh` | 0.45 | **0.6** | Higher = only keep high-confidence boxes |
| `det_db_unclip_ratio` | 1.4 | **1.5** | Higher = slightly larger boxes |

Always use the **Python defaults** from `utility.py`, not the YAML values. The YAML
values are training-time defaults, not inference-time defaults.

```rust
// CORRECT: Python inference defaults
let det_thresh = 0.3;
let box_thresh = 0.6;
let unclip_ratio = 1.5;
```

### 5.8 Box ordering and merging

PaddleOCR's `predict_system.py` applies two post-processing steps after detection
that are easy to miss:

1. **`sorted_boxes()`** — Sorts detection boxes top-to-bottom, left-to-right.
   Primary sort by top-left Y, secondary by top-left X. Boxes within 10px vertically
   are treated as same-line and sorted left-to-right. This ensures recognition
   processes text in reading order.

2. **`merge_fragmented()`** — Iteratively merges boxes that are within 10px of each
   other on both X and Y axes. This handles cases where the DB detector splits a
   single text line into multiple adjacent fragments.

Both functions live in `ppocr/utils/utility.py`. They are **not** in the postprocessor
itself — they're called in the system pipeline between detection and recognition.

**Symptom of missing sorting:** Text from different lines gets interleaved in the
output, or boxes are processed bottom-to-top instead of top-to-bottom.

**Symptom of missing merging:** A single text line gets recognized as two or more
fragments with duplicated or partial text.

### 5.9 Angle classifier (180° rotation)

PP-OCR models include an optional textline orientation classifier
(`PP-LCNet_x1_0_textline_ori_onnx`) that detects and corrects upside-down text.

The classifier is a binary model: output index 0 = 0° (correct), index 1 = 180°
(inverted). If the 180° score exceeds the 0° score with confidence > 0.9, the
cropped line is rotated 180° before recognition.

```rust
// Binary classifier: [0°, 180°] — index 1 = 180°
let score_0 = cls_data[0];
let score_180 = cls_data[1];
if score_180 > score_0 && score_180 > 0.9 {
    cropped_line = image::imageops::rotate180(&cropped_line);
}
```

The classifier is optional — if the model file is not present, the code skips
angle classification entirely. Preprocessing: resize to 48×192, normalize to
`[-1, 1]` (same formula as recognition).

---

## 6. Debugging Workflow

When model outputs are wrong but no errors are thrown, add temporary
`eprintln!` instrumentation at each stage. **Remove all before committing.**

### Step 1: Verify preprocessing stats match Python
```rust
let min = tensor.iter().cloned().fold(f32::INFINITY, f32::min);
let max = tensor.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
eprintln!("input tensor: shape={:?}, min={:.3}, max={:.3}", tensor.shape(), min, max);
```
Compare: Python's `print(f"min={inp.min():.3f}, max={inp.max():.3f}")`.

### Step 2: Verify detection output has signal
```rust
let above = pred_data.iter().filter(|&&v| v > 0.2).count();
eprintln!("det output max={:.4}, pixels>0.2={}", pred_data.iter().cloned().fold(f32::NEG_INFINITY, f32::max), above);
```
If `max ≈ 0` or `above = 0`: preprocessing is wrong.
If `above > 10000`: detection is working, problem is in postprocessing.

### Step 3: Inspect recognition argmax
```rust
let argmax_10: Vec<usize> = (0..seq_len.min(10)).map(|t| {
    let off = t * num_classes;
    let mut mi = 0; let mut mv = data[off];
    for c in 1..num_classes { if data[off+c] > mv { mv = data[off+c]; mi = c; } }
    mi
}).collect();
eprintln!("argmax[:10] = {:?}", argmax_10);
```
If all zeros → crop content is wrong (pitfall 5.1 — warp direction).
If non-zero but text="" → dict lookup is failing (pitfall 5.2 or 5.3).

### Step 4: Use the Python diagnostic script

The `diagnose_ocr.py` script in the conversation scratch folder is the
canonical reference. Run it with your configured Python environment:

```powershell
python diagnose_ocr.py
```

Always add this at the top to handle CJK characters in the terminal:
```python
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
```

---

## 7. Model File Layout

```
.curator/models/PP-OCRv6_medium_det_onnx/
    inference.onnx    ← text detection model (DB-based segmentation)
    inference.yml     ← preprocessing config (thresholds, resize params)

.curator/models/PP-OCRv6_medium_rec_onnx/
    inference.onnx    ← text recognition model (CTC decoder)
    inference.yml     ← character_dict (18000+ entries, use_space_char=True)

.curator/models/PP-LCNet_x1_0_textline_ori_onnx/   ← optional
    inference.onnx    ← textline orientation classifier (180° rotation)
    inference.yml     ← preprocessing (48x192, normalize to [-1,1])
```

Use **relative paths** from the workspace root. Never hardcode absolute
Windows paths. The `OcrDetector::new()` constructor takes model directory paths.
Small model variants have been removed — only medium models are used.

---

## 8. Testing Infrastructure

```powershell
. .\env.ps1   # always source this first — sets ONNXRUNTIME_LIB_PATH etc.

# Run single OCR test with output
cargo test -p curator-core --test db_tests test_ocr_image_transcription_extraction -- --nocapture

# Run all db_tests (includes OCR schema, detector sanity, transcription)
cargo test -p curator-core --test db_tests -- --nocapture
```

Test images live in `reference/orc_test_images/`. The transcription test asserts
that at least one text block is extracted with confidence > 0.5.

---

## 9. Checklist for Porting a New Model

- [ ] Read `inference.yml` — identify all PreProcess and PostProcess steps
- [ ] Read the actual Python source — don't trust summaries
- [ ] Cross-reference `tools/infer/utility.py` for inference defaults (may differ from YAML)
- [ ] Run the Python diagnostic script; record input/output shapes and stats
- [ ] Confirm input dims: fixed or dynamic? Single or multi-input?
- [ ] Confirm output type: logits / log-softmax / probabilities?
- [ ] Confirm channel convention: BGR or RGB?
- [ ] Implement Rust preprocessing; verify stats match Python
- [ ] Run the model; verify output has signal (non-trivial max values)
- [ ] Implement postprocessing; compare decoded results with Python
- [ ] For detection: verify box ordering (sorted_boxes) and merging (merge_fragmented)
- [ ] For recognition: verify dynamic width (no hard cap) and use_space_char handling
- [ ] Write an integration test using a real image
- [ ] Remove all debug `eprintln!` before committing
