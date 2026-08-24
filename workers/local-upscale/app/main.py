from __future__ import annotations

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.config import Settings
from app.errors import WorkerError
from app.service import UpscaleService
from app.video_service import VideoUpscaleService


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(min_length=1, max_length=128)
    input_asset: str = Field(min_length=1, max_length=128)
    scale: int | None = None
    tile_size: int | None = None
    tile_overlap: int | None = None
    device: str | None = None
    options: dict[str, object] = Field(default_factory=dict)


class VideoJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(min_length=1, max_length=160)
    input_asset: str = Field(min_length=1, max_length=160)
    scale: int | None = None
    device: str | None = None
    output_codec: str | None = None
    output_container: str | None = None
    crf: int | None = None
    chunk_size: int | None = None
    overlap_frames: int | None = None
    audio_handling: str | None = None
    tile_size: int | None = None
    tile_overlap: int | None = None


def create_app(
    settings: Settings | None = None,
    service: UpscaleService | None = None,
    video_service: VideoUpscaleService | None = None,
) -> FastAPI:
    configured = settings or Settings.from_env()
    worker = service or UpscaleService(configured)
    video_worker = video_service or VideoUpscaleService(configured)
    app = FastAPI(title="SnarkRoute local upscale worker", version="0.1.0")

    @app.exception_handler(WorkerError)
    async def worker_error_handler(_request: Request, error: WorkerError):
        status = {
            "unauthorized": 401,
            "worker_not_configured": 503,
            "job_not_found": 404,
            "invalid_model_id": 404,
            "missing_weights": 409,
            "input_too_large": 413,
            "unsupported_codec": 415,
            "unsupported_pixel_format": 415,
        }.get(error.code, 400)
        return JSONResponse(status_code=status, content={"error": error.as_dict()})

    def authorize(authorization: str | None = Header(default=None)) -> None:
        if not configured.service_token:
            raise WorkerError("worker_not_configured", "LOCAL_UPSCALE_WORKER_TOKEN is empty.")
        if authorization != f"Bearer {configured.service_token}":
            raise WorkerError("unauthorized", "A valid worker bearer token is required.")

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "snarkroute-local-upscale-worker", "version": "0.1.0"}

    @app.get("/ready", dependencies=[Depends(authorize)])
    async def ready():
        return {"ok": True, "runtime": configured.runtime_override, "model_dir": str(configured.model_dir)}

    @app.get("/v1/capabilities", dependencies=[Depends(authorize)])
    async def capabilities():
        return worker.capabilities()

    @app.post("/v1/assets", dependencies=[Depends(authorize)])
    async def upload_asset(request: Request, x_filename: str = Header(default="input.png")):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        return worker.store_asset(await request.body(), x_filename, content_type)

    @app.post("/v1/jobs", dependencies=[Depends(authorize)])
    async def create_job(request: JobRequest):
        return (await worker.create_job(request.model_dump(exclude_none=True))).public()

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorize)])
    async def get_job(job_id: str):
        return worker.get_job(job_id).public()

    @app.post("/v1/jobs/{job_id}/cancel", dependencies=[Depends(authorize)])
    async def cancel_job(job_id: str):
        return worker.cancel(job_id).public()

    @app.get("/v1/jobs/{job_id}/content", dependencies=[Depends(authorize)])
    async def job_content(job_id: str):
        job = worker.get_job(job_id)
        if job.status != "succeeded" or not job.output_path:
            raise WorkerError("result_not_ready", "Local upscale result is not ready.")
        return FileResponse(job.output_path, media_type="image/png", filename="result.png")

    @app.get("/v1/video/capabilities", dependencies=[Depends(authorize)])
    async def video_capabilities():
        return video_worker.capabilities()

    @app.post("/v1/video/assets", dependencies=[Depends(authorize)])
    async def upload_video_asset(request: Request, x_filename: str = Header(default="input.mp4")):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        return video_worker.store_asset(await request.body(), x_filename, content_type)

    @app.post("/v1/video/jobs", dependencies=[Depends(authorize)])
    async def create_video_job(request: VideoJobRequest):
        return (await video_worker.create_job(request.model_dump(exclude_none=True))).public()

    @app.get("/v1/video/jobs/{job_id}", dependencies=[Depends(authorize)])
    async def get_video_job(job_id: str):
        return video_worker.get_job(job_id).public()

    @app.post("/v1/video/jobs/{job_id}/cancel", dependencies=[Depends(authorize)])
    async def cancel_video_job(job_id: str):
        return video_worker.cancel(job_id).public()

    @app.get("/v1/video/jobs/{job_id}/content", dependencies=[Depends(authorize)])
    async def video_job_content(job_id: str):
        job = video_worker.get_job(job_id)
        if job.status != "succeeded" or not job.output_path:
            raise WorkerError("result_not_ready", "Local video upscale result is not ready.")
        return FileResponse(job.output_path, media_type="video/mp4", filename="result.mp4")

    app.state.upscale_service = worker
    app.state.video_upscale_service = video_worker
    return app


app = create_app()
