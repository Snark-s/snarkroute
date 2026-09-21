#!/usr/bin/env python3
"""Decode a synthetic 5-second H3 latent without loading the text encoder or DiT."""

from __future__ import annotations

import gc
import json
import os
import time

from app.backends.matlow_runtime import GIB, MatlowRuntime, _dimensions, _frame_count
from app.config import Settings


def main() -> int:
    settings = Settings.from_env()
    runtime = MatlowRuntime(settings)
    status = runtime.probe()
    if not status.get("ready"):
        raise RuntimeError(status.get("reason") or "MATLOW runtime is not ready")

    modules = runtime._imports()
    torch = modules["torch"]
    model_management = modules["model_management"]
    models, load_seconds = runtime._load_models()
    vae = models["video_vae"]
    default_width, default_height = _dimensions("16:9")
    width = int(os.getenv("H3_MATLOW_SMOKE_WIDTH", str(default_width)))
    height = int(os.getenv("H3_MATLOW_SMOKE_HEIGHT", str(default_height)))
    if width % 16 or height % 16:
        raise RuntimeError("Smoke-test width and height must be multiples of 16")
    target_frames = _frame_count(5)
    latent_height = height // vae.first_stage_model.vae_ratio
    latent_width = width // vae.first_stage_model.vae_ratio
    latent_frames = next(
        value
        for value in range(1, target_frames + 1)
        if vae.first_stage_model.decode_output_shape(
            (1, vae.latent_channels, value, latent_height, latent_width)
        )[2]
        >= target_frames
    )
    latent = torch.zeros(
        (1, vae.latent_channels, latent_frames, latent_height, latent_width),
        dtype=torch.float32,
        device="cpu",
    )
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    try:
        with torch.inference_mode():
            images = vae.decode(latent)
        torch.cuda.synchronize()
    except Exception as error:
        diagnostic = {
            "error": f"{type(error).__name__}: {error}",
            "allocated_gib": torch.cuda.memory_allocated() / GIB,
            "reserved_gib": torch.cuda.memory_reserved() / GIB,
            "peak_vram_gib": torch.cuda.max_memory_reserved() / GIB,
            "vae_model_gib": vae.model_size() / GIB,
            "vae_dtype": str(vae.vae_dtype),
            "vae_tile_size": settings.matlow_vae_tile_size,
            "vae_tile_overlap": settings.matlow_vae_tile_overlap,
        }
        print(json.dumps(diagnostic, sort_keys=True))
        raise
    decode_seconds = time.perf_counter() - started
    result = {
        **status,
        "resolution": f"{width}x{height}",
        "target_frames": target_frames,
        "latent_shape": list(latent.shape),
        "decoded_shape": list(images.shape),
        "vae_tile_size": settings.matlow_vae_tile_size,
        "vae_tile_overlap": settings.matlow_vae_tile_overlap,
        "vae_load_seconds": load_seconds,
        "vae_model_gib": vae.model_size() / GIB,
        "vae_dtype": str(vae.vae_dtype),
        "vae_decode_seconds": decode_seconds,
        "peak_vram_gib": torch.cuda.max_memory_reserved() / GIB,
        "finite": bool(torch.isfinite(images).all().item()),
    }
    print(json.dumps(result, sort_keys=True))
    del images, latent, vae, models
    gc.collect()
    model_management.unload_all_models()
    model_management.soft_empty_cache(force=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
