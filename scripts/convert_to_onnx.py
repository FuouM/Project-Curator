#!/usr/bin/env python3
"""Convert a WD-tagger Safetensors checkpoint to a Project Curator ONNX model.

Downloads model.safetensors / selected_tags.csv / config.json from a Hugging
Face repo, builds the timm architecture, exports to ONNX, simplifies it,
validates the output shape, and writes a camie-compatible metadata JSON so the
existing Rust MetadataRoot loader can consume it unchanged.

Invoked by the service (mirroring scripts/quantize-models.py) via
scripts/venv/Scripts/python.exe. Fails fast with a clear message on any error.
"""

import argparse
import csv
import json
import os
import sys

DEFAULT_REPO = "ashen-sensored/wd-eva02-tagger-2026-canary"
DEFAULT_ARCH = "eva02_large_patch14_448"
NUM_CLASSES = 16473
INPUT_SIZE = 448
OPSET = 17

# WD selected_tags.csv category -> Project Curator category.
CATEGORY_MAP = {
    9: "rating",
    4: "character",
    0: "general",
}


def log(msg: str) -> None:
    print(f"[convert_to_onnx] {msg}", flush=True)


def resolve_out_dir(out_dir: str) -> str:
    """Resolve --out-dir relative to the repository root (this script's parent)."""
    if os.path.isabs(out_dir):
        return out_dir
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    return os.path.join(project_root, out_dir)


def download_files(repo_id: str, out_dir: str) -> dict:
    from huggingface_hub import hf_hub_download

    filenames = ["model.safetensors", "selected_tags.csv", "config.json"]
    paths = {}
    for fn in filenames:
        dest = os.path.join(out_dir, fn)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            log(f"reusing existing {fn} ({os.path.getsize(dest)} bytes)")
            paths[fn] = dest
            continue
        log(f"downloading {fn} from {repo_id} ...")
        local = hf_hub_download(repo_id=repo_id, filename=fn, local_dir=out_dir)
        paths[fn] = local
        log(f"downloaded {fn} -> {local}")
    return paths


def build_model(arch: str, num_classes: int, safetensors_path: str):
    import timm
    import torch
    from safetensors.torch import load_file

    log(f"creating timm model {arch} (num_classes={num_classes}) ...")
    model = timm.create_model(arch, pretrained=False, num_classes=num_classes)
    log(f"loading state dict from {safetensors_path} ...")
    state_dict = load_file(safetensors_path)
    model.load_state_dict(state_dict, strict=True)
    model.eval()
    return model, torch


def export_onnx(model, torch, out_path: str) -> None:
    x = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    with torch.no_grad():
        torch.onnx.export(
            model,
            x,
            out_path,
            input_names=["pixel_values"],
            output_names=["logits"],
            opset_version=OPSET,
            do_constant_folding=True,
        )
    log(f"exported ONNX -> {out_path} ({os.path.getsize(out_path)} bytes)")


def simplify_onnx(onnx_path: str) -> None:
    import onnx
    import onnxsim

    log("simplifying with onnxsim ...")
    model = onnx.load(onnx_path)
    simplified, check_ok = onnxsim.simplify(model)
    if not check_ok:
        raise RuntimeError("onnxsim.simplify returned check_ok=False")
    onnx.save(simplified, onnx_path)
    log(f"simplified ONNX saved ({os.path.getsize(onnx_path)} bytes)")


def build_metadata_json(csv_path: str, num_classes: int) -> dict:
    """Build a camie-compatible MetadataRoot from selected_tags.csv.

    The ONNX output index aligns with the CSV ROW ORDER (index 0..N-1), NOT the
    tag_id column, so idx_to_tag is keyed by row index (stringified), matching
    camie's format and the Rust lookups.
    """
    idx_to_tag = {}
    tag_to_category = {}
    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header is None:
            raise RuntimeError(f"selected_tags.csv is empty: {csv_path}")
        norm = [h.strip().lower() for h in header]
        if "name" not in norm or "category" not in norm:
            raise RuntimeError(f"unexpected selected_tags.csv header: {header}")
        name_idx = norm.index("name")
        cat_idx = norm.index("category")
        for row_index, row in enumerate(reader):
            if len(row) <= max(name_idx, cat_idx):
                raise RuntimeError(f"malformed CSV row {row_index}: {row}")
            name = row[name_idx].strip()
            if not name:
                raise RuntimeError(f"empty tag name at row {row_index}")
            try:
                cat = int(row[cat_idx].strip())
            except ValueError as e:
                raise RuntimeError(
                    f"bad category at row {row_index}: {row[cat_idx]}"
                ) from e
            idx_to_tag[str(row_index)] = name
            tag_to_category[name] = CATEGORY_MAP.get(cat, "general")

    if len(idx_to_tag) != num_classes:
        raise RuntimeError(
            f"tag count mismatch: CSV has {len(idx_to_tag)} rows but model has {num_classes} classes"
        )

    return {
        "model_info": {"img_size": INPUT_SIZE},
        "dataset_info": {
            "tag_mapping": {
                "idx_to_tag": idx_to_tag,
                "tag_to_category": tag_to_category,
            }
        },
    }


def validate_onnx(onnx_path: str, num_classes: int) -> None:
    import numpy as np
    import onnxruntime as ort

    log("validating with onnxruntime ...")
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    if inp.shape != [1, 3, INPUT_SIZE, INPUT_SIZE] and tuple(inp.shape[1:]) != (
        3,
        INPUT_SIZE,
        INPUT_SIZE,
    ):
        raise RuntimeError(f"unexpected input shape {inp.shape}")
    if out.shape != [1, num_classes]:
        raise RuntimeError(
            f"unexpected output shape {out.shape} (expected [1,{num_classes}])"
        )
    rng = np.random.default_rng(0)
    x = (rng.standard_normal((1, 3, INPUT_SIZE, INPUT_SIZE)) * 0.5).astype(np.float32)
    res = sess.run([out.name], {inp.name: x})[0]
    if res.shape != (1, num_classes):
        raise RuntimeError(
            f"runtime output shape {res.shape} does not match [1,{num_classes}]"
        )
    log(f"onnxruntime OK: input={inp.name}{inp.shape} output={out.name}{out.shape}")
    log(f"logits sample: min={res.min():.4f} max={res.max():.4f} mean={res.mean():.4f}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert WD tagger safetensors to Project Curator ONNX"
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Hugging Face repo id")
    parser.add_argument(
        "--out-dir",
        default=".curator/models/wd-eva02-tagger-2026-canary",
        help="Output directory (relative to repo root, or absolute)",
    )
    parser.add_argument("--arch", default=DEFAULT_ARCH, help="timm architecture name")
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Require model.safetensors/selected_tags.csv already present in out-dir",
    )
    args = parser.parse_args()

    out_dir = resolve_out_dir(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    log(f"output directory: {out_dir}")

    paths = (
        download_files(args.repo, out_dir)
        if not args.skip_download
        else {
            fn: os.path.join(out_dir, fn)
            for fn in ("model.safetensors", "selected_tags.csv", "config.json")
        }
    )
    for fn, p in paths.items():
        if not os.path.exists(p):
            raise RuntimeError(f"required file missing: {p}")

    model, torch = build_model(args.arch, NUM_CLASSES, paths["model.safetensors"])

    onnx_path = os.path.join(out_dir, "wd-eva02-tagger-2026-canary.onnx")
    export_onnx(model, torch, onnx_path)
    del model
    simplify_onnx(onnx_path)

    metadata = build_metadata_json(paths["selected_tags.csv"], NUM_CLASSES)
    meta_path = os.path.join(out_dir, "wd-eva02-tagger-2026-canary-metadata.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, ensure_ascii=False)
    log(
        f"wrote metadata JSON -> {meta_path} ({len(metadata['dataset_info']['tag_mapping']['idx_to_tag'])} tags)"
    )

    validate_onnx(onnx_path, NUM_CLASSES)

    log("conversion complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[convert_to_onnx] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
