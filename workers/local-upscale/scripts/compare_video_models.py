"""Run reproducible OpenModelDB temporal-vs-framewise comparisons via Model Gateway."""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.video_pipeline import ffmpeg_executable, probe_video

TEMPORAL_MODELS = (
    "openmodeldb/gameup-v2-tscunet-small-x2",
    "openmodeldb/vimeoscale-unet-x2",
    "openmodeldb/redsval-7f-rrdb-lite-x4",
    "openmodeldb/video-tssm-x3",
)
FRAMEWISE_BASELINES = (
    "framewise/4x-purephoto-span",
    "framewise/4x-hfa2k-ludvae-grl-small",
)
FIXTURES = ("natural", "cgi-game", "compression", "animation")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-url", default="http://127.0.0.1:4318")
    parser.add_argument("--worker-url", default="http://127.0.0.1:8091")
    parser.add_argument("--output", type=Path, default=Path("reports/local-video-upscale/openmodeldb-2026-08-24"))
    parser.add_argument("--models", nargs="*", default=[*TEMPORAL_MODELS, *FRAMEWISE_BASELINES])
    parser.add_argument("--fixtures", nargs="*", default=list(FIXTURES))
    parser.add_argument("--token", default=os.getenv("LOCAL_UPSCALE_WORKER_TOKEN", ""))
    parser.add_argument("--performance-only", action="store_true")
    parser.add_argument("--visuals-only", action="store_true")
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("LOCAL_UPSCALE_WORKER_TOKEN or --token is required")
    root = args.output.resolve()
    fixture_dir = root / "fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    models = available_models(args.worker_url, args.token, args.models)
    if args.performance_only:
        run_performance_comparison(root, fixture_dir, models, args.server_url, args.worker_url, args.token)
        return
    fixtures = create_fixtures(fixture_dir, args.fixtures)
    if args.visuals_only:
        for fixture_name, input_path in fixtures.items():
            outputs = {"input": input_path}
            outputs.update(
                {
                    str(model["id"]): root / fixture_name / safe_name(str(model["id"])) / "output.mp4"
                    for model in models
                }
            )
            make_visuals(root, fixture_name, outputs)
        return
    rows: list[dict[str, object]] = []
    for fixture_name, input_path in fixtures.items():
        outputs: dict[str, Path] = {"input": input_path}
        for model in models:
            label = safe_name(model["id"])
            output_path = root / fixture_name / label / "output.mp4"
            output_path.parent.mkdir(parents=True, exist_ok=True)
            print(f"[{fixture_name}] {model['id']}", flush=True)
            gateway, telemetry = run_gateway(
                args.server_url,
                args.worker_url,
                args.token,
                input_path,
                output_path,
                model,
                fixture_name,
            )
            metrics = video_metrics(output_path, comparison_chunk_size(model))
            row = {
                "fixture": fixture_name,
                "model_id": model["id"],
                "architecture_family": model.get("architecture_family"),
                "temporal": model["temporal"],
                "native_scale": model["native_scale"],
                "context_frames": model["context_frames"],
                "runtime": model["runtime"],
                "license": model["license"],
                "commercial_use": model.get("commercial_use"),
                "provider_cost": gateway.get("costs", {}).get("providerCost"),
                **telemetry,
                **metrics,
            }
            rows.append(row)
            (output_path.parent / "result.json").write_text(
                json.dumps({"gateway": gateway, "worker_output": telemetry, "metrics": metrics}, indent=2),
                encoding="utf-8",
            )
            outputs[model["id"]] = output_path
        make_visuals(root, fixture_name, outputs)
    write_reports(root, rows, models)


def run_performance_comparison(
    root: Path,
    fixture_dir: Path,
    models: list[dict[str, object]],
    server_url: str,
    worker_url: str,
    token: str,
) -> None:
    dimensions = {2: (640, 360), 3: (426, 240), 4: (320, 180)}
    rows: list[dict[str, object]] = []
    outputs: dict[str, Path] = {}
    for model in models:
        scale = int(model["native_scale"])
        width, height = dimensions[scale]
        fixture = fixture_dir / f"performance-x{scale}-{width}x{height}.mp4"
        if not fixture.exists():
            encode_fixture(fixture, render_frames("natural", 6, width, height), crf=18)
        output = root / "performance" / safe_name(str(model["id"])) / "output.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        print(f"[performance {width}x{height}] {model['id']}", flush=True)
        gateway, telemetry = run_gateway(server_url, worker_url, token, fixture, output, model, "performance")
        metrics = video_metrics(output, comparison_chunk_size(model))
        rows.append(
            {
                "fixture": f"performance-{width}x{height}",
                "model_id": model["id"],
                "temporal": model["temporal"],
                "native_scale": scale,
                "input_width": width,
                "input_height": height,
                "provider_cost": gateway.get("costs", {}).get("providerCost"),
                **telemetry,
                **metrics,
            }
        )
        outputs[str(model["id"])] = output
        (output.parent / "result.json").write_text(
            json.dumps({"gateway": gateway, "worker_output": telemetry, "metrics": metrics}, indent=2),
            encoding="utf-8",
        )
    write_reports(root, rows, models, prefix="performance-")
    make_model_only_contact_sheet(root / "performance-contact-sheet.png", outputs)


def available_models(worker_url: str, token: str, requested: list[str]) -> list[dict[str, object]]:
    payload = request_json(f"{worker_url}/v1/video/capabilities", headers=auth(token))
    by_id = {model["id"]: model for model in payload["models"]}
    missing = [model_id for model_id in requested if model_id not in by_id or not by_id[model_id]["weights_installed"]]
    if missing:
        raise RuntimeError(f"Unavailable requested models: {', '.join(missing)}")
    return [by_id[model_id] for model_id in requested]


def create_fixtures(directory: Path, selected: list[str]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    with tempfile.TemporaryDirectory(prefix="snarkroute-video-fixtures-") as temporary:
        frame_dir = Path(temporary)
        for name in selected:
            if name not in FIXTURES:
                raise ValueError(f"Unknown fixture: {name}")
            frames = render_frames(name, 12, 96, 64)
            for index, frame in enumerate(frames):
                Image.fromarray(frame).save(frame_dir / f"{name}-{index:04d}.png")
            output = directory / f"{name}.mp4"
            encode_png_sequence(frame_dir / f"{name}-%04d.png", output, 38 if name == "compression" else 18)
            result[name] = output
    return result


def encode_fixture(output: Path, frames: list[np.ndarray], crf: int) -> None:
    with tempfile.TemporaryDirectory(prefix="snarkroute-performance-fixture-") as temporary:
        frame_dir = Path(temporary)
        for index, frame in enumerate(frames):
            Image.fromarray(frame).save(frame_dir / f"frame-{index:04d}.png")
        encode_png_sequence(frame_dir / "frame-%04d.png", output, crf)


def encode_png_sequence(pattern: Path, output: Path, crf: int) -> None:
    command = [
        ffmpeg_executable(), "-y", "-nostdin", "-v", "error", "-framerate", "6",
        "-i", str(pattern), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", str(crf), "-c:a", "aac", "-shortest", str(output),
    ]
    subprocess.run(command, check=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def render_frames(name: str, count: int, width: int, height: int) -> list[np.ndarray]:
    rng = np.random.default_rng(20260824)
    frames: list[np.ndarray] = []
    for index in range(count):
        image = Image.new("RGB", (width, height), (28, 38, 55))
        draw = ImageDraw.Draw(image)
        if name == "natural":
            for y in range(height):
                draw.line((0, y, width, y), fill=(35 + y, 80 + y, 135 + y // 2))
            draw.rectangle((0, 43, width, height), fill=(55, 92, 48))
            x = 8 + index * 6
            draw.ellipse((x, 25, x + 17, 42), fill=(196, 106, 55), outline=(240, 220, 170), width=2)
            array = np.asarray(image).copy()
            array = np.clip(array.astype(np.int16) + rng.integers(-5, 6, array.shape), 0, 255).astype(np.uint8)
            image = Image.fromarray(array)
        elif name == "cgi-game":
            draw.rectangle((0, 0, width, height), fill=(10, 10, 22))
            for x in range(-height, width, 12):
                draw.line((x + index * 2, height, x + 32 + index * 2, 0), fill=(35, 62, 90), width=1)
            draw.polygon(((14 + index * 4, 48), (27 + index * 4, 16), (41 + index * 4, 48)), fill=(0, 210, 235), outline=(255, 255, 255))
            draw.text((4, 3), "HP 98", fill=(255, 235, 40), font=ImageFont.load_default())
        elif name == "compression":
            for x in range(0, width, 8):
                draw.rectangle((x, 0, x + 7, height), fill=(35 + x * 2, 70, 145 - x))
            draw.ellipse((22 + index * 4, 19, 48 + index * 4, 45), fill=(230, 65, 54))
            draw.text((4, 4), "WEB 360p", fill="white", font=ImageFont.load_default())
        else:
            draw.rectangle((0, 0, width, height), fill=(244, 218, 185))
            draw.rectangle((0, 44, width, height), fill=(80, 185, 160))
            x = 12 + index * 5
            draw.rectangle((x, 22, x + 20, 43), fill=(247, 89, 106), outline=(30, 30, 40), width=2)
            draw.ellipse((x + 4, 15, x + 16, 27), fill=(255, 220, 180), outline=(30, 30, 40), width=2)
            draw.text((4, 4), "FRAME", fill=(20, 20, 30), font=ImageFont.load_default())
        frames.append(np.asarray(image).copy())
    return frames


def run_gateway(server_url: str, worker_url: str, token: str, input_path: Path, output_path: Path, model: dict[str, object], fixture: str):
    overlap = int(model.get("recommended_overlap_frames") or 0)
    chunk = comparison_chunk_size(model)
    body = {
        "capability": "video.upscale", "nodeType": "local_video_upscale", "outputMediaType": "video",
        "modelId": model["id"], "providerModelId": model["id"], "provider": "local_video_upscale",
        "hostType": "boojumroute", "parameters": {
            "device": "cuda", "chunk_size": chunk, "overlap_frames": overlap,
            "crf": 18, "audio_handling": "copy", "tile_size": 128, "tile_overlap": 16,
        },
        "inputs": [{"kind": "video", "role": "source", "index": 0, "assetId": f"fixture-{fixture}", "path": str(input_path)}],
        "idempotencyKey": f"omdb-video-{fixture}-{safe_name(str(model['id']))}-{time.time_ns()}",
    }
    created = request_json(f"{server_url}/api/model-gateway/jobs", body)
    job_id = created["job"]["id"]
    deadline = time.monotonic() + 3600
    while time.monotonic() < deadline:
        state = request_json(f"{server_url}/api/model-gateway/jobs/{job_id}")["job"]
        if state["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.5)
    else:
        raise TimeoutError(job_id)
    if state["status"] != "completed":
        raise RuntimeError(f"Gateway job {job_id} failed: {state.get('error')} {state.get('errorDetails')}")
    download(f"{server_url}/api/model-gateway/jobs/{job_id}/result", output_path)
    worker_id = state.get("providerJobId")
    worker = request_json(f"{worker_url}/v1/video/jobs/{worker_id}", headers=auth(token)) if worker_id else {}
    telemetry = dict(worker.get("output") or {})
    telemetry["gateway_job_id"] = job_id
    telemetry["worker_job_id"] = worker_id
    return state, telemetry


def comparison_chunk_size(model: dict[str, object]) -> int:
    return int(model.get("recommended_chunk_size") or 12)


def video_metrics(path: Path, chunk_size: int) -> dict[str, object]:
    probe = probe_video(path)
    frames = decode_frames(path, probe.width, probe.height)
    luma = frames.astype(np.float32).mean(axis=3)
    deltas = np.abs(np.diff(luma, axis=0)).mean(axis=(1, 2)) if len(frames) > 1 else np.array([])
    static = luma[:, : max(4, probe.height // 4), : max(4, probe.width // 4)]
    static_variation = np.abs(np.diff(static, axis=0)).mean() if len(frames) > 1 else 0.0
    boundaries = [index - 1 for index in range(chunk_size, len(frames), chunk_size) if index - 1 < len(deltas)]
    return {
        "measured_width": probe.width, "measured_height": probe.height, "measured_fps": probe.fps,
        "measured_frame_count": len(frames), "measured_duration": probe.duration,
        "has_audio": probe.has_audio, "audio_codec_measured": probe.audio_codec,
        "mean_frame_delta": float(deltas.mean()) if len(deltas) else 0.0,
        "p95_frame_delta": float(np.percentile(deltas, 95)) if len(deltas) else 0.0,
        "static_region_temporal_variation": float(static_variation),
        "duplicate_adjacent_frames": int(np.count_nonzero(deltas < 0.05)),
        "chunk_boundary_mean_delta": float(np.mean(deltas[boundaries])) if boundaries else None,
    }


def decode_frames(path: Path, width: int, height: int) -> np.ndarray:
    result = subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    frame_bytes = width * height * 3
    count = len(result.stdout) // frame_bytes
    return np.frombuffer(result.stdout[: count * frame_bytes], dtype=np.uint8).reshape(count, height, width, 3)


def make_visuals(root: Path, fixture: str, outputs: dict[str, Path]) -> None:
    decoded: dict[str, np.ndarray] = {}
    for label, path in outputs.items():
        probe = probe_video(path)
        decoded[label] = decode_frames(path, probe.width, probe.height)
    labels = list(decoded)
    sample_indices = (2, 6, 10)
    cell = (256, 160)
    sheet = Image.new("RGB", (cell[0] * len(sample_indices), cell[1] * len(labels)), "white")
    for row, label in enumerate(labels):
        for column, index in enumerate(sample_indices):
            frame = Image.fromarray(decoded[label][min(index, len(decoded[label]) - 1)]).resize((256, 144), Image.Resampling.LANCZOS)
            sheet.paste(frame, (column * cell[0], row * cell[1] + 16))
        ImageDraw.Draw(sheet).text((3, row * cell[1] + 2), label[:78], fill="black", font=ImageFont.load_default())
    sheet.save(root / f"{fixture}-contact-sheet.png")
    strip = Image.new("RGB", (128 * 5, 112 * len(labels)), "white")
    for row, label in enumerate(labels):
        frames = decoded[label]
        for column, index in enumerate(range(4, 9)):
            frame = Image.fromarray(frames[min(index, len(frames) - 1)])
            width, height = frame.size
            crop = frame.crop((width // 4, height // 4, width * 3 // 4, height * 3 // 4)).resize((128, 96), Image.Resampling.NEAREST)
            strip.paste(crop, (column * 128, row * 112 + 16))
        ImageDraw.Draw(strip).text((3, row * 112 + 2), label[:78], fill="black", font=ImageFont.load_default())
    strip.save(root / f"{fixture}-temporal-strip.png")
    crop_boxes = ((0.0, 0.0, 0.36, 0.55), (0.28, 0.18, 0.72, 0.82), (0.64, 0.45, 1.0, 1.0))
    crop_sheet = Image.new("RGB", (cell[0] * len(crop_boxes), cell[1] * len(labels)), "white")
    crop_draw = ImageDraw.Draw(crop_sheet)
    for row, label in enumerate(labels):
        frame = Image.fromarray(decoded[label][min(6, len(decoded[label]) - 1)])
        width, height = frame.size
        for column, (left, top, right, bottom) in enumerate(crop_boxes):
            box = (round(left * width), round(top * height), round(right * width), round(bottom * height))
            crop = frame.crop(box)
            crop.thumbnail((256, 144), Image.Resampling.NEAREST)
            canvas = Image.new("RGB", (256, 144), (235, 235, 235))
            canvas.paste(crop, ((256 - crop.width) // 2, (144 - crop.height) // 2))
            crop_sheet.paste(canvas, (column * cell[0], row * cell[1] + 16))
        crop_draw.text((3, row * cell[1] + 2), label[:78], fill="black", font=ImageFont.load_default())
    crop_sheet.save(root / f"{fixture}-crop-sheet.png")


def make_model_only_contact_sheet(path: Path, outputs: dict[str, Path]) -> None:
    sheet = Image.new("RGB", (384, 232 * len(outputs)), "white")
    draw = ImageDraw.Draw(sheet)
    for row, (label, output) in enumerate(outputs.items()):
        probe = probe_video(output)
        frames = decode_frames(output, probe.width, probe.height)
        frame = Image.fromarray(frames[len(frames) // 2]).resize((384, 216), Image.Resampling.LANCZOS)
        sheet.paste(frame, (0, row * 232 + 16))
        draw.text((3, row * 232 + 2), label[:78], fill="black", font=ImageFont.load_default())
    sheet.save(path)


def write_reports(
    root: Path,
    rows: list[dict[str, object]],
    models: list[dict[str, object]],
    prefix: str = "",
) -> None:
    fields = sorted({key for row in rows for key in row})
    with (root / f"{prefix}metrics.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gpu": gpu_info(), "models": models, "results": rows,
        "notes": [
            "No aggregate quality score or automatic winner is calculated.",
            "Temporal variation metrics describe outputs; they are not perceptual quality rankings.",
            "ONNX Runtime VRAM is unavailable under WDDM in the worker telemetry.",
        ],
    }
    (root / f"{prefix}report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


def gpu_info() -> str:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unavailable"


def request_json(url: str, body: dict[str, object] | None = None, headers: dict[str, str] | None = None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {url}: {exc.read(1000)!r}") from exc


def download(url: str, path: Path) -> None:
    with urllib.request.urlopen(url, timeout=120) as response, path.open("wb") as stream:
        while chunk := response.read(1024 * 1024):
            stream.write(chunk)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def safe_name(value: str) -> str:
    return "".join(character if character.isalnum() or character in "-_" else "-" for character in value).strip("-")


if __name__ == "__main__":
    main()
