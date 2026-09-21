#!/usr/bin/env bash
set -Eeuo pipefail

MODEL_DIR="${H3_MODEL_DIR:-$HOME/h3/models/MiniMax-H3}"
REPOSITORY="MiniMaxAI/MiniMax-H3"
REVISION="42ed227ee7df40d41602854ae760620d6eb651fe"
MAX_WORKERS="${H3_DOWNLOAD_MAX_WORKERS:-4}"
MAX_ATTEMPTS="${H3_DOWNLOAD_MAX_ATTEMPTS:-5}"

if [[ -n "${H3_WAIT_PID:-}" ]]; then
  echo "waiting for existing download process ${H3_WAIT_PID}"
  while kill -0 "$H3_WAIT_PID" 2>/dev/null; do
    sleep 30
  done
fi

if [[ "${H3_ACCEPT_MODEL_LICENSE:-}" != "1" ]]; then
  echo "error: set H3_ACCEPT_MODEL_LICENSE=1 after reviewing the MiniMax H3 license" >&2
  exit 3
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "error: Hugging Face CLI (hf) is not installed" >&2
  exit 4
fi

if ! hf auth whoami >/dev/null 2>&1; then
  echo "error: Hugging Face authentication is not configured" >&2
  exit 5
fi

mkdir -p "$MODEL_DIR"

download_with_retry() {
  local attempt=1
  while (( attempt <= MAX_ATTEMPTS )); do
    echo "download attempt ${attempt}/${MAX_ATTEMPTS}: $*"
    if HF_XET_HIGH_PERFORMANCE=1 hf download "$REPOSITORY" "$@" \
      --revision "$REVISION" \
      --local-dir "$MODEL_DIR" \
      --max-workers "$MAX_WORKERS" \
      --quiet; then
      return 0
    fi
    if (( attempt == MAX_ATTEMPTS )); then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 30
  done
}

# FL2VA is downloaded in full. Ref2VA receives only its own index and
# transformer; the remaining components are byte-identical at this revision.
download_with_retry model_index.json FL2VA/
download_with_retry Ref2VA/model_index.json Ref2VA/transformer/

python3 - "$MODEL_DIR" <<'PY'
import filecmp
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
shared = ("audio_vae", "processor", "text_encoder", "tokenizer", "video_vae")

for component in shared:
    source_root = root / "FL2VA" / component
    target_root = root / "Ref2VA" / component
    if not source_root.is_dir():
        raise SystemExit(f"missing completed FL2VA component: {source_root}")
    target_root.mkdir(parents=True, exist_ok=True)
    for source in source_root.rglob("*"):
        relative = source.relative_to(source_root)
        target = target_root / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            source_stat = source.stat()
            target_stat = target.stat()
            if (source_stat.st_dev, source_stat.st_ino) == (target_stat.st_dev, target_stat.st_ino):
                continue
            if not filecmp.cmp(source, target, shallow=False):
                raise SystemExit(f"refusing to replace non-identical file: {target}")
            target.unlink()
        os.link(source, target)

print("shared FL2VA/Ref2VA components linked without duplicate storage")
PY

RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PARENT="$(dirname "$MODEL_DIR")"
if [[ "${H3_VERIFY_CHECKSUMS:-1}" == "1" ]]; then
  "$RUNTIME_ROOT/.venv/bin/python" "$RUNTIME_ROOT/scripts/verify_models.py" \
    --manifest "$RUNTIME_ROOT/model-manifest.yaml" \
    --component h3-base-fl2va \
    --model-dir "$MODEL_PARENT" \
    --checksums
  "$RUNTIME_ROOT/.venv/bin/python" "$RUNTIME_ROOT/scripts/verify_models.py" \
    --manifest "$RUNTIME_ROOT/model-manifest.yaml" \
    --component h3-base-ref2va \
    --model-dir "$MODEL_PARENT" \
    --checksums
fi

echo "MiniMax H3 FL2VA and Ref2VA snapshots are present at $MODEL_DIR"
