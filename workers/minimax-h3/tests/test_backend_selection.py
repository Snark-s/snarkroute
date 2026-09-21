from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.backends.base import CapabilityUnavailable
from app.backends.diffusers import DiffusersBackend
from app.backends.factory import create_backend
from app.backends.matlow_int8 import MatlowInt8Backend
from app.backends.mock import MockBackend
from app.backends.sglang import SGLangBackend, build_sglang_payload
from app.backends.vdn import VDNBackend
from app.config import Settings
from app.models import GenerateRequest


@pytest.mark.parametrize(
    ("name", "backend_type"),
    [
        ("mock", MockBackend),
        ("sglang", SGLangBackend),
        ("diffusers", DiffusersBackend),
        ("matlow_int8", MatlowInt8Backend),
        ("vdn", VDNBackend),
    ],
)
def test_factory_selects_configured_backend(monkeypatch, name, backend_type):
    monkeypatch.setenv("H3_BACKEND", name)
    assert isinstance(create_backend(Settings.from_env()), backend_type)


def test_factory_never_silently_falls_back_to_mock(monkeypatch):
    monkeypatch.setenv("H3_BACKEND", "mock")
    settings = replace(Settings.from_env(), backend="unknown")
    with pytest.raises(RuntimeError, match="Unsupported H3 backend"):
        create_backend(settings)


def test_settings_accepts_vdn_matlow_and_rejects_unknown(monkeypatch):
    monkeypatch.setenv("H3_BACKEND", "vdn")
    assert Settings.from_env().backend == "vdn"
    monkeypatch.setenv("H3_BACKEND", "matlow_int8")
    assert Settings.from_env().backend == "matlow_int8"
    monkeypatch.setenv("H3_BACKEND", "automatic")
    with pytest.raises(RuntimeError, match="H3_BACKEND"):
        Settings.from_env()


def test_worker_exposes_selected_vdn_scaffold(monkeypatch, tmp_path):
    from app.main import create_app

    monkeypatch.setenv("H3_BACKEND", "vdn")
    monkeypatch.setenv("H3_WORKER_SERVICE_TOKEN", "test-service-token-that-is-not-secret")
    monkeypatch.setenv("H3_RESULT_DIR", str(tmp_path / "results"))
    monkeypatch.setenv("H3_TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("H3_MODEL_DIR", str(tmp_path / "models"))
    headers = {"Authorization": "Bearer test-service-token-that-is-not-secret"}

    with TestClient(create_app(Settings.from_env())) as client:
        ready = client.get("/ready", headers=headers)
        capabilities = client.get("/v1/capabilities", headers=headers)

    assert ready.status_code == 503
    assert ready.json()["backend"] == "vdn"
    assert ready.json()["backendVersion"] == "scaffold"
    assert capabilities.status_code == 200
    assert capabilities.json()["backend"] == "vdn"
    assert all(not item["available"] for item in capabilities.json()["capabilities"])


@pytest.mark.asyncio
async def test_vdn_scaffold_fails_closed(tmp_path):
    backend = VDNBackend()
    ready, reason = await backend.ready()
    assert ready is False
    assert reason and "external OpenVDN deployment" in reason
    assert all(not capability.available for capability in backend.capabilities())

    request = GenerateRequest.model_validate(
        {
            "task": "t2va",
            "prompt": "test",
            "target": {"duration_seconds": 4},
        }
    )

    async def progress(_value: float, _stage: str) -> None:
        return None

    with pytest.raises(CapabilityUnavailable, match="VDN-H3 adapter scaffold"):
        await backend.execute(request, tmp_path, progress)


@pytest.mark.parametrize(
    ("quality_mode", "turbo_lora", "steps"),
    [("final", False, 30), ("preview", False, 8), ("preview", True, 9)],
)
def test_sglang_payload_preserves_existing_defaults(quality_mode, turbo_lora, steps):
    request = GenerateRequest.model_validate(
        {
            "task": "fl2va",
            "prompt": "  keep this contract  ",
            "conditions": [
                {
                    "type": "image",
                    "role": "keyframe",
                    "frame_index": 0,
                    "uri": "file:///data/input.png",
                }
            ],
            "target": {"duration_seconds": 4},
            "seed": 17,
            "num_outputs_per_prompt": 2,
            "quality_mode": quality_mode,
            "quality": "lossless",
            "turbo_lora": turbo_lora,
            "lora_scale": 0.75,
        }
    )

    payload = build_sglang_payload(request)

    assert payload == {
        "model": "MiniMaxAI/MiniMax-H3",
        "task": "fl2va",
        "prompt": "keep this contract",
        "conditions": request.conditions,
        "target": {
            "short_edge": 768,
            "aspect_ratio": "auto",
            "duration_seconds": 4.0,
        },
        "seed": 17,
        "num_outputs_per_prompt": 2,
        "num_inference_steps": steps,
        "quality": "lossless",
        **({"lora_scale": 0.75} if turbo_lora else {}),
    }
