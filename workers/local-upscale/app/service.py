from __future__ import annotations

import asyncio
import hashlib
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

from app.config import Settings
from app.errors import WorkerError
from app.image import process_image
from app.registry import ModelRegistry
from app.runtime import RuntimeFactory, is_out_of_memory


@dataclass
class Job:
    id: str
    model: str
    input_asset: str
    scale: int
    tile_size: int
    tile_overlap: int
    device: str
    options: dict[str, Any]
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
        value = {
            "id": self.id,
            "model": self.model,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.output:
            value["output"] = self.output
        if self.error:
            value["error"] = self.error
        return value


class UpscaleService:
    def __init__(
        self,
        settings: Settings,
        registry: ModelRegistry | None = None,
        runtimes: RuntimeFactory | None = None,
    ):
        self.settings = settings
        self.registry = registry or ModelRegistry.load()
        self.runtimes = runtimes or RuntimeFactory()
        self.assets: dict[str, Path] = {}
        self.jobs: dict[str, Job] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.asset_dir = settings.data_dir / "assets"
        self.result_dir = settings.data_dir / "results"

    def capabilities(self) -> dict[str, Any]:
        return {
            "provider": "local_upscale",
            "api_cost": 0,
            "models": [model.public_view(self.settings.model_dir, self.settings.runtime_override) for model in self.registry.list()],
            "parameters": [
                {"id": "scale", "type": "number", "required": False},
                {"id": "tile_size", "type": "number", "min": 64, "max": 2048, "required": False},
                {"id": "tile_overlap", "type": "number", "min": 0, "max": 256, "required": False},
                {"id": "device", "type": "select", "options": ["auto", "cuda", "cpu"], "required": False},
            ],
            "input_types": ["image/png", "image/jpeg"],
            "output_types": ["image/png"],
        }

    def store_asset(self, data: bytes, filename: str, mime_type: str) -> dict[str, str]:
        if not data or len(data) > self.settings.max_upload_bytes:
            raise WorkerError("invalid_input", f"Asset must be between 1 and {self.settings.max_upload_bytes} bytes.")
        if mime_type not in {"image/png", "image/jpeg"}:
            raise WorkerError("invalid_input", "Only image/png and image/jpeg assets are accepted.")
        extension = ".jpg" if mime_type == "image/jpeg" else ".png"
        safe_name = "".join(char if char.isalnum() or char in "._-" else "_" for char in Path(filename).name)
        if not safe_name.lower().endswith((".png", ".jpg", ".jpeg")):
            safe_name += extension
        self.asset_dir.mkdir(parents=True, exist_ok=True)
        asset_id = f"asset_{uuid4()}"
        path = self.asset_dir / f"{asset_id}-{safe_name}"
        path.write_bytes(data)
        try:
            with Image.open(path) as image:
                image.verify()
                if image.format not in {"PNG", "JPEG"}:
                    raise WorkerError("invalid_input", "Asset content is not PNG or JPEG.")
        except (UnidentifiedImageError, OSError) as exc:
            path.unlink(missing_ok=True)
            raise WorkerError("invalid_input", "Asset content is not a valid PNG or JPEG.") from exc
        self.assets[asset_id] = path
        return {"id": asset_id, "filename": safe_name, "mime_type": mime_type}

    async def create_job(self, request: dict[str, Any]) -> Job:
        model_id = str(request.get("model") or "").strip()
        model = self.registry.get(model_id)
        asset_id = str(request.get("input_asset") or "").strip()
        if asset_id not in self.assets:
            raise WorkerError("invalid_input", "input_asset does not reference an uploaded image.")
        scale = _integer(request.get("scale", model.scale_factor), "scale", 1, 8)
        if scale != model.scale_factor:
            raise WorkerError("invalid_parameters", f"{model.id} supports only {model.scale_factor}x output.", details={"supported_scales": [model.scale_factor]})
        tile_size = _integer(request.get("tile_size", model.recommended_tile_size), "tile_size", 64, 2048)
        tile_overlap = _integer(request.get("tile_overlap", 32), "tile_overlap", 0, 256)
        if tile_overlap >= tile_size:
            raise WorkerError("invalid_parameters", "tile_overlap must be smaller than tile_size.")
        device = str(request.get("device") or "auto").lower()
        if device not in {"auto", "cuda", "cpu"} and not device.startswith("cuda:"):
            raise WorkerError("invalid_parameters", "device must be auto, cuda, cuda:N, or cpu.")
        weights_path = model.weights_path(self.settings.model_dir)
        if self.settings.runtime_override != "mock" and not weights_path.is_file():
            raise WorkerError(
                "missing_weights",
                f"Weights for {model.id} are not installed. Run scripts/download_models.py --model {model.id}.",
                details={"model": model.id, "expected_path": str(weights_path)},
            )
        options = request.get("options") if isinstance(request.get("options"), dict) else {}
        job = Job(f"up_{uuid4()}", model.id, asset_id, scale, tile_size, tile_overlap, device, options)
        self.jobs[job.id] = job
        self.tasks[job.id] = asyncio.create_task(self._run(job))
        return job

    def get_job(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise WorkerError("job_not_found", "Local upscale job was not found.")
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get_job(job_id)
        if job.status in {"succeeded", "failed", "cancelled"}:
            return job
        job.cancel_event.set()
        job.status = "cancelled"
        job.stage = "cancelled"
        job.updated_at = datetime.now(UTC).isoformat()
        return job

    async def _run(self, job: Job) -> None:
        model = self.registry.get(job.model)
        input_path = self.assets[job.input_asset]
        output_path = self.result_dir / job.id / "result.png"
        job.status = "running"
        job.stage = "loading_model"
        job.progress = 0.02
        try:
            runtime = self.runtimes.create(model, model.weights_path(self.settings.model_dir), job.device, self.settings.runtime_override)
            if job.cancel_event.is_set():
                raise WorkerError("cancelled", "Upscale job was cancelled.")

            def update(value: float) -> None:
                job.progress = min(0.95, 0.05 + max(0.0, min(value, 1.0)) * 0.9)
                job.stage = "tiled_inference"
                job.updated_at = datetime.now(UTC).isoformat()

            try:
                output = await asyncio.wait_for(
                    asyncio.to_thread(
                        process_image,
                        input_path,
                        output_path,
                        model,
                        runtime,
                        job.tile_size,
                        job.tile_overlap,
                        self.settings.max_input_pixels,
                        update,
                        job.cancel_event.is_set,
                    ),
                    timeout=self.settings.job_timeout_seconds,
                )
            except TimeoutError as exc:
                job.cancel_event.set()
                raise WorkerError("timeout", "Local upscale inference timed out.", True) from exc
            if job.cancel_event.is_set() or job.status == "cancelled":
                output_path.unlink(missing_ok=True)
                return
            job.output = output
            job.output_path = output_path
            job.status = "succeeded"
            job.stage = "completed"
            job.progress = 1.0
        except WorkerError as exc:
            if exc.code == "cancelled" or job.status == "cancelled":
                job.status = "cancelled"
                job.stage = "cancelled"
            else:
                job.status = "failed"
                job.stage = "failed"
                job.error = exc.as_dict()
        except Exception as exc:  # runtime failures are normalized at the process boundary
            if is_out_of_memory(exc):
                error = WorkerError("gpu_oom", "GPU ran out of memory during upscale.", True, {"tile_size": job.tile_size, "model": job.model})
            else:
                error = WorkerError("runtime_failed", f"Local upscale runtime failed: {type(exc).__name__}", False)
            job.status = "failed"
            job.stage = "failed"
            job.error = error.as_dict()
        finally:
            job.updated_at = datetime.now(UTC).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
