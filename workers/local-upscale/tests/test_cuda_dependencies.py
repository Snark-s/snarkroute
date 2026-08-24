from __future__ import annotations

import tomllib
from pathlib import Path


def test_gpu_extra_is_pinned_to_matching_pytorch_cuda_wheels() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    gpu = project["project"]["optional-dependencies"]["gpu"]
    sources = project["tool"]["uv"]["sources"]
    indexes = {entry["name"]: entry for entry in project["tool"]["uv"]["index"]}

    assert "torch==2.7.1" in gpu
    assert "torchvision==0.22.1" in gpu
    assert sources["torch"] == [{"index": "pytorch-cu128", "extra": "gpu"}]
    assert sources["torchvision"] == [{"index": "pytorch-cu128", "extra": "gpu"}]
    assert indexes["pytorch-cu128"] == {
        "name": "pytorch-cu128",
        "url": "https://download.pytorch.org/whl/cu128",
        "explicit": True,
    }

    lock = (root / "uv.lock").read_text(encoding="utf-8")
    assert 'name = "torch"\nversion = "2.7.1+cu128"' in lock
    assert 'name = "torchvision"\nversion = "0.22.1+cu128"' in lock
    assert 'source = { registry = "https://download.pytorch.org/whl/cu128" }' in lock
