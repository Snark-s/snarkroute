import argparse
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser(description="H3 worker API/GPU smoke test")
    parser.add_argument("--url", default=os.getenv("H3_WORKER_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--token", default=os.getenv("H3_WORKER_SERVICE_TOKEN"))
    parser.add_argument("--timeout", type=float, default=7200)
    parser.add_argument("--require-gpu", action="store_true")
    args = parser.parse_args()
    if not args.token:
        parser.error("set H3_WORKER_SERVICE_TOKEN or pass --token")
    if args.require_gpu:
        if not shutil.which("nvidia-smi"):
            raise SystemExit("nvidia-smi is required for --require-gpu")
        subprocess.run(["nvidia-smi"], check=True)
    headers = {"Authorization": f"Bearer {args.token}"}
    with httpx.Client(base_url=args.url, headers=headers, timeout=30) as client:
        assert client.get("/health", headers={}).status_code == 200
        ready = client.get("/ready")
        ready.raise_for_status()
        backend = ready.json()["backend"]
        if args.require_gpu and backend != "sglang":
            raise RuntimeError(f"GPU smoke requires sglang, got {backend}")
        capabilities = client.get("/v1/capabilities")
        capabilities.raise_for_status()
        payload = {
            "operation": "video.generate.h3",
            "task": "t2va",
            "prompt": "A small blue cube turns once on a plain neutral background.",
            "target": {"short_edge": 768, "aspect_ratio": "1:1", "duration_seconds": 4},
            "seed": 7,
            "num_outputs_per_prompt": 1,
            "num_inference_steps": 20,
            "quality_mode": "final",
        }
        created = client.post("/v1/jobs", json=payload, headers={**headers, "Idempotency-Key": "smoke-h3-v1"})
        created.raise_for_status()
        job = created.json()
        deadline = time.monotonic() + args.timeout
        while job["status"] not in {"succeeded", "failed", "cancelled"}:
            if time.monotonic() > deadline:
                raise TimeoutError("smoke job timed out")
            time.sleep(1)
            response = client.get(f"/v1/jobs/{job['id']}")
            response.raise_for_status()
            job = response.json()
        if job["status"] != "succeeded":
            raise RuntimeError(f"smoke job failed: {job.get('error')}")
        result = client.get(f"/v1/jobs/{job['id']}/result")
        result.raise_for_status()
        content = client.get(f"/v1/jobs/{job['id']}/content")
        content.raise_for_status()
        output = Path("h3-smoke-result.mp4")
        output.write_bytes(content.content)
        if backend == "mock":
            assert content.content.startswith(b"SNARKROUTE-H3-MOCK")
        elif args.require_gpu:
            if not shutil.which("ffprobe"):
                raise RuntimeError("ffprobe is required to verify the GPU MP4")
            subprocess.run(["ffprobe", "-v", "error", "-show_streams", str(output)], check=True)
        print(f"backend={backend} job={job['id']} bytes={len(content.content)} output={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
