"""Fail-fast CUDA smoke test for the comfy-kitchen INT8 kernels."""

from __future__ import annotations

import importlib.metadata
import json

EXPECTED_COMFY_KITCHEN_VERSION = "0.2.31"


def main() -> int:
    import comfy_kitchen  # noqa: F401 - importing registers torch custom ops
    import torch
    from comfy_kitchen.tensor.int8 import TensorWiseINT8Layout

    installed_version = importlib.metadata.version("comfy-kitchen")
    if installed_version != EXPECTED_COMFY_KITCHEN_VERSION:
        raise RuntimeError(
            "comfy-kitchen version mismatch: "
            f"expected {EXPECTED_COMFY_KITCHEN_VERSION}, got {installed_version}"
        )
    if not torch.cuda.is_available():
        raise RuntimeError("kitchen_int8 requested, but torch.cuda.is_available() is false")
    if not hasattr(torch.ops.comfy_kitchen, "int8_linear"):
        raise RuntimeError("comfy-kitchen did not register torch.ops.comfy_kitchen.int8_linear")

    device = torch.device("cuda")
    activation = torch.randn((16, 256), device=device, dtype=torch.bfloat16)
    weight = torch.randn((256, 256), device=device, dtype=torch.bfloat16)
    qdata, params = TensorWiseINT8Layout.quantize(
        weight,
        is_weight=True,
        per_channel=True,
        convrot=True,
        convrot_groupsize=256,
        stochastic_rounding=0,
    )
    output = torch.ops.comfy_kitchen.int8_linear(
        activation,
        qdata,
        params.scale,
        None,
        2,  # comfy-kitchen output dtype code: bfloat16
        True,
        256,
    )
    torch.cuda.synchronize()
    if output.shape != (16, 256) or output.dtype != torch.bfloat16:
        raise RuntimeError(
            f"unexpected kitchen_int8 output: shape={tuple(output.shape)}, dtype={output.dtype}"
        )
    if not torch.isfinite(output).all().item():
        raise RuntimeError("kitchen_int8 CUDA kernel returned a non-finite value")
    print(
        json.dumps(
            {
                "self_test": "kitchen_int8_cuda_kernels",
                "status": "passed",
                "comfy_kitchen": installed_version,
                "torch": torch.__version__,
                "cuda_runtime": torch.version.cuda,
                "gpu": torch.cuda.get_device_name(0),
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
