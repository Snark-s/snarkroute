import os
import subprocess
import sys
from pathlib import Path


def test_import_does_not_download_or_create_model_files(tmp_path: Path):
    worker = Path(__file__).resolve().parents[1]
    model_dir = tmp_path / "models"
    environment = {
        **os.environ,
        "H3_WORKER_SERVICE_TOKEN": "import-test-token",
        "H3_BACKEND": "mock",
        "H3_RESULT_DIR": str(tmp_path / "results"),
        "H3_TEMP_DIR": str(tmp_path / "tmp"),
        "H3_MODEL_DIR": str(model_dir),
    }
    subprocess.run([sys.executable, "-c", "import app.main"], cwd=worker, env=environment, check=True)
    assert not model_dir.exists()
