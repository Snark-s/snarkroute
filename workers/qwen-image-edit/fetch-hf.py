"""Fast parallel download of the big Qwen-Image-Edit files via huggingface_hub (+hf_xet).

curl pulls one stream (~1.5 MB/s here); hf_xet fetches chunks in parallel. Files land in
models/; download.ps1 then verifies SHA-256 against the source and skips what is complete.
Run with the FLUX.3 venv python (it has huggingface_hub and hf_xet).
"""
import json
import sys
import time
from pathlib import Path

from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
FILES = [
    ("unsloth/Qwen-Image-Edit-2511-GGUF", "qwen-image-edit-2511-Q4_K_M.gguf"),
    ("mradermacher/Qwen2.5-VL-7B-Instruct-GGUF", "Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf"),
]


def main() -> int:
    log = ROOT / "results" / "fetch-hf.log"
    for repo, name in FILES:
        started = time.time()
        with log.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"event": "start", "file": name}) + "\n")
        hf_hub_download(repo_id=repo, filename=name, local_dir=str(MODELS))
        with log.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"event": "done", "file": name, "seconds": round(time.time() - started)}) + "\n")
    (ROOT / "results" / "fetch-hf-done.txt").write_text("DONE", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        (ROOT / "results" / "fetch-hf-done.txt").write_text(f"FAIL {type(error).__name__}: {error}", encoding="utf-8")
        raise
