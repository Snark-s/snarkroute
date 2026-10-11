#!/usr/bin/env python3
"""Isolated GPU acceptance: H3 X2 packed decode and Fizgig true still.

No generation/DiT. Fails loudly on decoder mismatch or OOM.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from app.backends.h3_experimental_stills import decode_still, decode_x2_video, x2_decoder_geometry
from app.backends.matlow_runtime import MatlowRuntime
from app.config import Settings


def run():
    runtime = MatlowRuntime(Settings.from_env())
    status = runtime.probe()
    if not status.get("ready"):
        raise RuntimeError(f"H3 CUDA runtime not ready: {status.get('reason')}")
    modules = runtime._imports()
    torch = modules["torch"]
    manager = modules["model_management"]
    results = {"gpu": status["gpu"], "cuda": status["cuda"]}
    for mode in ("x2", "stock"):
        try:
            models, load_s = runtime._load_models(vae_mode=mode)
            vae = models["video_vae"]
            shape = (1, vae.latent_channels, 2 if mode == "x2" else 1, 16, 16)
            latent = torch.zeros(shape, dtype=torch.float32)
            if mode == "x2":
                geometry = x2_decoder_geometry(vae.first_stage_model.decoder)
                if geometry != (12, 2):
                    raise AssertionError(f"Unexpected packed VAE geometry: {geometry}")
                frames = decode_x2_video(torch, manager, vae, {"samples": latent})
                if frames.shape[1:3] != (512, 512):
                    raise AssertionError(f"Unexpected X2 output: {frames.shape}")
            else:
                frames = decode_still(torch, manager, vae, {"samples": latent})
                if frames.shape[1:3] != (256, 256):
                    raise AssertionError(f"Unexpected Still output: {frames.shape}")
            if not bool(torch.isfinite(frames).all().item()):
                raise AssertionError(f"Nonfinite {mode} pixels")
            results[mode] = {
                "shape": list(frames.shape),
                "min": float(frames.amin().item()),
                "max": float(frames.amax().item()),
                "load_seconds": round(load_s, 2),
            }
            del frames, vae, models, latent
        finally:
            runtime.unload()
    print("H3_EXPERIMENT_GPU_PASS " + json.dumps(results, sort_keys=True), flush=True)


if __name__ == "__main__":
    run()
