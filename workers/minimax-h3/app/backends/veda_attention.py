from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

from ..config import Settings

_BUNDLE_LOCK = threading.Lock()
_BUNDLE_CACHE: dict[str, tuple[tuple[float, int], Any]] = {}


def _load_bundle(path: Path):
    from ..vendor.veda_sparse.core import bundle as veda_bundle

    stat = path.stat()
    stamp = (stat.st_mtime, stat.st_size)
    key = str(path)
    with _BUNDLE_LOCK:
        cached = _BUNDLE_CACHE.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        loaded = veda_bundle.load_bundle(key)
        _BUNDLE_CACHE.clear()
        _BUNDLE_CACHE[key] = (stamp, loaded)
        return loaded


def _check_model(model, bundle) -> tuple[int, int, int]:
    diffusion = model.get_model_object("diffusion_model")
    if type(diffusion).__name__ != "MiniMaxH3Model":
        raise RuntimeError(
            "Veda supports MiniMax-H3 only; "
            f"loaded diffusion model is {type(diffusion).__name__}"
        )
    attention = diffusion.blocks[0].attn
    shape = (len(diffusion.blocks), attention.heads, attention.head_dim)
    expected = (bundle.num_layers, bundle.num_heads, bundle.head_dim)
    if shape != expected:
        raise RuntimeError(
            f"Veda predictor expects {expected[0]} blocks x {expected[1]} heads x "
            f"{expected[2]}, but this H3 model is {shape[0]} x {shape[1]} x {shape[2]}"
        )
    return shape


def probe_veda_attention(settings: Settings, torch) -> dict[str, Any]:
    """Probe predictor + sparse kernel without loading the H3 transformer."""
    mode = settings.matlow_attention_mode
    if mode == "dense":
        return {"mode": "dense", "active": False, "reason": "disabled by configuration"}

    predictor_path = settings.matlow_veda_predictor_file
    if not predictor_path.is_file():
        reason = f"Veda predictor is missing: {predictor_path}"
        if mode == "veda":
            raise RuntimeError(reason)
        return {"mode": "auto", "active": False, "reason": reason}

    try:
        from ..vendor.veda_sparse import backends

        bundle = _load_bundle(predictor_path)
        device = torch.device("cuda", torch.cuda.current_device())
        resolution = backends.resolve(device)
        if resolution.backend is None:
            raise RuntimeError(f"no Veda sparse backend is usable on {device}: {resolution.report()}")
        return {
            "mode": mode,
            "active": True,
            "backend": resolution.backend.name,
            "backend_display": resolution.backend.display,
            "predictor": os.path.basename(bundle.path),
            "predictor_step": bundle.metadata.get("step"),
        }
    except Exception as exc:
        if mode == "veda":
            raise
        return {"mode": "auto", "active": False, "reason": f"{type(exc).__name__}: {exc}"}


def apply_veda_attention(model, settings: Settings, torch, mode_override: str | None = None) -> tuple[Any, dict[str, Any]]:
    """Apply Veda to a headless H3 ModelPatcher.

    auto: use Veda when predictor + Triton backend pass validation, otherwise dense.
    veda: fail closed when Veda cannot be enabled.
    dense: leave the model unchanged.
    """
    mode = mode_override or settings.matlow_attention_mode
    if mode not in {"auto", "veda", "dense"}:
        raise RuntimeError(f"Unsupported H3 attention mode: {mode}")
    if mode == "dense":
        return model, {"mode": "dense", "active": False, "reason": "disabled by configuration"}

    predictor_path = settings.matlow_veda_predictor_file
    if not predictor_path.is_file():
        reason = f"Veda predictor is missing: {predictor_path}"
        if mode == "veda":
            raise RuntimeError(reason)
        logging.warning("H3 Veda auto fallback: %s", reason)
        return model, {"mode": "auto", "active": False, "reason": reason}

    try:
        from ..vendor.veda_sparse import backends, comfy_patch
        from ..vendor.veda_sparse import settings as veda_settings

        bundle = _load_bundle(predictor_path)
        shape = _check_model(model, bundle)
        generated = veda_settings.parse_sparsity(
            settings.matlow_veda_generated_sparsity, "H3_MATLOW_VEDA_GENERATED_SPARSITY"
        )
        reference = veda_settings.parse_sparsity(
            settings.matlow_veda_reference_sparsity, "H3_MATLOW_VEDA_REFERENCE_SPARSITY"
        )
        veda_config = veda_settings.VedaSettings(
            generated=generated,
            reference=reference,
            verbose=settings.matlow_veda_verbose,
        )
        device = torch.device("cuda", torch.cuda.current_device())
        resolution = backends.resolve(device)
        if resolution.backend is None:
            reason = f"no Veda sparse backend is usable on {device}: {resolution.report()}"
            if mode == "veda":
                raise RuntimeError(reason)
            logging.warning("H3 Veda auto fallback: %s", reason)
            return model, {"mode": "auto", "active": False, "reason": reason}

        patched, patch = comfy_patch.apply(model, bundle, veda_config, None)
        metadata = {
            "mode": mode,
            "active": True,
            "backend": resolution.backend.name,
            "backend_display": resolution.backend.display,
            "predictor": os.path.basename(bundle.path),
            "predictor_step": bundle.metadata.get("step"),
            "model_shape": list(shape),
            "generated_sparsity": settings.matlow_veda_generated_sparsity,
            "reference_sparsity": settings.matlow_veda_reference_sparsity,
        }
        metadata["diagnostics"] = {"completed": False, "calls": {}}
        old_cleanup = patch.on_cleanup

        def tracked_cleanup() -> None:
            # The upstream patch resets per-run counters during cleanup. Record
            # them first so our result metadata reflects actual sparse calls.
            calls = dict(patch.run.calls)
            engines = [engine for engine in patch._engines.values() if engine is not None]
            fractions = [engine.stats.compute_fraction() for engine in engines]
            fractions = [value for value in fractions if value is not None]
            metadata["diagnostics"] = {
                "completed": True,
                "calls": calls,
                "sparse_calls": calls.get("sparse", 0),
                "fallback_reason": patch.run.failed,
                "attention_compute_fraction": (sum(fractions) / len(fractions)) if fractions else None,
            }
            old_cleanup()

        patch.on_cleanup = tracked_cleanup
        logging.info("H3 Veda enabled: %s", metadata)
        # Keep the patch object reachable for the life of the patched model.
        patched._snarkroute_veda_patch = patch
        return patched, metadata
    except Exception as exc:
        if mode == "veda":
            raise
        reason = f"{type(exc).__name__}: {exc}"
        logging.warning("H3 Veda auto fallback: %s", reason, exc_info=True)
        return model, {"mode": "auto", "active": False, "reason": reason}


def actual_attention_backend(metadata: dict[str, Any]) -> str:
    """Report measured sampling, not just successful hook installation."""
    if not metadata.get("active"):
        return "dense"
    diagnostics = metadata.get("diagnostics") or {}
    if not diagnostics.get("completed"):
        return "veda-attached-unverified"
    if diagnostics.get("sparse_calls", 0) <= 0:
        return "dense:veda-fallback"
    suffix = "+fallback" if diagnostics.get("fallback_reason") else ""
    return f"veda:{metadata['backend']}{suffix}"
