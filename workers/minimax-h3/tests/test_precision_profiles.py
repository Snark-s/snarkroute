import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from sglang_entrypoint import prepare_command  # noqa: E402

import benchmark  # noqa: E402


def test_kitchen_profile_injects_quantization_and_rejects_conflicts():
    command = prepare_command("kitchen_int8", ["--model-path", "/models/MiniMax-H3"])
    assert command[-2:] == ["--quantization", "kitchen_int8"]
    with pytest.raises(RuntimeError, match="conflicts"):
        prepare_command("kitchen_int8", ["--quantization", "fp8"])


def test_bf16_profile_cannot_silently_run_kitchen_int8():
    with pytest.raises(RuntimeError, match="requires"):
        prepare_command("bf16_offload", ["--quantization=kitchen_int8"])


def test_benchmark_records_explicit_profile_and_gpu_verification(tmp_path, monkeypatch):
    output = tmp_path / "benchmark.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "benchmark.py",
            "--case-id",
            "int8-smoke",
            "--system",
            "h3",
            "--profile",
            "kitchen_int8",
            "--render-seconds",
            "1",
            "--gpu-model",
            "RTX 4090",
            "--peak-vram-gib",
            "18",
            "--verified-on-gpu",
            "--output",
            str(output),
        ],
    )
    assert benchmark.main() == 0
    record = json.loads(output.read_text(encoding="utf-8"))[0]
    assert record["precision_profile"] == "kitchen_int8"
    assert record["verified_on_gpu"] is True


def test_settings_reject_unknown_precision_profile(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("H3_SGLANG_PRECISION_PROFILE", "automatic")
    with pytest.raises(RuntimeError, match="H3_SGLANG_PRECISION_PROFILE"):
        Settings.from_env()


def test_sglang_reports_kitchen_as_optional_configured_capability(monkeypatch):
    from app.backends.sglang import SGLangBackend
    from app.config import Settings

    monkeypatch.setenv("H3_BACKEND", "sglang")
    monkeypatch.setenv("H3_SGLANG_PRECISION_PROFILE", "kitchen_int8")
    capabilities = {item.name: item for item in SGLangBackend(Settings.from_env()).capabilities()}
    assert capabilities["kitchen_int8"].available is True
    assert capabilities["kitchen_int8"].experimental is True
