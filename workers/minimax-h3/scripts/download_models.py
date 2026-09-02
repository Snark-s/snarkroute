import argparse
import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download
from manifest import default_manifest, load_manifest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.model_download import disk_gate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download a pinned MiniMax H3 partition")
    parser.add_argument("--manifest", type=Path, default=default_manifest())
    parser.add_argument("--component", choices=("h3-base-fl2va", "h3-base-ref2va"), default="h3-base-fl2va")
    parser.add_argument("--model-dir", type=Path, default=Path(os.getenv("H3_MODEL_DIR", "/models")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--accept-license", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = load_manifest(args.manifest)
    component = next(item for item in manifest["components"] if item["id"] == args.component)
    expected = int(component["expected_bytes"])
    reserve = max(20 * 1024**3, expected // 10)
    gate = disk_gate(args.model_dir, expected, reserve)
    print(f"component={component['id']} revision={component['revision']}")
    print(
        f"expected_download_bytes={expected} required_free_bytes={gate.required_bytes} "
        f"available_free_bytes={gate.available_bytes}"
    )
    if args.dry_run:
        return 0 if gate.allowed else 2
    accepted = args.accept_license or os.getenv("H3_ACCEPT_MODEL_LICENSE") == "1"
    if not accepted:
        print(
            "error: review the pinned MiniMax H3 license and pass --accept-license or H3_ACCEPT_MODEL_LICENSE=1",
            file=sys.stderr,
        )
        return 3
    token = os.getenv("HF_TOKEN")
    if not token:
        print("error: HF_TOKEN must be supplied through the environment or secret manager", file=sys.stderr)
        return 4
    if not gate.allowed:
        print("error: insufficient free disk space", file=sys.stderr)
        return 2
    args.model_dir.mkdir(parents=True, exist_ok=True)
    try:
        snapshot_download(
            repo_id=component["repository"],
            revision=component["revision"],
            allow_patterns=component["allow_patterns"],
            local_dir=args.model_dir / component["path"],
            token=token,
            resume_download=True,
        )
    except Exception as exc:
        print(
            f"error: model download failed ({type(exc).__name__}); verify license access, revision, and disk",
            file=sys.stderr,
        )
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
