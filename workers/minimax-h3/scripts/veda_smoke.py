from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

URL = "http://127.0.0.1:18080"
TOKEN_FILE = Path.home() / "h3/runtime/worker-token"


def main() -> int:
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "operation": "video.generate.h3",
        "task": "t2va",
        "prompt": "A small blue glass cube slowly rotates once on a neutral gray background, locked camera.",
        "target": {"short_edge": 768, "aspect_ratio": "16:9", "duration_seconds": 4},
        "seed": 2605,
        "num_outputs_per_prompt": 1,
        "num_inference_steps": 4,
        "quality_mode": "preview",
        "quality": "lossless",
        "turbo_lora": False,
        "model_variant": "h3_base",
    }
    with httpx.Client(base_url=URL, headers=headers, timeout=30) as client:
        created = client.post(
            "/v1/jobs",
            json=payload,
            headers={**headers, "Idempotency-Key": f"veda-smoke-{int(time.time())}"},
        )
        if not created.is_success:
            raise RuntimeError(f"create failed {created.status_code}: {created.text}")
        job = created.json()
        print("job", job["id"], flush=True)
        while job["status"] not in {"succeeded", "failed", "cancelled"}:
            time.sleep(2)
            try:
                response = client.get(f"/v1/jobs/{job['id']}")
            except httpx.ReadTimeout:
                print("status api-busy (cold model load)", flush=True)
                continue
            response.raise_for_status()
            job = response.json()
            print("status", job["status"], job.get("stage"), job.get("progress"), flush=True)
        if job["status"] != "succeeded":
            raise RuntimeError(json.dumps(job.get("error"), ensure_ascii=False))
        result = client.get(f"/v1/jobs/{job['id']}/result")
        result.raise_for_status()
        data = result.json()
        print("result", json.dumps(data, ensure_ascii=False, indent=2), flush=True)
        content = client.get(f"/v1/jobs/{job['id']}/content")
        content.raise_for_status()
        out = Path.home() / "h3/outputs/veda-smoke.mp4"
        out.write_bytes(content.content)
        print("output", out, len(content.content), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
