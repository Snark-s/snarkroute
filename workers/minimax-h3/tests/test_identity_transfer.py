import pytest
from pydantic import ValidationError

from app.config import Settings
from app.model_manager import DOWNLOADS, H3ModelManager
from app.models import GenerateRequest


def identity_payload():
    return {
        "operation": "video.generate.h3",
        "task": "ref2va",
        "prompt": "preserve the performance",
        "conditions": [
            {"type": "video", "uri": "file:///data/performance.mp4", "role": "reference"},
            {
                "type": "image",
                "uri": "file:///data/person.png",
                "role": "reference",
                "purpose": "identity",
            },
        ],
        "target": {"duration_seconds": 5},
        "quality_mode": "preview",
        "num_inference_steps": 4,
        "model_variant": "h3_base",
        "identity_transfer": {"enabled": True, "strength": 0.85},
    }


def test_identity_transfer_is_a_ref2va_modifier_with_trigger():
    request = GenerateRequest.model_validate(identity_payload())
    assert request.requested_capability == "identity_transfer"
    assert request.effective_prompt == "Faceswap, preserve the performance"
    assert request.identity_transfer and request.identity_transfer.strength == 0.85


@pytest.mark.parametrize("change", [
    {"model_variant": "10eros_max"},
    {"task": "fl2va"},
    {"conditions": [{"type": "video", "uri": "file:///data/performance.mp4"}]},
])
def test_identity_transfer_fails_closed_outside_base_ref2va(change):
    payload = identity_payload()
    payload.update(change)
    with pytest.raises(ValidationError):
        GenerateRequest.model_validate(payload)


def test_faceswap_artifact_is_pinned_and_routed(monkeypatch, tmp_path):
    monkeypatch.setenv("H3_MATLOW_MODEL_ROOT", str(tmp_path))
    settings = Settings.from_env()
    spec = DOWNLOADS["faceswap_ref2va"]
    assert spec.repository == "UntMods/FaceSwap_MiniMaxH3_REF2VA"
    assert spec.revision == "b2a5823ca64bc78d91725fbfcc576095bfceb764"
    assert spec.sha256 == "1e032cf519cc143f434e67516d8ad0aacf4c6e146315b2dcc3b1c2800470326d"
    assert H3ModelManager(settings).path("faceswap_ref2va") == settings.matlow_faceswap_lora_file


def test_authentic_cinematic_modifier_is_pinned_and_trigger_is_opt_in(monkeypatch, tmp_path):
    monkeypatch.setenv("H3_MATLOW_AUTHENTIC_CINEMATIC_LORA_FILE", str(tmp_path / "cinematic.safetensors"))
    settings = Settings.from_env()
    spec = DOWNLOADS["authentic_cinematic_texture"]
    assert spec.expected_bytes == 309_965_208
    assert spec.remote_filename == "minimax-h3-authentic-cinematic-texture/Minimax H3真实电影质感.safetensors"
    assert spec.sha256 == "51dda79218ea126cbb2e08f3a6d9cc595e2224f4977d7618061954043a8bafcf"
    assert H3ModelManager(settings).path("authentic_cinematic_texture") == settings.matlow_authentic_cinematic_lora_file

    base = {"task": "t2va", "prompt": "natural light", "target": {"duration_seconds": 5}}
    no_trigger = GenerateRequest.model_validate({**base, "visual_modifier": {"id": "authentic_cinematic_texture", "enabled": True, "strength": 0.7}})
    with_trigger = GenerateRequest.model_validate({**base, "visual_modifier": {"id": "authentic_cinematic_texture", "enabled": True, "strength": 0.5, "include_trigger": True}})
    assert no_trigger.effective_prompt == "natural light"
    assert with_trigger.effective_prompt == "DY, natural light"


def test_authentic_cinematic_modifier_rejects_non_base_and_faceswap_combination():
    base = {"task": "t2va", "prompt": "scene", "target": {"duration_seconds": 5}, "visual_modifier": {"id": "authentic_cinematic_texture", "enabled": True}}
    with pytest.raises(ValueError, match="requires h3_base"):
        GenerateRequest.model_validate({**base, "model_variant": "10eros_max_turbo"})
    with pytest.raises(ValueError, match="cannot be combined"):
        GenerateRequest.model_validate({**identity_payload(), "visual_modifier": base["visual_modifier"]})


def test_nested_visual_modifier_download_verifies_before_install(monkeypatch, tmp_path):
    import hashlib
    from dataclasses import replace
    import app.model_manager as module

    payload = b"safe fixture for hash verification"
    cached = tmp_path / "cached.safetensors"
    cached.write_bytes(payload)
    monkeypatch.setenv("H3_MATLOW_AUTHENTIC_CINEMATIC_LORA_FILE", str(tmp_path / "installed.safetensors"))
    spec = DOWNLOADS["authentic_cinematic_texture"]
    monkeypatch.setitem(DOWNLOADS, "authentic_cinematic_texture", replace(spec, expected_bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
    calls = []
    monkeypatch.setattr(module, "hf_hub_download", lambda **kwargs: (calls.append(kwargs) or cached))
    manager = H3ModelManager(Settings.from_env())
    manager._download("authentic_cinematic_texture")
    assert manager.path("authentic_cinematic_texture").read_bytes() == payload
    assert manager.status("authentic_cinematic_texture")["status"] == "installed"
    assert calls[0]["filename"] == spec.remote_filename

    manager.path("authentic_cinematic_texture").unlink()
    monkeypatch.setitem(DOWNLOADS, "authentic_cinematic_texture", replace(spec, expected_bytes=len(payload), sha256="0" * 64))
    manager._download("authentic_cinematic_texture")
    assert not manager.path("authentic_cinematic_texture").exists()
    assert "SHA-256 mismatch" in manager.status("authentic_cinematic_texture")["error"]
