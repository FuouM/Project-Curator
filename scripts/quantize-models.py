#!/usr/bin/env python3
"""ONNX model quantization (fp16/int8) using onnxruntime."""

import argparse
import os
import sys


def quantize_onnx(input_path: str, output_path: str, quant_format: str):
    """Quantize an ONNX model."""
    import numpy as np
    import onnx
    import onnxruntime as ort
    from onnx import numpy_helper

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if quant_format == "fp16":
        try:
            from onnxconverter_common import float16

            model = onnx.load(input_path)
            model_fp16 = float16.convert_float_to_float16(model)
            onnx.save(model_fp16, output_path)
            # Validate
            ort.InferenceSession(output_path, providers=["CPUExecutionProvider"])
            print(f"OK: {output_path} ({os.path.getsize(output_path)} bytes)")
        except Exception as e:
            print(f"FP16 quantization failed: {e}", file=sys.stderr)
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except:
                    pass
            sys.exit(1)
    elif quant_format == "int8":
        try:
            model = onnx.load(input_path)

            # Check if model has FP16 (type 10) inputs, outputs, or initializers
            has_fp16 = False
            for ipt in model.graph.input:
                if (
                    ipt.type.HasField("tensor_type")
                    and ipt.type.tensor_type.elem_type == 10
                ):
                    has_fp16 = True
                    break
            if not has_fp16:
                for init in model.graph.initializer:
                    if init.data_type == 10:
                        has_fp16 = True
                        break

            quant_input = input_path
            temp_fp32_path = None

            if has_fp16:
                print(
                    "Model contains FP16 components. Upcasting to FP32 before dynamic quantization..."
                )
                # Convert inputs
                for ipt in model.graph.input:
                    if (
                        ipt.type.HasField("tensor_type")
                        and ipt.type.tensor_type.elem_type == 10
                    ):
                        ipt.type.tensor_type.elem_type = 1  # Float32

                # Convert outputs
                for opt in model.graph.output:
                    if (
                        opt.type.HasField("tensor_type")
                        and opt.type.tensor_type.elem_type == 10
                    ):
                        opt.type.tensor_type.elem_type = 1

                # Convert value_info
                for vi in model.graph.value_info:
                    if (
                        vi.type.HasField("tensor_type")
                        and vi.type.tensor_type.elem_type == 10
                    ):
                        vi.type.tensor_type.elem_type = 1

                # Convert initializers
                new_initializers = []
                for init in model.graph.initializer:
                    if init.data_type == 10:  # Float16
                        arr = numpy_helper.to_array(init)
                        arr_f32 = arr.astype(np.float32)
                        new_init = numpy_helper.from_array(arr_f32, name=init.name)
                        new_initializers.append(new_init)
                    else:
                        new_initializers.append(init)

                del model.graph.initializer[:]
                model.graph.initializer.extend(new_initializers)

                # Convert Cast nodes and tensor attributes
                for node in model.graph.node:
                    if node.op_type == "Cast":
                        for attr in node.attribute:
                            if attr.name == "to" and attr.i == 10:  # Cast to Float16
                                attr.i = 1  # Cast to Float32
                    for attr in node.attribute:
                        if (
                            attr.type == onnx.AttributeProto.TENSOR
                            and attr.t.data_type == 10
                        ):
                            arr = numpy_helper.to_array(attr.t)
                            arr_f32 = arr.astype(np.float32)
                            new_tensor = numpy_helper.from_array(
                                arr_f32, name=attr.t.name
                            )
                            attr.t.CopyFrom(new_tensor)

                temp_fp32_path = output_path + ".temp_fp32.onnx"
                onnx.save(model, temp_fp32_path)
                quant_input = temp_fp32_path

            from onnxruntime.quantization import QuantType, quantize_dynamic

            # Use QUInt8 for weights to ensure standard dynamic quantization Conv/ConvInteger support on CPU EPs
            quantize_dynamic(
                model_input=quant_input,
                model_output=output_path,
                weight_type=QuantType.QUInt8,
            )

            # Cleanup temp file
            if temp_fp32_path and os.path.exists(temp_fp32_path):
                try:
                    os.remove(temp_fp32_path)
                except:
                    pass

            # Validate quantized model loads
            ort.InferenceSession(output_path, providers=["CPUExecutionProvider"])
            print(f"OK: {output_path} ({os.path.getsize(output_path)} bytes)")
        except Exception as e:
            print(f"INT8 quantization failed: {e}", file=sys.stderr)
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except:
                    pass
            sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Quantize ONNX models")
    parser.add_argument("--input", required=True, help="Input .onnx file")
    parser.add_argument("--output", required=True, help="Output .onnx file")
    parser.add_argument("--format", choices=["fp16", "int8"], required=True)
    args = parser.parse_args()
    quantize_onnx(args.input, args.output, args.format)


if __name__ == "__main__":
    main()
