import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.backends.base import CapabilityUnavailable
from app.backends.matlow_int8 import MatlowInt8Backend
from app.backends.matlow_runtime import MatlowRuntime, _dimensions, _frame_count
from app.config import Settings
from app.models import GenerateRequest


def configured_settings(monkeypatch, tmp_path: Path) -> Settings:
    comfyui = tmp_path / "ComfyUI"
    comfyui.mkdir()
    files = {
        "H3_MATLOW_TRANSFORMER_FILE": tmp_path / "transformer.safetensors",
        "H3_MATLOW_TEXT_ENCODER_FILE": tmp_path / "encoder.safetensors",
        "H3_MATLOW_VIDEO_VAE_FILE": tmp_path / "video-vae.safetensors",
        "H3_MATLOW_AUDIO_VAE_FILE": tmp_path / "audio-vae.safetensors",
    }
    for path in files.values():
        path.write_bytes(b"fixture")
    monkeypatch.setenv("H3_BACKEND", "matlow_int8")
    monkeypatch.setenv("H3_MATLOW_COMFYUI_DIR", str(comfyui))
    for name, path in files.items():
        monkeypatch.setenv(name, str(path))
    return Settings.from_env()


class ReadyRuntime:
    def probe(self):
        return {
            "ready": True,
            "gpu": "RTX 3080 Laptop",
            "vram_gib": 16.0,
            "kernel": "comfy_kitchen.int8_linear.cuda",
        }


class UnavailableCudaRuntime:
    def probe(self):
        return {"ready": False, "reason": "CUDA is unavailable"}


def test_matlow_capabilities_are_mvp_scoped(monkeypatch, tmp_path):
    backend = MatlowInt8Backend(
        configured_settings(monkeypatch, tmp_path), runtime_factory=lambda _settings: ReadyRuntime()
    )
    capabilities = {item.name: item for item in backend.capabilities()}

    assert capabilities["fl2va"].available is True
    assert capabilities["preview"].available is True
    assert capabilities["kitchen_int8"].available is True
    assert capabilities["ref2va"].available is True
    assert capabilities["final"].available is False


def test_matlow_native_audio_is_enabled_by_default_and_can_be_disabled(monkeypatch):
    monkeypatch.delenv("H3_MATLOW_NATIVE_AUDIO", raising=False)
    assert Settings.from_env().matlow_native_audio is True

    monkeypatch.setenv("H3_MATLOW_NATIVE_AUDIO", "0")
    assert Settings.from_env().matlow_native_audio is False


def test_matlow_native_audio_is_enabled_by_default_and_can_be_disabled(monkeypatch):
    monkeypatch.delenv("H3_MATLOW_NATIVE_AUDIO", raising=False)
    assert Settings.from_env().matlow_native_audio is True

    monkeypatch.setenv("H3_MATLOW_NATIVE_AUDIO", "0")
    assert Settings.from_env().matlow_native_audio is False


@pytest.mark.asyncio
async def test_matlow_ready_fails_for_missing_model_file(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    settings.matlow_transformer_file.unlink()
    backend = MatlowInt8Backend(settings, runtime_factory=lambda _settings: ReadyRuntime())

    ready, reason = await backend.ready()

    assert ready is False
    assert reason and "transformer" in reason


@pytest.mark.asyncio
async def test_matlow_ready_fails_closed_when_cuda_is_unavailable(monkeypatch, tmp_path):
    backend = MatlowInt8Backend(
        configured_settings(monkeypatch, tmp_path),
        runtime_factory=lambda _settings: UnavailableCudaRuntime(),
    )

    ready, reason = await backend.ready()

    assert ready is False
    assert reason == "CUDA is unavailable"


@pytest.mark.asyncio
async def test_matlow_rejects_unverified_quality_mode(monkeypatch, tmp_path):
    backend = MatlowInt8Backend(
        configured_settings(monkeypatch, tmp_path), runtime_factory=lambda _settings: ReadyRuntime()
    )
    request = GenerateRequest.model_validate(
        {
            "task": "t2va",
            "prompt": "test",
            "target": {"duration_seconds": 5},
            "quality_mode": "final",
        }
    )

    async def progress(_value: float, _stage: str) -> None:
        return None

    with pytest.raises(CapabilityUnavailable, match="local_fast"):
        await backend.execute(request, tmp_path / "work", progress)


def test_matlow_profile_is_fail_closed(monkeypatch):
    monkeypatch.setenv("H3_MATLOW_PROFILE", "automatic")
    with pytest.raises(RuntimeError, match="H3_MATLOW_PROFILE"):
        Settings.from_env()


def test_local_fast_geometry_is_pinned():
    assert _dimensions("16:9") == (960, 544)
    assert _dimensions("9:16") == (544, 960)
    assert _frame_count(5) == 124


def test_local_fast_vae_tile_defaults_are_bounded(monkeypatch):
    monkeypatch.delenv("H3_MATLOW_VAE_TILE_SIZE", raising=False)
    monkeypatch.delenv("H3_MATLOW_VAE_TILE_OVERLAP", raising=False)
    settings = Settings.from_env()

    assert settings.matlow_vae_tile_size == 256
    assert settings.matlow_vae_tile_overlap == 64
    assert settings.matlow_vram_headroom_gib == 2
    assert settings.matlow_memory_mode == "dynamic"


def test_matlow_rejects_invalid_vae_tile_geometry(monkeypatch):
    monkeypatch.setenv("H3_MATLOW_VAE_TILE_SIZE", "64")
    monkeypatch.setenv("H3_MATLOW_VAE_TILE_OVERLAP", "64")

    with pytest.raises(RuntimeError, match="smaller than"):
        Settings.from_env()


@pytest.mark.asyncio
async def test_matlow_rejects_unverified_audio_reference(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    backend = MatlowInt8Backend(settings, runtime_factory=lambda _settings: object())
    request = GenerateRequest.model_validate(
        {
            "task": "ref2va",
            "prompt": "end on this frame",
            "conditions": [
                {
                    "type": "audio",
                    "role": "reference",
                    "uri": "file:///tmp/reference.wav",
                }
            ],
            "target": {"duration_seconds": 5, "aspect_ratio": "16:9"},
            "quality_mode": "preview",
        }
    )

    async def progress(_value, _stage):
        return None

    with pytest.raises(CapabilityUnavailable, match="audio references"):
        await backend.execute(request, tmp_path / "work", progress)


def test_matlow_probe_initializes_runtime_only_once_under_concurrency(monkeypatch):
    runtime = MatlowRuntime(Settings.from_env())
    calls = 0

    def fake_probe_locked():
        nonlocal calls
        calls += 1
        time.sleep(0.05)
        runtime._probe_status = {"ready": True}
        return runtime._probe_status

    monkeypatch.setattr(runtime, "_probe_locked", fake_probe_locked)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _index: runtime.probe(), range(8)))

    assert calls == 1
    assert all(result == {"ready": True} for result in results)
