import argparse
import json
import shlex
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Stop local H3 containers on idle or budget threshold")
    parser.add_argument("--activity-file", type=Path, default=Path("/data/results/last-activity"))
    parser.add_argument("--started-at", help="UTC ISO time; defaults to watchdog start")
    parser.add_argument("--gpu-usd-per-hour", type=float, required=True)
    parser.add_argument("--max-budget-usd", type=float, required=True)
    parser.add_argument("--idle-minutes", type=float, default=20)
    parser.add_argument("--poll-seconds", type=float, default=30)
    parser.add_argument("--on-trigger-command", default="docker compose -f compose.example.yml down")
    parser.add_argument(
        "--execute", action="store_true", help="Run the fixed argv command; otherwise report only"
    )
    args = parser.parse_args()
    if min(args.gpu_usd_per_hour, args.max_budget_usd, args.idle_minutes, args.poll_seconds) <= 0:
        parser.error("price, budget, idle time, and poll interval must be positive")
    started = (
        datetime.fromisoformat(args.started_at.replace("Z", "+00:00"))
        if args.started_at
        else datetime.now(UTC)
    )
    while True:
        current = datetime.now(UTC)
        elapsed_hours = (current - started).total_seconds() / 3600
        estimated_cost = elapsed_hours * args.gpu_usd_per_hour
        last_activity = (
            datetime.fromtimestamp(args.activity_file.stat().st_mtime, UTC)
            if args.activity_file.exists()
            else started
        )
        idle_minutes = (current - last_activity).total_seconds() / 60
        reason = (
            "budget"
            if estimated_cost >= args.max_budget_usd
            else "idle"
            if idle_minutes >= args.idle_minutes
            else None
        )
        print(
            json.dumps({"estimatedCostUsd": estimated_cost, "idleMinutes": idle_minutes, "trigger": reason})
        )
        if reason:
            (args.activity_file.parent / "shutdown-requested.json").write_text(
                json.dumps({"reason": reason, "at": current.isoformat(), "estimatedCostUsd": estimated_cost}),
                encoding="utf-8",
            )
            if args.execute:
                subprocess.run(shlex.split(args.on_trigger_command), check=False)
            return 75
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
