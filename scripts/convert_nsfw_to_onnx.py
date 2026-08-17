#!/usr/bin/env python3
"""Convert nsfw-detection-2-mini Safetensors checkpoint to Project Curator ONNX.

Exports model.safetensors into an ONNX model at nsfw-detection-2-mini/onnx/nsfw-detection-2-mini-fp16.onnx
with input shape [1, 3, 380, 380] and 5 output classes.
"""

import argparse
import os
import sys

INPUT_SIZE = 380
NUM_CLASSES = 5
OPSET = 17


def log(msg: str) -> None:
    print(f"[convert_nsfw_to_onnx] {msg}", flush=True)


def resolve_out_dir(out_dir: str) -> str:
    if os.path.isabs(out_dir):
        return out_dir
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    return os.path.join(project_root, out_dir)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert nsfw-detection-2-mini safetensors to Project Curator ONNX"
    )
    parser.add_argument(
        "--out-dir",
        default=".curator/models/nsfw-detection-2-mini",
        help="Output directory (relative to repo root, or absolute)",
    )
    parser.add_argument(
        "--skip-download", action="store_true", help="Skip downloading files"
    )
    parser.add_argument(
        "--repo", default="viddexa/nsfw-detection-2-mini", help="Hugging Face repo"
    )
    args = parser.parse_args()

    out_dir = resolve_out_dir(args.out_dir)
    safetensors_path = os.path.join(out_dir, "model.safetensors")
    if not os.path.exists(safetensors_path):
        raise RuntimeError(f"required safetensors file missing: {safetensors_path}")

    log(f"loading HuggingFace model from {out_dir} ...")
    import torch
    from transformers import AutoModelForImageClassification

    model = AutoModelForImageClassification.from_pretrained(out_dir)
    model.eval()

    onnx_dir = os.path.join(out_dir, "onnx")
    os.makedirs(onnx_dir, exist_ok=True)
    onnx_path = os.path.join(onnx_dir, "nsfw-detection-2-mini.onnx")

    log(f"exporting FP32 ONNX -> {onnx_path} ...")
    x = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    with torch.no_grad():
        torch.onnx.export(
            model,
            x,
            onnx_path,
            input_names=["image"],
            output_names=["logits"],
            opset_version=OPSET,
            do_constant_folding=True,
            dynamic_axes={"image": {0: "batch_size"}, "logits": {0: "batch_size"}},
        )

    log(f"exported ONNX -> {onnx_path} ({os.path.getsize(onnx_path)} bytes)")

    # Convert AveragePool nodes with erroneous kernel_shape to GlobalAveragePool for DirectML compatibility
    try:
        import onnx

        onnx_model = onnx.load(onnx_path)
        modified = False
        for node in onnx_model.graph.node:
            if node.op_type == "AveragePool":
                node.op_type = "GlobalAveragePool"
                del node.attribute[:]
                modified = True
        if modified:
            onnx.save(onnx_model, onnx_path)
            log(
                "converted AveragePool to GlobalAveragePool for DirectML GPU compatibility"
            )
    except Exception as e:
        log(f"GlobalAveragePool conversion skipped: {e}")

    # Validate ONNX model with onnxruntime
    # import numpy as np
    import onnxruntime as ort

    log("validating with onnxruntime ...")
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    log(f"onnxruntime OK: input={inp.name}{inp.shape} output={out.name}{out.shape}")

    log("conversion complete successfully.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[convert_nsfw_to_onnx] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
