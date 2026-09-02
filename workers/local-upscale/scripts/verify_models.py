from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.model_download import sha256_file  # noqa: E402

from app.registry import ModelRegistry  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify local upscale model weights")
    parser.add_argument("--model", help="One model id; verifies every registry model when omitted")
    parser.add_argument("--model-dir", type=Path, default=Path(os.getenv("LOCAL_UPSCALE_MODEL_DIR", "./models")))
    args = parser.parse_args()
    registry = ModelRegistry.load()
    models = [registry.get(args.model)] if args.model else registry.list()
    failures = 0
    for model in models:
        path = args.model_dir.resolve() / model.resource.filename
        if not path.is_file():
            print(f"missing {model.id}: {path}")
            failures += 1
            continue
        digest = sha256_file(path)
        if path.stat().st_size != model.resource.size_bytes or digest != model.resource.sha256:
            print(f"invalid {model.id}: size/checksum mismatch")
            failures += 1
        else:
            print(f"ok {model.id}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
