"""The experimental entrypoint must not silently alter ordinary H3 jobs."""
from types import SimpleNamespace

import pytest

from app.backends.matlow_runtime import MatlowRuntime
from app.config import Settings
from app.models import GenerateRequest


def request(**changes):
    return GenerateRequest(prompt="A steady daylight scene", target={"duration_seconds": 5}, **changes)


def test_experiment_is_explicit_and_serialized(monkeypatch, tmp_path):
    runtime = MatlowRuntime(Settings.from_env())
    calls = []
    monkeypatch.setattr(runtime, "_generate_locked", lambda *args, **kwargs: calls.append((args, kwargs)) or {})
    runtime.generate(request(), tmp_path / "ordinary.mp4", 0)
    assert calls[0][1] == {}
    runtime.sample_latent_segment(request(), tmp_path, width=256, height=256)
    assert calls[1][1]["experiment"]["capture_directory"] == tmp_path
    assert calls[1][1]["experiment"]["width"] == 256


@pytest.mark.parametrize("changes", [{"vae_mode": "x2"}, {"output_mode": "still"}])
def test_experiment_rejects_unsupported_decoders(changes, tmp_path):
    runtime = MatlowRuntime(Settings.from_env())
    with pytest.raises(ValueError, match="stock video"):
        runtime.sample_latent_segment(request(**changes), tmp_path)


def test_experiment_rejects_mixed_image_and_latent_context(tmp_path):
    runtime = MatlowRuntime(Settings.from_env())
    image = tmp_path / "first.png"
    req = request(task="fl2va", conditions=[{"type": "image", "role": "keyframe", "frame_index": 0,
                                            "uri": image.as_uri()}])
    with pytest.raises(ValueError, match="image"):
        runtime.sample_latent_segment(req, tmp_path, previous_archive=tmp_path / "latent.safetensors")


def test_decode_guard_checks_native_temporal_boundary_handling():
    from app.backends.h3_latent_decode import validate_native_decoder
    supported = SimpleNamespace(tokens_chunk_size=5, token_overlap=2, frame_pre_padding=3, frame_overlap=5,
                                decode_temporal=lambda *_: None, tiling=True)
    validate_native_decoder(supported)
    supported.token_overlap = 0
    with pytest.raises(RuntimeError, match="temporal"):
        validate_native_decoder(supported)


def test_sample_geometry_rejects_phase_and_audio_rounding():
    from app.backends.matlow_runtime import _validate_experiment_geometry
    _validate_experiment_geometry(256, 256, 124, 22)
    with pytest.raises(ValueError, match="17k"):
        _validate_experiment_geometry(256, 256, 120, 22)
    with pytest.raises(ValueError, match="audio"):
        _validate_experiment_geometry(256, 256, 107, 22)
