from pathlib import Path

from app.video_pipeline import VideoProbe, _start_encoder


def test_audio_copy_does_not_truncate_video_with_shortest(monkeypatch, tmp_path: Path):
    captured: list[str] = []

    class Process:
        pass

    def fake_popen(command, **_kwargs):
        captured.extend(command)
        return Process()

    monkeypatch.setattr("app.video_pipeline.subprocess.Popen", fake_popen)
    monkeypatch.setattr("app.video_pipeline.ffmpeg_executable", lambda: "ffmpeg")
    probe = VideoProbe(320, 180, 6.0, 6, 1.0, "h264", "yuv420p", True, "aac", 0)

    _start_encoder(tmp_path / "output.mp4", tmp_path / "input.mp4", probe, 4, 18, "copy")

    assert "-shortest" not in captured
    assert captured[captured.index("-map") + 1] == "0:v:0"
    assert "1:a:0?" in captured
