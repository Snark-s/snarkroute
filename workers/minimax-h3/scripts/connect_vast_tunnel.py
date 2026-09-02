"""Save a tunnelled Vast H3 worker in local SnarkRoute without printing secrets."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--identity", required=True, type=Path)
    parser.add_argument("--worker-url", default="http://127.0.0.1:18080")
    parser.add_argument("--snarkroute-api", default="http://127.0.0.1:4317")
    args = parser.parse_args()

    if not args.identity.is_file():
        raise RuntimeError("SSH identity file does not exist")

    with tempfile.TemporaryDirectory(prefix="snarkroute-h3-") as directory:
        runtime_file = Path(directory) / "runtime.env"
        subprocess.run(
            [
                "scp",
                "-q",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=25",
                "-i",
                str(args.identity),
                "-P",
                str(args.port),
                f"root@{args.host}:/workspace/snarkroute-h3/.runtime.env",
                str(runtime_file),
            ],
            check=True,
        )
        token = next(
            (
                line.partition("=")[2].strip()
                for line in runtime_file.read_text(encoding="utf-8").splitlines()
                if line.startswith("H3_WORKER_SERVICE_TOKEN=")
            ),
            "",
        )
        if not re.fullmatch(r"[0-9a-f]{64}", token):
            raise RuntimeError("remote H3 service token is missing or malformed")

        payload = json.dumps({"workerUrl": args.worker_url, "serviceToken": token}).encode()
        request = urllib.request.Request(
            f"{args.snarkroute_api.rstrip('/')}/api/h3/connection",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            message = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"SnarkRoute rejected the H3 connection ({exc.code}): {message}") from exc

    status = result.get("status", {})
    print(
        json.dumps(
            {
                "saved": bool(result.get("ok")),
                "connected": bool(status.get("connected")),
                "ready": bool(status.get("ready")),
                "backend": status.get("backend"),
                "backendVersion": status.get("backendVersion"),
                "workerUrl": status.get("workerUrl"),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
