# Machine Learning Inference & Model Pipelines

Project Curator utilizes ONNX Runtime (`ort`) with hardware acceleration (DirectML on Windows, CoreML on macOS, CUDA/ROCm on Linux, with CPU fallback) to execute local inference models.

---

## 1. Supported Model Pipelines

| Pipeline | Models | Description & Tensor Specifications |
| :--- | :--- | :--- |
| **Embeddings** | `CLIP ViT-B/32`, `MobileCLIP S2` | Dual-encoder models producing 512-d dense vectors for semantic text and image similarity. |
| **Danbooru Taggers** | `Camie Tagger v2`, `WD EVA02 Tagger 2026 Canary` | Multi-label classification models predicting Danbooru tags, character identities, and ratings. |
| **Safety Classifier** | `NSFW Detection 2 Mini` | 5-class EfficientNet image safety classification (Safe, Neutral, Suggestive, Explicit, Extreme). |
| **Person & Character** | `YOLOv8 Person`, `CCIP CAFormer` | Anime person detection bounding boxes + CCIP metric feature embeddings for character clustering. |
| **OCR & Text** | `PP-OCRv6 Det/Rec`, `PP-LCNet Cls`, `Manga Bubble YOLO` | Text box detection, 0/180° orientation classification, text recognition, and speech bubble detection. |

---

## 2. Critical ML Preprocessing & Tokenization Rules

### 1. CLIP & MobileCLIP Text Tokenization

- **Fixed Sequence Length Zero-Padding**: Sequence input IDs **must be padded with zeros (`0`)** up to the exact maximum sequence length of **77**.
- **No EOS Token Repetition**: Do **NOT** repeat `<|endoftext|>` / `EOS` tokens across padded slots. Repeating EOS tokens corrupts the positional embeddings and destroys transformer pooling representations.
- **Attention Mask**: Attention mask must be `1` for valid token positions (including `<|startoftext|>` and the single terminating `<|endoftext|>`), and `0` for all zero-padded trailing slots.

### 2. Image Preprocessing & Tensor Normalization

- **CLIP / MobileCLIP**: RGB channel order, bicubic interpolation resize to 224×224 (CLIP) or 256×256 (MobileCLIP), normalized by ImageNet mean `[0.48145466, 0.4578275, 0.40821073]` and std `[0.26862954, 0.26130258, 0.27577711]`.
- **Danbooru Taggers**: RGB channel order, Bbox square aspect-ratio padding or resize according to tagger config (e.g. 448×448 for WD EVA02).
- **PaddleOCR Detection**: **BGR** channel order, resize longest side to 960 (rounded to multiple of 32), normalized by `(pixel / 255.0 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]`.
- **PaddleOCR Recognition**: Dynamic width dimension preserving image aspect ratio (height normalized to 48px).

---

## 3. Execution Providers & Device Preference

Inference device preferences can be configured globally or per-pipeline (`auto`, `gpu`, `cpu`):

- **DirectML (`DmlExecutionProvider`)**: Primary hardware accelerator on Windows.
- **CPU Fallback (`CpuExecutionProvider`)**: Universal fallback when GPU device is unavailable or unselected.
- **Model Verification**: Before modifying inference logic, always run the standalone model-verification binaries in `curator-ml/src/bin/` (e.g., `test_ort_wd_tagger.rs`, `test_ort_clip.rs`).
