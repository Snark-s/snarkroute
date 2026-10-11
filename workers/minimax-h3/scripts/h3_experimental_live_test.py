#!/usr/bin/env python3
"""Authenticated smoke-test against the local H3 worker.

No tokens are printed. Captures PNG/MP4 results for visual comparison.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

BASE = "http://127.0.0.1:18080"
TOKEN = Path("/home/serge/h3/runtime/worker-token").read_text().strip()
HEADERS = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
OUTPUT_DIR = Path("/home/serge/h3/outputs/experimental_20261011")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def request(route, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + route, data=data, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def run(mode):
    still = mode == "still"
    body = {
        "operation": "video.generate.h3", "task": "t2va",
        "prompt": "A single blue glass sphere on a dark table, soft studio illumination, subtle reflections, intricate microtextures, static camera.",
        "conditions": [], "quality_mode": "preview", "model_variant": "h3_base",
        "num_outputs_per_prompt": 1, "num_inference_steps": 4, "seed": 20261011,
        "target": {"short_edge": 768, "aspect_ratio": "16:9", "duration_seconds": 4},
        "output_mode": "still" if still else "video",
        "vae_mode": "stock" if still else "x2"
    }
    job = json.loads(request("/v1/jobs", body))
    jid = job["id"]
    print("CREATED", mode, jid, flush=True)
    deadline = time.monotonic() + 1200
    last_stage = ""
    while time.monotonic() < deadline:
        time.sleep(5)
        try:
            job = json.loads(request("/v1/jobs/" + jid))
        except (TimeoutError, urllib.error.URLError) as exc:
            print("STATUS_RETRY", mode, type(exc).__name__, flush=True)
            continue
        stage = job.get("stage")
        if stage != last_stage:
            print("PROGRESS", mode, stage, job.get("progress"), flush=True)
            last_stage = stage
        if job["status"] in ("succeeded", "failed", "cancelled"):
            break
    if job["status"] != "succeeded":
        raise RuntimeError(f"{mode} job failed: {job.get('error') or job.get('status')}")
    blob = request("/v1/jobs/" + jid + "/content?variant=0")
    ext = ".png" if still else ".mp4"
    if still and not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("Expected PNG signature")
    if not still and blob[4:8] != b"ftyp":
        raise RuntimeError("Expected MP4 signature")
    result = OUTPUT_DIR / ("h3_" + mode + ext)
    result.write_bytes(blob)
    print("SUCCESS", mode, str(result), "bytes", len(blob), "metadata", json.dumps(job.get("metadata"),ensure_ascii=False)[:800], flush=True)


if __name__ == "__main__":
    modes = sys.argv[1:] or ["still","x2"]
    for mode in modes:
        run(mode)
