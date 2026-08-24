from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.errors import WorkerError
from app.runtime import OnnxRuntime


def test_onnx_cuda_requires_available_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    fake_ort = SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)

    with pytest.raises(WorkerError) as raised:
        OnnxRuntime(tmp_path / "model.onnx", "cuda")

    assert raised.value.code == "runtime_unavailable"
    assert "CUDAExecutionProvider is not available" in raised.value.message


def test_onnx_cuda_rejects_silent_cpu_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    preload_calls: list[bool] = []
    session = SimpleNamespace(
        get_providers=lambda: ["CPUExecutionProvider"],
        get_inputs=lambda: [SimpleNamespace(name="input")],
    )
    fake_ort = SimpleNamespace(
        get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
        InferenceSession=lambda *_args, **_kwargs: session,
        preload_dlls=lambda: preload_calls.append(True),
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)

    with pytest.raises(WorkerError) as raised:
        OnnxRuntime(tmp_path / "model.onnx", "cuda")

    assert raised.value.code == "runtime_unavailable"
    assert "silently fell back" in raised.value.message
    assert preload_calls == [True]
