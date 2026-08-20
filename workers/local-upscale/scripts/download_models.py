from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.model_download import disk_gate, download_verified_file, sha256_file  # noqa: E402

from app.registry import ModelRegistry  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Explicitly download a pinned local upscale model")
    parser.add_argument("--model", required=True, help="Model id from model-registry.json")
    parser.add_argument("--model-dir", type=Path, default=Path(os.getenv("LOCAL_UPSCALE_MODEL_DIR", "./models")))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model = ModelRegistry.load().get(args.model)
    destination = args.model_dir.resolve() / model.resource.filename
    reserve = int(os.getenv("LOCAL_UPSCALE_DOWNLOAD_RESERVE_BYTES", str(1024 * 1024 * 1024)))
    gate = disk_gate(destination, model.resource.size_bytes, reserve)
    print(
        f"model={model.id} bytes={model.resource.size_bytes} required_free_bytes={gate.required_bytes} "
        f"available_free_bytes={gate.available_bytes}"
    )
    print(f"source={model.resource.url}")
    print(f"destination={destination}")
    if args.dry_run:
        return 0
    if not gate.allowed:
        print("error: insufficient free disk space", file=sys.stderr)
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == model.resource.sha256:
        print("already installed and checksum verified")
        return 0
    try:
        download_verified_file(
            url=model.resource.url,
            destination=destination,
            expected_bytes=model.resource.size_bytes,
            expected_sha256=model.resource.sha256,
            user_agent="SnarkRoute-local-upscale/0.1",
        )
        print("download complete; checksum verified")
        return 0
    except Exception as exc:
        print(f"error: model download failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 1
if __name__ == "__main__":
    raise SystemExit(main())
