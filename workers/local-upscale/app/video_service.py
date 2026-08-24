from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import Settings
from app.errors import WorkerError
from app.registry import ModelRegistry
from app.runtime import RuntimeFactory, is_out_of_memory
from app.video_pipeline import process_video
from app.video_registry import VideoModelRegistry


@dataclass
class VideoJob:
    id: str
    model: str
    input_asset: str
    scale: int
    device: str
    output_codec: str
    output_container: str
    crf: int
    chunk_size: int
    overlap_frames: int
    audio_handling: str
    tile_size: int
    tile_overlap: int
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    output: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    output_path: Path | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict[str, Any]:
        result = {
            "id": self.id,
            "model": self.model,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.output:
            result["output"] = self.output
        if self.error:
            result["error"] = self.error
        return result


class VideoUpscaleService:
    def __init__(
        self,
        settings: Settings,
        image_registry: ModelRegistry | None = None,
        registry: VideoModelRegistry | None = None,
        runtimes: RuntimeFactory | None = None,
    ):
        self.settings = settings
        self.image_registry = image_registry or ModelRegistry.load()
        self.registry = registry or VideoModelRegistry.load(self.image_registry)
        self.runtimes = runtimes or RuntimeFactory()
        self.assets: dict[str, Path] = {}
        self.jobs: dict[str, VideoJob] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.asset_dir = settings.data_dir / "video-assets"
        self.result_dir = settings.data_dir / "video-results"

    def capabilities(self) -> dict[str, Any]:
        return {
            "provider": "local_video_upscale",
            "capability": "video.upscale",
            "api_cost": 0,
            "models": [
                model.public_view(self.settings.model_dir, self.settings.model_dir, self.settings.runtime_override)
                for model in self.registry.list()
            ],
            "parameters": [
                {"id": "scale", "type": "number", "required": False},
                {"id": "device", "type": "select", "options": ["auto", "cuda", "cpu"], "required": False},
                {"id": "output_codec", "type": "select", "options": ["libx264"], "required": False},
                {"id": "output_container", "type": "select", "options": ["mp4"], "required": False},
                {"id": "crf", "type": "number", "min": 0, "max": 51, "required": False},
                {"id": "chunk_size", "type": "number", "min": 1, "max": 120, "required": False},
                {"id": "overlap_frames", "type": "number", "min": 0, "max": 16, "required": False},
                {"id": "audio_handling", "type": "select", "options": ["copy", "drop"], "required": False},
            ],
            "input_types": ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
            "output_types": ["video/mp4"],
            "color_pipeline": {"input": "FFmpeg decoded RGB24", "output": "8-bit YUV420p BT.709 limited range"},
            "vfr_strategy": "decoded frame order is preserved and output is CFR at the reported input average FPS",
        }

    def store_asset(self, data: bytes, filename: str, mime_type: str) -> dict[str, str]:
        accepted = {"video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv"}
        if not data or len(data) > self.settings.max_upload_bytes:
            raise WorkerError("invalid_input", f"Asset must be between 1 and {self.settings.max_upload_bytes} bytes.")
        if mime_type not in accepted:
            raise WorkerError("invalid_input", "Only MP4, MOV, WebM, and Matroska video assets are accepted.")
        safe_name = "".join(char if char.isalnum() or char in "._-" else "_" for char in Path(filename).name)
        if not Path(safe_name).suffix:
            safe_name += accepted[mime_type]
        self.asset_dir.mkdir(parents=True, exist_ok=True)
        asset_id = f"video_asset_{uuid4()}"
        path = self.asset_dir / f"{asset_id}-{safe_name}"
        path.write_bytes(data)
        self.assets[asset_id] = path
        return {"id": asset_id, "filename": safe_name, "mime_type": mime_type}

    async def create_job(self, request: dict[str, Any]) -> VideoJob:
        model = self.registry.get(str(request.get("model") or "").strip())
        asset_id = str(request.get("input_asset") or "").strip()
        if asset_id not in self.assets:
            raise WorkerError("invalid_input", "input_asset does not reference an uploaded video.")
        scale = _integer(request.get("scale", model.native_scale), "scale", 1, 8)
        if scale != model.native_scale:
            raise WorkerError("invalid_parameters", f"{model.id} supports only {model.native_scale}x output.")
        device = str(request.get("device") or "auto").lower()
        if device not in {"auto", "cuda", "cpu"} and not device.startswith("cuda:"):
            raise WorkerError("invalid_parameters", "device must be auto, cuda, cuda:N, or cpu.")
        output_codec = str(request.get("output_codec") or "libx264")
        output_container = str(request.get("output_container") or "mp4")
        if output_codec != "libx264" or output_container != "mp4":
            raise WorkerError("invalid_parameters", "The MVP supports only libx264 in an MP4 container.")
        crf = _integer(request.get("crf", 18), "crf", 0, 51)
        chunk_size = _integer(request.get("chunk_size", model.recommended_chunk_size), "chunk_size", 1, 120)
        overlap_frames = _integer(request.get("overlap_frames", 2 if model.temporal else 0), "overlap_frames", 0, 16)
        if not model.temporal and overlap_frames:
            raise WorkerError("invalid_parameters", "Framewise models do not support temporal overlap.")
        if overlap_frames >= chunk_size:
            raise WorkerError("invalid_parameters", "overlap_frames must be smaller than chunk_size.")
        audio_handling = str(request.get("audio_handling") or "copy")
        if audio_handling not in {"copy", "drop"}:
            raise WorkerError("invalid_parameters", "audio_handling must be copy or drop.")
        tile_size = _integer(request.get("tile_size", model.recommended_tile_size or 256), "tile_size", 64, 2048)
        tile_overlap = _integer(request.get("tile_overlap", 32), "tile_overlap", 0, 256)
        if tile_overlap >= tile_size:
            raise WorkerError("invalid_parameters", "tile_overlap must be smaller than tile_size.")
        weights = model.weights_path(self.settings.model_dir)
        if self.settings.runtime_override != "mock" and weights and not weights.is_file():
            raise WorkerError("missing_weights", f"Weights for {model.id} are not installed.", details={"model": model.id, "expected_path": str(weights)})
        job = VideoJob(
            f"vup_{uuid4()}", model.id, asset_id, scale, device, output_codec, output_container,
            crf, chunk_size, overlap_frames, audio_handling, tile_size, tile_overlap,
        )
        self.jobs[job.id] = job
        self.tasks[job.id] = asyncio.create_task(self._run(job))
        return job

    def get_job(self, job_id: str) -> VideoJob:
        job = self.jobs.get(job_id)
        if not job:
            raise WorkerError("job_not_found", "Local video upscale job was not found.")
        return job

    def cancel(self, job_id: str) -> VideoJob:
        job = self.get_job(job_id)
        if job.status in {"succeeded", "failed", "cancelled"}:
            return job
        job.cancel_event.set()
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = datetime.now(UTC).isoformat()
        return job

    async def _run(self, job: VideoJob) -> None:
        model = self.registry.get(job.model)
        output_path = self.result_dir / job.id / "result.mp4"
        job.status = "running"
        job.stage = "probing"
        job.progress = 0.01

        def update(value: float, stage: str) -> None:
            job.progress = min(0.99, max(job.progress, value))
            job.stage = stage
            job.updated_at = datetime.now(UTC).isoformat()

        try:
            output = await asyncio.wait_for(
                asyncio.to_thread(
                    process_video,
                    self.assets[job.input_asset], output_path, model, self.settings.model_dir,
                    self.image_registry, self.runtimes, job.device, job.chunk_size, job.overlap_frames,
                    job.crf, job.audio_handling, job.tile_size, job.tile_overlap,
                    self.settings.max_input_pixels, update, job.cancel_event.is_set,
                ),
                timeout=self.settings.job_timeout_seconds,
            )
            if job.cancel_event.is_set() or job.status == "cancelled":
                output_path.unlink(missing_ok=True)
                return
            job.output = output
            job.output_path = output_path
            job.status = "succeeded"
            job.stage = "completed"
            job.progress = 1.0
        except TimeoutError as exc:
            job.cancel_event.set()
            job.status = "failed"
            job.stage = "failed"
            job.error = WorkerError("timeout", "Local video upscale timed out.", True).as_dict()
            output_path.unlink(missing_ok=True)
            _ = exc
        except WorkerError as exc:
            if exc.code == "cancelled" or job.status == "cancelled":
                job.status = "cancelled"
                job.stage = "cancelled"
            else:
                job.status = "failed"
                job.stage = "failed"
                job.error = exc.as_dict()
            output_path.unlink(missing_ok=True)
        except Exception as exc:
            error = WorkerError("gpu_oom", "GPU ran out of memory during video upscale.", True) if is_out_of_memory(exc) else WorkerError("runtime_failed", f"Local video upscale failed: {type(exc).__name__}")
            job.status = "failed"
            job.stage = "failed"
            job.error = error.as_dict()
            output_path.unlink(missing_ok=True)
        finally:
            job.updated_at = datetime.now(UTC).isoformat()


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise WorkerError("invalid_parameters", f"{label} must be an integer between {minimum} and {maximum}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise WorkerError("invalid_parameters", f"{label} must be an integer between {minimum} and {maximum}.") from exc
    if parsed != value or not minimum <= parsed <= maximum:
        raise WorkerError("invalid_parameters", f"{label} must be an integer between {minimum} and {maximum}.")
    return parsed
