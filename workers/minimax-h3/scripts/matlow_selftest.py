"""Print the fail-closed MATLOWAI/Comfy-kitchen GPU startup probe."""

from __future__ import annotations

import json

from app.backends.matlow_runtime import MatlowRuntime
from app.config import Settings


def main() -> int:
    settings = Settings.from_env()
    status = MatlowRuntime(settings).probe()
    print(json.dumps(status, ensure_ascii=False, sort_keys=True), flush=True)
    return 0 if status.get("ready") else 1


if __name__ == "__main__":
    raise SystemExit(main())
