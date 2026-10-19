"""Unattended one-shot FLUX.3 native installation and smoke test on Windows.

Run as the local Windows owner using:
  Start-Process python -ArgumentList '"Y:\\Процесс\\SnarkRoute\\workers\\flux3-native\\overnight.py"' -WindowStyle Hidden

Keeps the computer awake while running, restores its normal power policy on exit,
writes progress and result to a JSON file. Never installs ComfyUI, edits the
SnarkBridge owner policy, sets model routing enabled, or restarts SnarkRoute.
"""
from __future__ import annotations

import ctypes
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import venv
from pathlib import Path

BASE = Path(__file__).resolve().parent
VENV = BASE / ".venv"
PYTHON = VENV / "Scripts" / "python.exe"
LOG = BASE / "overnight.log"
STATUS = BASE / "overnight-status.json"
SMOKE = BASE / "results" / "smoke-512.png"
ENV = os.environ.copy()
ENV["PYTHONUNBUFFERED"] = "1"
ENV["HF_HUB_CACHE"] = str(BASE / "hf-cache")
# Keep process background telemetry deterministic; no user tokens are logged.

def update(phase: str, **detail: object) -> None:
    data = {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "phase": phase, "detail": detail}
    temporary = STATUS.with_name(STATUS.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, STATUS)
    log("PHASE " + phase + (": " + json.dumps(detail, ensure_ascii=False) if detail else ""))

def log(msg: str) -> None:
    with LOG.open("a", encoding="utf-8") as fd:
        fd.write(dt.datetime.now(dt.timezone.utc).isoformat() + " " + msg + "\n")
        fd.flush()

def run(argv: list[str], *, input_data: str | None = None, timeout: int = 1800) -> None:
    safe_command = " ".join(argv[:3])
    log("RUN " + safe_command)
    started = time.monotonic()
    with LOG.open("a", encoding="utf-8") as output:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE if input_data else subprocess.DEVNULL,
                                stdout=output, stderr=subprocess.STDOUT,
                                cwd=str(BASE), env=ENV, text=True, encoding="utf-8")
        try:
            if input_data:
                proc.stdin.write(input_data)
                proc.stdin.close()
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise RuntimeError("Command timed out after %d seconds" % timeout) from None
    if code:
        raise RuntimeError("Command failed with exit code %d; see %s" % (code, LOG))
    log("DONE in %.1f sec" % (time.monotonic() - started))

def keep_awake() -> None:
    # Thread-local execution state, not a persistent powercfg change.
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)

def release_awake() -> None:
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)

def install() -> None:
    if sys.version_info < (3, 10) or sys.version_info >= (3, 14):
        raise RuntimeError("Use Python 3.10-3.13. Current: " + sys.version.split()[0])
    if not PYTHON.is_file():
        update("creating_venv")
        venv.create(str(VENV), with_pip=True)
    if not PYTHON.is_file():
        raise RuntimeError("Venv python was not created")
    update("installing_dependencies")
    run([str(PYTHON), "-m", "pip", "install", "--upgrade", "pip"], timeout=1200)
    run([str(PYTHON), "-m", "pip", "install", "--upgrade", "torch", "torchvision",
         "--index-url", "https://download.pytorch.org/whl/cu128"], timeout=3600)
    run([str(PYTHON), "-m", "pip", "install", "--upgrade",
         "git+https://github.com/huggingface/diffusers.git",
         "transformers", "accelerate", "huggingface_hub", "pillow",
         "safetensors", "sentencepiece", "protobuf"], timeout=3600)
    update("checking_native_worker")
    run([str(PYTHON), str(BASE / "infer.py"), "--check"], timeout=90)

def verify_model_access() -> None:
    update("checking_huggingface_access")
    # Access check uses the owner's saved local HF login, no tokens in arguments.
    # The original model is gated separately from the ComfyUI weights.
    source = ("from huggingface_hub import hf_hub_download; "
              "hf_hub_download(repo_id='black-forest-labs/flux-3-image-klein',"
              " filename='config.json'); print('FLUX3_HF_GATE_OK')")
    run([str(PYTHON), "-c", source], timeout=120)

def main() -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    # Neither logs nor cached model weights are overwritten.
    update("started", python=sys.version.split()[0], workspace=str(BASE))
    if os.name != "nt":
        raise RuntimeError("Unattended launcher is for Windows only")
    if not (BASE / "infer.py").is_file():
        raise RuntimeError("Native inference worker is missing")
    usage = shutil.disk_usage(BASE)
    if usage.free < 30 * 1024 ** 3:
        raise RuntimeError("Insufficient disk space: at least 30 GiB free recommended.")
    keep_awake()
    try:
        install()
        verify_model_access()
        # A single 512px smoke test. Do not enable the model in SnarkRoute
        # or restart existing services, even after success.
        update("rendering_512", output=str(SMOKE))
        SMOKE.parent.mkdir(parents=True, exist_ok=True)
        payload = {"prompt": "A small copper mechanical owl on a dark workbench, "
                  "finely engraved brass gears, soft studio lighting, detailed, "
                  "photorealistic, cinematic composition",
                  "width": 512, "height": 512, "steps": 16, "seed": 42,
                  "images": [], "output": str(SMOKE)}
        run([str(PYTHON), str(BASE / "infer.py")],
            input_data=json.dumps(payload), timeout=7200)
        if not SMOKE.is_file() or SMOKE.stat().st_size < 4096:
            raise RuntimeError("Inference returned without a valid output image")
        update("smoke_success", output=str(SMOKE),
               output_bytes=SMOKE.stat().st_size,
               snarkroute_activation="not performed")
    finally:
        release_awake()

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        update("blocked", error_type=type(exc).__name__, message=str(exc)[:300])
        log("ERROR " + traceback.format_exc(limit=3)[-1500:])
        raise SystemExit(1)
