from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        service_token="test-token",
        runtime_override="mock",
        model_dir=tmp_path / "models",
        data_dir=tmp_path / "data",
        job_timeout_seconds=5,
        max_upload_bytes=1024 * 1024,
        max_input_pixels=1024 * 1024,
    )
