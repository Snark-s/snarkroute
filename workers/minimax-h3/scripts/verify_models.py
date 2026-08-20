import argparse
import hashlib
import os
from pathlib import Path

from huggingface_hub import HfApi
from manifest import default_manifest, load_manifest


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the pinned H3 snapshot without loading model code")
    parser.add_argument("--manifest", type=Path, default=default_manifest())
    parser.add_argument("--component", choices=("h3-base-fl2va", "h3-base-ref2va"), default="h3-base-fl2va")
    parser.add_argument("--model-dir", type=Path, default=Path(os.getenv("H3_MODEL_DIR", "/models")))
    parser.add_argument(
        "--checksums", action="store_true", help="hash all LFS files against the pinned Hub revision"
    )
    args = parser.parse_args()
    manifest = load_manifest(args.manifest)
    component = next(item for item in manifest["components"] if item["id"] == args.component)
    root = args.model_dir / component["path"]
    variant = "FL2VA" if component["variant"] == "FL2VA" else "Ref2VA"
    required = [root / "model_index.json", root / variant / "model_index.json"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        print("missing required files:", *missing, sep="\n  ")
        return 2
    total = sum(path.stat().st_size for path in (root / variant).rglob("*") if path.is_file())
    print(f"variant={variant} local_bytes={total} expected_bytes={component['expected_bytes']}")
    if total != int(component["expected_bytes"]):
        print("warning: byte total differs from manifest; run --checksums before use")
        if not args.checksums:
            return 3
    if args.checksums:
        info = HfApi().model_info(
            component["repository"], revision=component["revision"], files_metadata=True
        )
        failures = []
        for sibling in info.siblings:
            if not sibling.rfilename.startswith(f"{variant}/") or not sibling.lfs:
                continue
            local = root / sibling.rfilename
            if not local.is_file() or sha256(local) != sibling.lfs.sha256:
                failures.append(sibling.rfilename)
        if failures:
            print("checksum failures:", *failures, sep="\n  ")
            return 4
    print("model snapshot verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
