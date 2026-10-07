from __future__ import annotations

from pathlib import Path

import pytest

from app.backends.veda_attention import actual_attention_backend, apply_veda_attention, probe_veda_attention
from app.config import Settings
from app.models import GenerateRequest


def _settings(monkeypatch, tmp_path: Path, mode: str) -> Settings:
    monkeypatch.setenv("H3_MATLOW_ATTENTION", mode)
    monkeypatch.setenv(
        "H3_MATLOW_VEDA_PREDICTOR_FILE",
        str(tmp_path / "missing-veda-predictor.safetensors"),
    )
    return Settings.from_env()


def test_dense_mode_never_requires_predictor(monkeypatch, tmp_path):
    settings = _settings(monkeypatch, tmp_path, "dense")
    probe = probe_veda_attention(settings, object())
    model = object()
    patched, metadata = apply_veda_attention(model, settings, object())

    assert probe == {
        "mode": "dense",
        "active": False,
        "reason": "disabled by configuration",
    }
    assert patched is model
    assert metadata == probe


def test_per_job_dense_override_bypasses_global_auto(monkeypatch, tmp_path):
    settings = _settings(monkeypatch, tmp_path, "auto")
    model = object()

    patched, metadata = apply_veda_attention(model, settings, object(), "dense")

    assert patched is model
    assert metadata == {"mode": "dense", "active": False, "reason": "disabled by configuration"}


def test_worker_request_accepts_attention_mode():
    request = GenerateRequest.model_validate({
        "operation": "video.generate.h3",
        "task": "t2va",
        "prompt": "scene",
        "target": {"short_edge": 768, "aspect_ratio": "16:9", "duration_seconds": 5},
        "quality_mode": "preview",
        "num_inference_steps": 4,
        "attention_mode": "veda",
    })
    assert request.attention_mode == "veda"


def test_auto_mode_falls_back_when_predictor_is_missing(monkeypatch, tmp_path):
    settings = _settings(monkeypatch, tmp_path, "auto")

    probe = probe_veda_attention(settings, object())

    assert probe["mode"] == "auto"
    assert probe["active"] is False
    assert "predictor is missing" in probe["reason"]


def test_strict_veda_mode_fails_when_predictor_is_missing(monkeypatch, tmp_path):
    settings = _settings(monkeypatch, tmp_path, "veda")

    with pytest.raises(RuntimeError, match="predictor is missing"):
        probe_veda_attention(settings, object())


def test_invalid_attention_mode_is_rejected(monkeypatch):
    monkeypatch.setenv("H3_MATLOW_ATTENTION", "banana")

    with pytest.raises(RuntimeError, match="must be auto, veda, or dense"):
        Settings.from_env()


def test_attention_metadata_requires_real_sparse_calls():
    assert actual_attention_backend({"mode": "auto", "active": False}) == "dense"
    assert actual_attention_backend({"active": True, "backend": "triton-int8"}) == "veda-attached-unverified"
    assert actual_attention_backend({"active": True, "backend": "triton-int8", "diagnostics": {"completed": True, "sparse_calls": 0}}) == "dense:veda-fallback"
    assert actual_attention_backend({"active": True, "backend": "triton-int8", "diagnostics": {"completed": True, "sparse_calls": 200}}) == "veda:triton-int8"
    assert actual_attention_backend({"active": True, "backend": "triton-int8", "diagnostics": {"completed": True, "sparse_calls": 200, "fallback_reason": "kernel failure"}}) == "veda:triton-int8+fallback"
