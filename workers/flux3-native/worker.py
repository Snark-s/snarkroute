"""Persistent FLUX.3 Klein worker for SnarkRoute (no ComfyUI, stdlib HTTP only).

Loopback-only HTTP service. The model is loaded lazily on the first request and
kept in memory; it is unloaded (VRAM released) after FLUX3_IDLE_UNLOAD_SEC of
inactivity so other GPU work (TouchDesigner, Mixar) gets the card back.

Endpoints:
  GET  /health                      -> identity, no auth
  GET  /runtime      (Bearer token) -> active jobs, loaded state
  POST /generate     (Bearer token) -> same JSON as infer.py stdin; returns result
  POST /unload       (Bearer token) -> release the model now
  POST /shutdown     (Bearer token) -> stop the process
"""
from __future__ import annotations

import argparse
import gc
import hmac
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import infer  # noqa: E402

SERVICE = "snarkroute-flux3-worker"
VERSION = "0.1.0"
TOKEN = os.environ.get("FLUX3_WORKER_TOKEN", "").strip()
IDLE_UNLOAD_SEC = int(os.environ.get("FLUX3_IDLE_UNLOAD_SEC", "300"))
MAX_BODY = 256 * 1024


class Runtime:
    def __init__(self) -> None:
        self.lock = threading.Lock()          # one generation at a time on one GPU
        self.state_lock = threading.Lock()
        self.pipe = None
        self.active_jobs = 0
        self.completed_jobs = 0
        self.last_used = 0.0
        self.loading = False
        self.last_error: str | None = None
        self.last_duration_sec: float | None = None

    def snapshot(self) -> dict:
        with self.state_lock:
            return {
                "service": SERVICE, "version": VERSION, "ok": True,
                "model": infer.MODEL_ID, "loaded": self.pipe is not None,
                "loading": self.loading, "active_jobs": self.active_jobs,
                "completed_jobs": self.completed_jobs,
                "idle_unload_sec": IDLE_UNLOAD_SEC,
                "last_duration_sec": self.last_duration_sec,
                "last_error": self.last_error,
            }

    def generate(self, request: dict) -> dict:
        request = infer.validate_request(request)
        with self.state_lock:
            self.active_jobs += 1
        try:
            with self.lock:
                if self.pipe is None:
                    with self.state_lock:
                        self.loading = True
                    try:
                        self.pipe = infer.load_pipeline()
                    finally:
                        with self.state_lock:
                            self.loading = False
                started = time.time()
                result = infer.render(self.pipe, request)
                self.last_duration_sec = round(time.time() - started, 1)
                self.last_used = time.time()
                self.completed_jobs += 1
                self.last_error = None
                return {**result, "duration_sec": self.last_duration_sec}
        except Exception as error:
            self.last_error = f"{type(error).__name__}: {str(error)[:400]}"
            raise
        finally:
            with self.state_lock:
                self.active_jobs -= 1

    def unload(self) -> bool:
        with self.lock:
            if self.pipe is None:
                return False
            self.pipe = None
            gc.collect()
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            return True

    def idle_loop(self) -> None:
        # Measured 2026-10-21: after unload VRAM drops 10.4 -> 2.3 GB, but the process
        # keeps ~10 GB RAM (CPU-offloaded weights are not returned to the OS). So when
        # idle the worker exits entirely; SnarkRoute restarts it on the next job (~30 s).
        while True:
            time.sleep(15)
            if self.pipe is not None and self.active_jobs == 0 and IDLE_UNLOAD_SEC > 0 \
                    and time.time() - self.last_used > IDLE_UNLOAD_SEC:
                print(json.dumps({"event": "idle_exit", "idle_sec": IDLE_UNLOAD_SEC}), flush=True)
                os._exit(0)


RUNTIME = Runtime()


class Handler(BaseHTTPRequestHandler):
    server_version = "snarkroute-flux3/" + VERSION

    def log_message(self, fmt: str, *args) -> None:  # concise access log to stdout
        print(json.dumps({"event": "http", "line": fmt % args}), flush=True)

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else ""
        if TOKEN and hmac.compare_digest(supplied, TOKEN):
            return True
        self._send(401, {"ok": False, "error": "unauthorized"})
        return False

    def _json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Request body is empty or too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        if self.path == "/health":
            snap = RUNTIME.snapshot()
            return self._send(200, {k: snap[k] for k in ("service", "version", "ok", "model", "loaded")})
        if self.path == "/runtime":
            if self._authorized():
                self._send(200, RUNTIME.snapshot())
            return
        self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if not self._authorized():
            return
        if self.path == "/generate":
            try:
                result = RUNTIME.generate(self._json_body())
                return self._send(200, result)
            except ValueError as error:
                return self._send(400, {"ok": False, "error": "invalid_request", "message": str(error)})
            except Exception as error:
                traceback.print_exc()
                code = "cuda_oom" if "out of memory" in str(error).lower() else type(error).__name__
                return self._send(500, {"ok": False, "error": code, "message": str(error)[:800]})
        if self.path == "/unload":
            # Releases VRAM only; RAM is freed by /shutdown (or the idle exit).
            return self._send(200, {"ok": True, "unloaded": RUNTIME.unload()})
        if self.path == "/shutdown":
            self._send(200, {"ok": True, "stopping": True})
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return
        self._send(404, {"ok": False, "error": "not_found"})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8093)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("FLUX.3 worker binds to loopback only")
    if not TOKEN:
        raise SystemExit("FLUX3_WORKER_TOKEN is required")
    threading.Thread(target=RUNTIME.idle_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(json.dumps({"event": "listening", "host": args.host, "port": args.port}), flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
