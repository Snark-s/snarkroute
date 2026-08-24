from __future__ import annotations

from pathlib import Path

import pytest

from app.errors import WorkerError
from app.registry import ModelRegistry


def test_registry_has_pinned_licensed_models_and_no_download_side_effect(tmp_path: Path):
    registry = ModelRegistry.load()
    models = registry.list()
    curated = {
        "4x-purephoto-span",
        "4x-nomoswebphoto-realplksr",
        "4x-ultrasharp-v2-dat2-onnx",
        "4x-lexica-hat",
        "4x-hfa2k-ludvae-grl-small",
        "4x-hfa2k-ludvae-swinir-light",
        "4x-realwebphoto-v2-rgt-s",
    }
    assert curated <= {model.id for model in models}
    assert len({model.architecture for model in models if model.id in curated}) == len(curated)
    assert {model.runtime for model in models} <= {"onnxruntime", "pytorch"}
    assert all(
        (model.runtime, model.file_format) in {("onnxruntime", "onnx"), ("pytorch", "pth")}
        for model in models
    )
    assert all(len(model.resource.sha256) == 64 for model in models)
    assert all(model.license and model.license.lower() != "unknown" for model in models)
    curated_tags = {tag for model in models if model.id in curated for tag in model.tags}
    assert {"photo", "ai-generated", "video-frame", "graphics", "text", "restoration"} <= curated_tags
    assert not list(tmp_path.iterdir())


def test_invalid_model_id_is_structured():
    with pytest.raises(WorkerError) as raised:
        ModelRegistry.load().get("not-a-model")
    assert raised.value.code == "invalid_model_id"
    assert raised.value.retryable is False
