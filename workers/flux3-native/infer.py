"""One-shot local FLUX.3 Klein inference using official Hugging Face Diffusers.

This process intentionally does not import or use ComfyUI.
Input: validated JSON on stdin. Output: a PNG at the specified local path.
It does not serve the network or accept arbitrary model identifiers.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MODEL_ID = "black-forest-labs/flux-3-image-klein"
MAX_REFERENCES = 10


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("Expected JSON object")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 30000:
        raise ValueError("Prompt required (max 30000 characters)")
    for key in ("width", "height"):
        value = request.get(key, 512)
        if not isinstance(value, int) or value < 256 or value > 2048 or value % 16:
            raise ValueError(f"{key} must be a multiple of 16 within 256..2048")
    steps = request.get("steps", 16)
    if not isinstance(steps, int) or not 1 <= steps <= 50:
        raise ValueError("steps must be within 1..50")
    seed = request.get("seed", 0)
    if not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError("Invalid seed")
    images = request.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_REFERENCES:
        raise ValueError("A maximum of ten reference images is supported")
    if not all(isinstance(path, str) and Path(path).is_file() and
               Path(path).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} for path in images):
        raise ValueError("All references must be existing local images")
    output = request.get("output")
    if not isinstance(output, str) or Path(output).suffix.lower() != ".png":
        raise ValueError("Output must be a local PNG path")
    return request


def generate(request: dict) -> None:
    """One-shot CLI path: load, render once, exit."""
    result = render(load_pipeline(), request)
    print(json.dumps(result, ensure_ascii=False), flush=True)


def load_pipeline():
    """Load FLUX.3 Klein once. The persistent worker (worker.py) keeps the result."""
    # Imported lazily so --check can run without model packages or credentials.
    import torch
    from diffusers import ComponentsManager, ModularPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("FLUX.3 needs a CUDA GPU; none is available in this Python runtime")

    # Official Diffusers recipe: a quantized transformer with automatic CPU
    # offload. RTX 3080 lacks accelerated FP8 kernels, so the quantized
    # transformer will dequantize on each step; performance is unverified.
    from diffusers import BFLQuantizationConfig, Flux3Transformer2DModel

    # Do not load the optional 9B prompt upsampler: it increases RAM
    # requirements by ~19 GB. The caller supplies the final caption.
    manager = ComponentsManager()
    blocks = ModularPipeline.from_pretrained(MODEL_ID).blocks
    blocks.sub_blocks.pop("prompt_upsampler", None)  # absent in Flux3DistilledAutoBlocks (diffusers 0.41.0.dev0)
    pipe = blocks.init_pipeline(MODEL_ID, components_manager=manager)

    # Diffusers from_single_file expects the Hugging Face *blob* URL.
    # A /resolve/ URL was interpreted as a repository path and failed.
    transformer = Flux3Transformer2DModel.from_single_file(
        f"https://huggingface.co/{MODEL_ID}/blob/main/variants/fp8r/model.safetensors",
        config=MODEL_ID,
        subfolder="transformer",
        quantization_config=BFLQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16,
    )
    # Attach the already loaded FP8 transformer before loading the other
    # pipeline components. Diffusers skips already loaded components.
    pipe.update_components(transformer=transformer)
    pipe.load_components(dtype={"vae": torch.float32, "default": torch.bfloat16})
    manager.enable_auto_cpu_offload(device="cuda")
    # Deliberately DO NOT use pipe.to("cuda") with automatic CPU offload.
    return pipe


def render(pipe, request: dict) -> dict:
    import torch
    from PIL import Image

    args = {
        "prompt": request["prompt"],
        "width": request.get("width", 512),
        "height": request.get("height", 512),
        "num_inference_steps": request.get("steps", 16),
        "generator": torch.Generator(device="cpu").manual_seed(request.get("seed", 0)),
        "output": "images",
    }
    refs = request.get("images", [])
    if refs:
        if len(refs) == 1:
            args["image"] = Image.open(refs[0]).convert("RGB")
        else:
            args["image"] = [Image.open(path).convert("RGB") for path in refs]
    with torch.inference_mode():
        image = pipe(**args)[0]
    destination = Path(request["output"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    return {"ok": True, "output": str(destination), "width": image.width, "height": image.height}


def main() -> int:
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"ok": True, "backend": "diffusers", "model": MODEL_ID}))
        return 0
    if sys.argv[1:]:
        raise ValueError("Only --check is permitted")
    request = validate_request(json.load(sys.stdin))
    generate(request)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__,
                          "message": str(error)[:600]}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
