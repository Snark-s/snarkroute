from __future__ import annotations

from pathlib import Path

import pytest

from app.errors import WorkerError
from app.registry import ModelRegistry


def test_registry_has_pinned_licensed_models_and_no_download_side_effect(tmp_path: Path):
    registry = ModelRegistry.load()
    models = registry.list()
    assert 2 <= len(models) <= 6
    assert {model.runtime for model in models} <= {"onnxruntime", "pytorch"}
    assert all(len(model.resource.sha256) == 64 for model in models)
    assert all(model.license and model.license.lower() != "unknown" for model in models)
    assert not list(tmp_path.iterdir())


def test_invalid_model_id_is_structured():
    with pytest.raises(WorkerError) as raised:
        ModelRegistry.load().get("not-a-model")
    assert raised.value.code == "invalid_model_id"
    assert raised.value.retryable is False
