import os
from pathlib import Path

import pytest

os.environ.setdefault("H3_WORKER_SERVICE_TOKEN", "test-service-token-that-is-not-secret")
os.environ.setdefault("H3_BACKEND", "mock")
os.environ.setdefault("H3_ENABLED_VARIANTS", "fl2va,ref2va")
os.environ.setdefault("H3_RESULT_DIR", str(Path.cwd() / ".pytest-global" / "results"))
os.environ.setdefault("H3_TEMP_DIR", str(Path.cwd() / ".pytest-global" / "tmp"))
os.environ.setdefault("H3_MODEL_DIR", str(Path.cwd() / ".pytest-global" / "models"))


@pytest.fixture
def configured_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("H3_WORKER_SERVICE_TOKEN", "test-service-token-that-is-not-secret")
    monkeypatch.setenv("H3_BACKEND", "mock")
    monkeypatch.setenv("H3_ENABLED_VARIANTS", "fl2va,ref2va")
    monkeypatch.setenv("H3_RESULT_DIR", str(tmp_path / "results"))
    monkeypatch.setenv("H3_TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("H3_MODEL_DIR", str(tmp_path / "models"))
    from app.config import Settings
    from app.main import create_app

    return create_app(Settings.from_env())


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-service-token-that-is-not-secret"}
