#!/usr/bin/env python3
"""Loopback-only YuE2 service and Web UI for the installed YuE2 pipeline."""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
import signal
import subprocess
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from yue2 import SongResult, YuE2Pipeline


YUE_ROOT = Path(os.environ.get("YUE2_HOME", "/home/serge/YuE")).resolve()
OUTPUT_ROOT = YUE_ROOT / "outputs"
MODEL = os.environ.get("YUE2_MODEL", "m-a-p/YuE2-3B")
VAE = os.environ.get("YUE2_VAE", "m-a-p/YuE2-Vae")
STATIC = Path(__file__).with_name("index.html")


class GenerateRequest(BaseModel):
    style: str = Field(min_length=1, max_length=8000)
    lyrics: str = Field(min_length=1, max_length=32000)
    seed: int = Field(default=831001, ge=0, lt=2**63)
    cot: Literal["full", "melody", "off"] = "full"
    cfg_scale: float | None = Field(default=None, ge=0, le=20)
    abc: str | None = Field(default=None, max_length=100000)
    name: str = Field(default="song", max_length=80)
    ode_steps: int = Field(default=32, ge=1, le=100)
    abc_sampling: dict | None = None
    semantic_sampling: dict | None = None


class Runtime:
    def __init__(self):
        self.lock = threading.RLock()
        self.pipe: YuE2Pipeline | None = None
        self.status = "loading"
        self.stage = "loading"
        self.generating = False
        self.error: str | None = None
        self.started_at = datetime.now().astimezone().isoformat()
        self.current: dict | None = None
        self.history: list[dict] = []
        self.log: list[dict] = []
        self.cancel = threading.Event()

    def event(self, message: str, stage: str | None = None):
        with self.lock:
            if stage:
                self.stage = stage
            self.log.append({"at": datetime.now().astimezone().isoformat(), "stage": self.stage, "message": message})
            self.log = self.log[-200:]

    def public(self):
        with self.lock:
            return {
                "status": self.status,
                "stage": self.stage,
                "model_loaded": self.pipe is not None,
                "generating": self.generating,
                "error": self.error,
                "current": self.current,
                "history": list(reversed(self.history)),
                "log": self.log[-80:],
                "started_at": self.started_at,
            }


runtime = Runtime()
app = FastAPI(title="YuE2 Local Service", version="1.0.0")


def safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")
    return value[:48] or "song"


def load_pipeline():
    try:
        runtime.event("Resolving and verifying YuE2 model files", "loading")
        pipe = YuE2Pipeline.from_pretrained(MODEL, vae=VAE, device="cuda", progress=False)
        with runtime.lock:
            runtime.pipe = pipe
            runtime.status = "ready"
            runtime.stage = "ready"
            runtime.error = None
        runtime.event("YuE2 pipeline is ready; weights stay cached between requests")
    except Exception as exc:
        with runtime.lock:
            runtime.status = "error"
            runtime.stage = "error"
            runtime.error = str(exc)
        runtime.event(f"Pipeline load failed: {exc}")


@app.on_event("startup")
def startup():
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=load_pipeline, name="yue2-loader", daemon=True).start()


@app.get("/", response_class=HTMLResponse)
def index():
    return STATIC.read_text(encoding="utf-8")


@app.get("/yue2-logo.png")
def logo():
    return FileResponse(Path(__file__).with_name("yue2-logo.png"), media_type="image/png")


@app.get("/favicon.png")
def favicon():
    return FileResponse(Path(__file__).with_name("favicon.png"), media_type="image/png")


@app.get("/health")
def health():
    state = runtime.public()
    return {"service": "YuE2", **{key: state[key] for key in ("status", "stage", "model_loaded", "generating", "error")}}


@app.get("/status")
def status():
    return runtime.public()


@app.get("/audio/{run_id}")
def audio(run_id: str):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id):
        raise HTTPException(400, "Invalid run id")
    path = (OUTPUT_ROOT / run_id / "audio.flac").resolve()
    if OUTPUT_ROOT not in path.parents or not path.is_file():
        raise HTTPException(404, "Audio not found")
    return FileResponse(path, media_type="audio/flac", filename="audio.flac")


@app.post("/generate", status_code=202)
def generate(request: GenerateRequest):
    if request.abc is not None and (request.cot == "off" or not request.abc.strip()):
        raise HTTPException(400, "Edited ABC requires melody or full planning mode")
    with runtime.lock:
        if runtime.generating:
            raise HTTPException(409, "A generation is already running")
        if runtime.pipe is None:
            raise HTTPException(503, runtime.error or "YuE2 is still loading")
        run_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{safe_name(request.name)}"
        runtime.generating = True
        runtime.status = "generating"
        runtime.stage = "planning"
        runtime.error = None
        runtime.cancel.clear()
        runtime.current = {"id": run_id, "stage": "planning", "output": str(OUTPUT_ROOT / run_id), "seed": request.seed}
    threading.Thread(target=run_generation, args=(request, run_id), name=f"yue2-{run_id}", daemon=True).start()
    return {"ok": True, "id": run_id, "status_url": "/status"}


def run_generation(request: GenerateRequest, run_id: str):
    pipe = runtime.pipe
    assert pipe is not None
    output = OUTPUT_ROOT / run_id
    started = time.perf_counter()
    default_config = pipe.generation_config
    def on_token(phase, _token):
        with runtime.lock:
            if runtime.current is not None:
                counts = runtime.current.setdefault("tokens", {})
                counts[phase] = counts.get(phase, 0) + 1
    try:
        output.mkdir(parents=False, exist_ok=False)
        pipe.generation_config = dataclasses.replace(default_config, ode_steps=request.ode_steps)
        kwargs = request.model_dump(exclude={"name", "ode_steps", "abc_sampling", "semantic_sampling"})
        if kwargs.get("cfg_scale") is None:
            kwargs.pop("cfg_scale")
        if kwargs.get("abc") is None:
            kwargs.pop("abc")
        runtime.event("Using edited ABC directly" if request.abc else "Creating symbolic music plan", "planning")
        plan = pipe.plan(**kwargs, abc_sampling=request.abc_sampling, cancelled=runtime.cancel.is_set, on_token=on_token)
        if runtime.cancel.is_set():
            raise InterruptedError("Generation cancelled")
        runtime.event("Generating semantic music tokens", "semantic_generation")
        semantic = pipe.generate_semantic(plan, sampling=request.semantic_sampling, cancelled=runtime.cancel.is_set, on_token=on_token)
        if runtime.cancel.is_set():
            raise InterruptedError("Generation cancelled")
        runtime.event("Synthesizing acoustic latents", "synthesis")
        nar_started = time.perf_counter()
        latents = pipe.synthesize(semantic, cancelled=runtime.cancel.is_set)
        nar_seconds = time.perf_counter() - nar_started
        if runtime.cancel.is_set():
            raise InterruptedError("Generation cancelled")
        runtime.event("Decoding 48 kHz stereo audio", "decoding")
        decode_started = time.perf_counter()
        audio_data = pipe.decode(latents)
        request_config = pipe.effective_config(plan.request, request.abc_sampling, request.semantic_sampling)
        identity_data = json.dumps({"request": plan.request.to_dict(), "config": request_config}, sort_keys=True).encode()
        result = SongResult(
            audio_data, 48000, semantic, np.asarray(latents), request_config, pipe.weights,
            {"abc": plan.timing, "semantic": semantic.timing, "nar_seconds": nar_seconds,
             "vae_seconds": time.perf_counter() - decode_started, "load": dict(pipe.load_timing),
             "e2e_seconds": time.perf_counter() - started},
            hashlib.sha256(identity_data).hexdigest(),
        )
        saved = result.save_artifacts(output)
        record = {
            "id": run_id, "status": "completed", "stage": "completed", "output": str(output),
            "audio_url": f"/audio/{run_id}", "abc": result.abc, "duration": saved["audio_seconds"],
            "seed": request.seed, "cot": request.cot, "style": request.style,
            "elapsed": time.perf_counter() - started, "truncated": saved["truncated"],
        }
        with runtime.lock:
            runtime.history.append(record)
            runtime.current = record
            runtime.status = "ready"
            runtime.stage = "completed"
        runtime.event(f"Completed {record['duration']:.1f}s audio in {record['elapsed']:.1f}s", "completed")
    except InterruptedError as exc:
        with runtime.lock:
            runtime.status = "ready"
            runtime.stage = "cancelled"
            runtime.error = str(exc)
        runtime.event(str(exc), "cancelled")
    except Exception as exc:
        (output / "error.txt").write_text(traceback.format_exc(), encoding="utf-8")
        with runtime.lock:
            runtime.status = "error"
            runtime.stage = "error"
            runtime.error = str(exc)
        runtime.event(f"Generation failed: {exc}", "error")
    finally:
        pipe.generation_config = default_config
        with runtime.lock:
            runtime.generating = False


@app.post("/stop-generation")
def stop_generation():
    with runtime.lock:
        if not runtime.generating:
            return {"ok": True, "stopped": False, "message": "No generation is running"}
        runtime.cancel.set()
    runtime.event("Cancellation requested")
    return {"ok": True, "stopped": True}


@app.post("/open-output-folder")
def open_output_folder(body: dict | None = None):
    target = OUTPUT_ROOT
    run_id = (body or {}).get("id")
    if isinstance(run_id, str) and re.fullmatch(r"[A-Za-z0-9._-]+", run_id):
        candidate = (OUTPUT_ROOT / run_id).resolve()
        if candidate.is_dir() and OUTPUT_ROOT in candidate.parents:
            target = candidate
    try:
        windows_path = subprocess.check_output(["wslpath", "-w", str(target)], text=True).strip()
        subprocess.Popen(["/mnt/c/Windows/explorer.exe", windows_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ok": True, "path": str(target)}
    except Exception as exc:
        raise HTTPException(500, f"Could not open output folder: {exc}")


@app.post("/shutdown")
def shutdown():
    if runtime.generating:
        runtime.cancel.set()
    runtime.event("Service shutdown requested", "stopping")
    def terminate_when_idle():
        deadline = time.monotonic() + 30
        while runtime.generating and time.monotonic() < deadline:
            time.sleep(.2)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=terminate_when_idle, name="yue2-shutdown", daemon=True).start()
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("YUE2_PORT", "7862")), log_level="info")
