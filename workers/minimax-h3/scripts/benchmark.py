import argparse
import csv
import json
from datetime import UTC, datetime
from pathlib import Path

FIELDS = [
    "case_id",
    "system",
    "precision_profile",
    "verified_on_gpu",
    "gpu_model",
    "peak_vram_gib",
    "host_ram_gib",
    "disk_gib",
    "gpu_usd_per_hour",
    "startup_seconds",
    "model_load_seconds",
    "render_seconds",
    "attempts",
    "accepted_results",
    "cost_per_run_usd",
    "cost_per_accepted_video_usd",
    "model_parameters",
    "motion_score",
    "identity_score",
    "prompt_adherence_score",
    "artifact_score",
    "notes",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a reproducible H3/Kling benchmark record")
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--system", choices=("h3", "kling"), required=True)
    parser.add_argument(
        "--profile",
        choices=("bf16_offload", "kitchen_int8", "external"),
        default="external",
        help="H3 benchmarks must explicitly select bf16_offload or kitchen_int8",
    )
    parser.add_argument("--verified-on-gpu", action="store_true")
    parser.add_argument("--gpu-model", default="")
    parser.add_argument("--peak-vram-gib", type=float, default=0)
    parser.add_argument("--host-ram-gib", type=float, default=0)
    parser.add_argument("--disk-gib", type=float, default=0)
    parser.add_argument("--gpu-usd-per-hour", type=float, default=0)
    parser.add_argument("--startup-seconds", type=float, default=0)
    parser.add_argument("--model-load-seconds", type=float, default=0)
    parser.add_argument("--render-seconds", type=float, required=True)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--accepted-results", type=int, default=0)
    parser.add_argument("--model-parameters", default="{}")
    parser.add_argument(
        "--scores", default="{}", help="JSON with motion, identity, prompt_adherence, artifacts (1-5)"
    )
    parser.add_argument("--notes", default="")
    parser.add_argument("--output", type=Path, default=Path("benchmark/results.json"))
    args = parser.parse_args()
    if args.system == "h3" and args.profile == "external":
        parser.error("H3 benchmarks require --profile bf16_offload or kitchen_int8")
    if (
        min(
            args.gpu_usd_per_hour,
            args.render_seconds,
            args.attempts,
            args.accepted_results,
            args.peak_vram_gib,
            args.host_ram_gib,
            args.disk_gib,
        )
        < 0
    ):
        parser.error("numeric inputs must be non-negative")
    scores = json.loads(args.scores)
    parameters = json.loads(args.model_parameters)
    cost = (
        args.gpu_usd_per_hour
        * (args.startup_seconds + args.model_load_seconds + args.render_seconds * args.attempts)
        / 3600
    )
    record = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "case_id": args.case_id,
        "system": args.system,
        "precision_profile": args.profile,
        "verified_on_gpu": args.verified_on_gpu,
        "gpu_model": args.gpu_model,
        "peak_vram_gib": args.peak_vram_gib or None,
        "host_ram_gib": args.host_ram_gib or None,
        "disk_gib": args.disk_gib or None,
        "gpu_usd_per_hour": args.gpu_usd_per_hour,
        "startup_seconds": args.startup_seconds,
        "model_load_seconds": args.model_load_seconds,
        "render_seconds": args.render_seconds,
        "attempts": args.attempts,
        "accepted_results": args.accepted_results,
        "cost_per_run_usd": cost / args.attempts if args.attempts else None,
        "cost_per_accepted_video_usd": cost / args.accepted_results if args.accepted_results else None,
        "model_parameters": parameters,
        "motion_score": scores.get("motion"),
        "identity_score": scores.get("identity"),
        "prompt_adherence_score": scores.get("prompt_adherence"),
        "artifact_score": scores.get("artifacts"),
        "notes": args.notes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    records = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else []
    records.append(record)
    args.output.write_text(json.dumps(records, indent=2), encoding="utf-8")
    csv_path = args.output.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        for item in records:
            writer.writerow(
                {**item, "model_parameters": json.dumps(item["model_parameters"], sort_keys=True)}
            )
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
