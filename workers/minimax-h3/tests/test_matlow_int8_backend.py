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
    monkeypatch.setenv("H3_MATLOW_10EROS_MAX_FILE", str(tmp_path / "10eros-max.safetensors"))
    monkeypatch.setenv("H3_MATLOW_10EROS_MAX_TURBO_FILE", str(tmp_path / "10eros-max-turbo.safetensors"))
    monkeypatch.setenv("H3_MATLOW_FACESWAP_LORA_FILE", str(tmp_path / "faceswap.safetensors"))
    monkeypatch.setenv("H3_MATLOW_AUTHENTIC_CINEMATIC_LORA_FILE", str(tmp_path / "authentic-cinematic.safetensors"))
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
    assert capabilities["resample"].available is False
    assert "No compatible local H3 regeneration backend" in capabilities["resample"].reason
    assert capabilities["visual_lora"].available is False


@pytest.mark.asyncio
async def test_resample_is_rejected_before_runtime_or_model_loading(monkeypatch, tmp_path):
    def forbidden_runtime(_settings):
        pytest.fail("Unavailable regeneration must never construct a model runtime")

    backend = MatlowInt8Backend(
        configured_settings(monkeypatch, tmp_path), runtime_factory=forbidden_runtime
    )
    request = GenerateRequest(
        operation="video.resample.h3",
        task="resample",
        resample={
            "source_video": {"uri": "file:///data/MAX-I1/output.mp4"},
            "prompt": "Original context",
            "target_resolution": "2k",
        },
    )
    with pytest.raises(CapabilityUnavailable) as failure:
        await backend.execute(request, tmp_path, lambda *_args: None)
    assert failure.value.capability == "resample"
    assert backend._runtime_instance is None


def test_visual_lora_capability_is_separate_from_picture_style_transfer(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    settings.matlow_authentic_cinematic_lora_file.write_bytes(b"fixture")
    backend = MatlowInt8Backend(settings, runtime_factory=lambda _settings: ReadyRuntime())
    capabilities = {item.name: item for item in backend.capabilities()}
    assert capabilities["visual_lora"].available is True
    assert "Limited" in capabilities["visual_lora"].reason
    assert capabilities["style_transfer"].available is False


def test_ref2va_capability_status_is_honest_and_faceswap_is_a_modifier(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    settings.matlow_faceswap_lora_file.write_bytes(b"fixture")
    backend = MatlowInt8Backend(settings, runtime_factory=lambda _settings: ReadyRuntime())
    capabilities = {item.name: item for item in backend.capabilities()}

    assert capabilities["ref2va"].available is True
    assert "GPU-verified" in (capabilities["ref2va"].reason or "")
    assert capabilities["style_transfer"].available is False
    assert "did not transfer" in (capabilities["style_transfer"].reason or "")
    assert capabilities["identity_transfer"].available is True
    assert "profile consistency is limited" in (capabilities["identity_transfer"].reason or "")


def test_faceswap_patch_is_per_call_and_runtime_keeps_no_lora_state(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    runtime = MatlowRuntime(settings)
    base_model = object()
    patched_model = object()
    seen = []
    runtime._modules = {
        "comfy": type("Comfy", (), {
            "utils": type("Utils", (), {"load_torch_file": staticmethod(lambda path: {"path": path})}),
            "sd": type("SD", (), {"load_lora_for_models": staticmethod(
                lambda model, clip, state, model_strength, clip_strength:
                (seen.append((model, clip, state, model_strength, clip_strength)) or (patched_model, None))
            )}),
        }),
    }

    result, metadata = runtime._apply_lora(
        base_model, settings.matlow_faceswap_lora_file, 1.0, {"kind": "identity_transfer"}
    )

    assert result is patched_model
    assert seen == [(base_model, None, {"path": str(settings.matlow_faceswap_lora_file)}, 1.0, 0.0)]
    assert metadata == {"enabled": True, "strength": 1.0, "kind": "identity_transfer"}
    assert runtime._models is None


def test_visual_modifier_patch_is_per_call_and_runtime_keeps_no_lora_state(monkeypatch, tmp_path):
    settings = configured_settings(monkeypatch, tmp_path)
    runtime = MatlowRuntime(settings)
    base_model = object()
    patched_model = object()
    seen = []
    runtime._modules = {
        "comfy": type("Comfy", (), {
            "utils": type("Utils", (), {"load_torch_file": staticmethod(lambda path: {"path": path})}),
            "sd": type("SD", (), {"load_lora_for_models": staticmethod(
                lambda model, clip, state, model_strength, clip_strength:
                (seen.append((model, clip, state, model_strength, clip_strength)) or (patched_model, None))
            )}),
        }),
    }

    result, metadata = runtime._apply_lora(
        base_model, settings.matlow_authentic_cinematic_lora_file, 0.7,
        {"kind": "visual_modifier", "id": "authentic_cinematic_texture"},
    )

    assert result is patched_model
    assert seen == [(base_model, None, {"path": str(settings.matlow_authentic_cinematic_lora_file)}, 0.7, 0.0)]
    assert metadata == {"enabled": True, "strength": 0.7, "kind": "visual_modifier", "id": "authentic_cinematic_texture"}
    assert runtime._models is None


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
