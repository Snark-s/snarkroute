from types import SimpleNamespace

import pytest

from app.backends.matlow_runtime import _reference_inputs
from app.models import GenerateRequest


@pytest.mark.parametrize("start", [-1, float("nan"), float("inf")])
def test_video_reference_rejects_invalid_start_before_decoding(tmp_path, start):
    pytest.importorskip("numpy")
    from app.backends.matlow_runtime import _load_reference_video
    with pytest.raises(ValueError, match="finite and non-negative"):
        _load_reference_video(tmp_path / "video.mp4", None, start)


@pytest.mark.parametrize("frames", [4, 5])
def test_video_reference_decoding_is_bounded_and_checks_short_inputs(monkeypatch, tmp_path, frames):
    pytest.importorskip("numpy")
    from app.backends.matlow_runtime import _load_reference_video
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command[0] == "ffprobe":
            return SimpleNamespace(stdout=b'{"streams":[{"width":1920,"height":1080}]}')
        return SimpleNamespace(stdout=bytes(512 * 288 * 3 * frames))
    monkeypatch.setattr("app.backends.matlow_runtime.subprocess.run", run)
    if frames == 4:
        with pytest.raises(ValueError, match="at least 5"):
            _load_reference_video(tmp_path / "video.mp4", None)
    else:
        array = _load_reference_video(tmp_path / "video.mp4", SimpleNamespace(from_numpy=lambda x: x))
        assert array.shape == (5, 288, 512, 3)
    command, options = calls[1]
    assert command[command.index("-frames:v") + 1] == "360"
    assert command[command.index("-t") + 1] == "15"
    assert options["timeout"] == 120


def test_reference_inputs_keep_image_and_video_order(monkeypatch, tmp_path):
    image = tmp_path / "image.png"
    video = tmp_path / "video.mp4"
    image.write_bytes(b"image")
    video.write_bytes(b"video")
    monkeypatch.setattr("app.backends.matlow_runtime._load_image", lambda *_: "image tensor")
    monkeypatch.setattr("app.backends.matlow_runtime._load_reference_video", lambda *args: ("video tensor", args[-2], args[-1]))
    refs, size = _reference_inputs([
        {"type": "video", "uri": video.as_uri(), "start_time_seconds": 2, "visual_mode": "motion"},
        {"type": "image", "uri": image.as_uri()},
    ], None)
    assert refs == {"ref_images": {"ref_image_1": "image tensor"}, "ref_videos": {"ref_video_1": ("video tensor", 2, "motion")}}
    assert size == 10


def test_motion_video_reference_strips_appearance_and_reduces_resolution(monkeypatch, tmp_path):
    pytest.importorskip("numpy")
    from app.backends.matlow_runtime import _load_reference_video
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command[0] == "ffprobe":
            return SimpleNamespace(stdout=b'{"streams":[{"width":1920,"height":1080}]}')
        return SimpleNamespace(stdout=bytes(192 * 96 * 3 * 5))
    monkeypatch.setattr("app.backends.matlow_runtime.subprocess.run", run)

    array = _load_reference_video(tmp_path / "video.mp4", SimpleNamespace(from_numpy=lambda x: x), visual_mode="motion")

    assert array.shape == (5, 96, 192, 3)
    command = calls[1][0]
    video_filter = command[command.index("-vf") + 1]
    assert video_filter == "fps=24,scale=192:96:flags=area,format=gray,gblur=sigma=2"


def test_reference_audio_is_rejected_explicitly():
    with pytest.raises(ValueError, match="image and video"):
        _reference_inputs([{"type": "audio", "uri": "file:///tmp/audio.wav"}], None)


@pytest.mark.asyncio
@pytest.mark.parametrize("task,conditions", [
    ("ref2va", [{"type": "image", "uri": "file:///tmp/image.png"}]),
    ("ref2va", [{"type": "video", "uri": "file:///tmp/video.mp4"}]),
    ("fl2va", [{"type": "image", "role": "keyframe", "frame_index": -1, "uri": "file:///tmp/image.png"}]),
])
async def test_visual_references_and_verified_last_frame_reach_runtime(monkeypatch, tmp_path, task, conditions):
    from app.backends.matlow_int8 import MatlowInt8Backend
    from app.config import Settings
    seen = []
    def generate(request, output, *_args):
        seen.append(request.task)
        output.write_bytes(b"mp4")
        return {"render_time_seconds": 1}
    backend = MatlowInt8Backend(Settings.from_env(), runtime_factory=lambda _: SimpleNamespace(
        probe=lambda: {"ready": True}, generate=generate,
    ))
    monkeypatch.setattr(backend, "_configuration_error", lambda: None)
    async def progress(*_): pass
    request = GenerateRequest.model_validate({"task": task, "prompt": "test", "conditions": conditions,
        "target": {"duration_seconds": 5}, "quality_mode": "preview", "num_inference_steps": 4})
    output = await backend.execute(request, tmp_path, progress)
    assert seen == [task]
    assert output[0].metadata.variant == ("ref2va" if task == "ref2va" else "fl2va")
