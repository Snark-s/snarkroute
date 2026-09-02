import asyncio
import hashlib
import hmac
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from .backends import CapabilityUnavailable, create_backend
from .config import Settings
from .models import GenerateRequest, JobView, StructuredError
from .storage import JobRepository, create_result_store

TERMINAL = {"succeeded", "failed", "cancelled"}
MIME_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "video/mp4": (b"ftyp",),
    "audio/wav": (b"RIFF",),
    "audio/mpeg": (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"),
}
MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "video/mp4": ".mp4",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
}


def now() -> str:
    return datetime.now(UTC).isoformat()


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or Settings.from_env()
    repository = JobRepository(configured.result_dir)
    backend = create_backend(configured)
    result_store = create_result_store(configured)
    jobs: dict[str, dict[str, Any]] = {}
    idempotency: dict[str, str] = {}
    tasks: dict[str, asyncio.Task[None]] = {}

    def persist(job: dict[str, Any]) -> None:
        job["updated_at"] = now()
        repository.write(job)

    def public_job(job: dict[str, Any]) -> JobView:
        return JobView.model_validate(job)

    def load_job(job_id: str) -> dict[str, Any]:
        if job_id in jobs:
            return jobs[job_id]
        try:
            job = repository.read(job_id)
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail={"code": "job_not_found", "message": "job not found"}
            ) from exc
        jobs[job_id] = job
        return job

    async def progress(job_id: str, value: float, stage: str) -> None:
        job = jobs[job_id]
        if job["status"] == "cancelled":
            raise asyncio.CancelledError
        job.update(progress=max(0.0, min(value, 0.99)), stage=stage)
        persist(job)

    async def run_job(job_id: str, generation: GenerateRequest) -> None:
        job = jobs[job_id]
        work_dir = configured.temp_dir / job_id
        work_dir.mkdir(parents=True, exist_ok=False)
        try:
            job.update(status="running", stage="backend_start", progress=0.01, started_at=now())
            persist(job)
            timeout = generation.timeout_seconds or configured.job_timeout_seconds
            produced = await asyncio.wait_for(
                backend.execute(generation, work_dir, lambda value, stage: progress(job_id, value, stage)),
                timeout=timeout,
            )
            outputs = []
            metadata = None
            for index, output in enumerate(produced):
                stored = result_store.put(job_id, index, output.path, output.filename, output.mime_type)
                outputs.append(
                    {
                        "index": index,
                        "filename": stored.filename,
                        "mime_type": stored.mime_type,
                        "bytes": stored.bytes,
                        "storage_backend": stored.backend,
                        "storage_key": stored.key,
                    }
                )
                metadata = output.metadata.model_dump(mode="json")
            job.update(
                status="succeeded",
                stage="complete",
                progress=1.0,
                outputs=outputs,
                metadata=metadata,
                completed_at=now(),
                error=None,
            )
            persist(job)
            _note_activity(configured.result_dir)
        except asyncio.CancelledError:
            job.update(status="cancelled", stage="cancelled", progress=None, completed_at=now())
            persist(job)
        except CapabilityUnavailable as exc:
            job.update(
                status="failed",
                stage="failed",
                progress=None,
                error=StructuredError(
                    code="capability_not_available",
                    message=exc.reason,
                    retryable=False,
                    details={"capability": exc.capability},
                ).model_dump(mode="json"),
                completed_at=now(),
            )
            persist(job)
        except TimeoutError:
            job.update(
                status="failed",
                stage="failed",
                progress=None,
                error=StructuredError(
                    code="job_timeout", message="job exceeded its configured timeout", retryable=True
                ).model_dump(mode="json"),
                completed_at=now(),
            )
            persist(job)
        except Exception as exc:
            job.update(
                status="failed",
                stage="failed",
                progress=None,
                error=StructuredError(
                    code="backend_error",
                    message=f"H3 backend failed: {type(exc).__name__}",
                    retryable=True,
                ).model_dump(mode="json"),
                completed_at=now(),
            )
            persist(job)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            tasks.pop(job_id, None)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        configured.result_dir.mkdir(parents=True, exist_ok=True)
        configured.temp_dir.mkdir(parents=True, exist_ok=True)
        _clean_older_than(configured.temp_dir, configured.temp_retention_hours)
        for job in repository.load_all():
            if job.get("status") not in TERMINAL:
                job.update(
                    status="failed",
                    stage="failed",
                    progress=None,
                    error=StructuredError(
                        code="worker_restarted",
                        message="worker restarted before completion",
                        retryable=True,
                    ).model_dump(mode="json"),
                    completed_at=now(),
                )
                repository.write(job)
            jobs[str(job["id"])] = job
            key = job.get("idempotency_key")
            if isinstance(key, str):
                idempotency[key] = str(job["id"])
        yield
        for task in list(tasks.values()):
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    application = FastAPI(
        title="SnarkRoute MiniMax H3 worker",
        version="0.2.0",
        lifespan=lifespan,
    )
    application.state.settings = configured
    application.state.backend = backend
    application.state.jobs = jobs

    async def authorize(authorization: str | None = Header(default=None)) -> None:
        supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
        if not configured.service_token or not hmac.compare_digest(supplied, configured.service_token):
            raise HTTPException(
                status_code=401, detail={"code": "unauthorized", "message": "invalid service token"}
            )

    @application.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {key: value for key, value in item.items() if key not in {"input", "ctx"}}
            for item in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "invalid_request",
                    "message": "request validation failed",
                    "retryable": False,
                    "details": {"errors": errors},
                }
            },
        )

    @application.middleware("http")
    async def limit_request_size(request: Request, call_next):
        raw = request.headers.get("content-length")
        limit = (
            configured.max_upload_bytes if request.url.path == "/v1/assets" else configured.max_request_bytes
        )
        try:
            too_large = bool(raw) and int(raw) > limit
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"error": {"code": "invalid_content_length", "message": "invalid Content-Length"}},
            )
        if too_large:
            return JSONResponse(
                status_code=413,
                content={
                    "error": {"code": "request_too_large", "message": "request exceeds configured limit"}
                },
            )
        return await call_next(request)

    @application.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "snarkroute-minimax-h3-worker", "version": "0.2.0"}

    @application.get("/ready", dependencies=[Depends(authorize)])
    async def ready() -> JSONResponse:
        backend_ready, reason = await backend.ready()
        ready_now = bool(configured.service_token) and backend_ready
        return JSONResponse(
            status_code=200 if ready_now else 503,
            content={
                "ready": ready_now,
                "backend": backend.name,
                "backendVersion": backend.version,
                "reason": reason if configured.service_token else "H3_WORKER_SERVICE_TOKEN is empty",
                "activeJobs": len(tasks),
            },
        )

    @application.get("/v1/capabilities", dependencies=[Depends(authorize)])
    async def capabilities() -> dict[str, Any]:
        return {
            "backend": backend.name,
            "backendVersion": backend.version,
            "mock": backend.name == "mock",
            "capabilities": [item.model_dump(mode="json") for item in backend.capabilities()],
        }

    @application.post("/v1/assets", dependencies=[Depends(authorize)], status_code=201)
    async def upload_asset(request: Request) -> dict[str, str]:
        mime_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        if mime_type not in MIME_EXTENSIONS:
            raise HTTPException(
                status_code=415,
                detail={
                    "code": "unsupported_media_type",
                    "message": "supported types: PNG, JPEG, MP4, WAV, MP3",
                },
            )
        asset_id = str(uuid4())
        directory = configured.result_dir / "inputs" / asset_id
        directory.mkdir(parents=True, exist_ok=False)
        path = directory / f"input{MIME_EXTENSIONS[mime_type]}"
        written = 0
        prefix = bytearray()
        try:
            with path.open("xb") as stream:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > configured.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail={"code": "asset_too_large", "message": "asset exceeds configured limit"},
                        )
                    if len(prefix) < 16:
                        prefix.extend(chunk[: 16 - len(prefix)])
                    stream.write(chunk)
            if not written:
                raise HTTPException(
                    status_code=400, detail={"code": "empty_asset", "message": "asset is empty"}
                )
            if not _matches_signature(mime_type, bytes(prefix)):
                raise HTTPException(
                    status_code=415,
                    detail={
                        "code": "media_signature_mismatch",
                        "message": "file bytes do not match Content-Type",
                    },
                )
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        return {"id": asset_id, "uri": path.as_uri(), "mimeType": mime_type}

    @application.post("/v1/jobs", response_model=JobView, dependencies=[Depends(authorize)], status_code=202)
    async def create_job(
        generation: GenerateRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JobView:
        key = generation.idempotency_key or idempotency_key
        if generation.idempotency_key and idempotency_key and generation.idempotency_key != idempotency_key:
            raise HTTPException(
                status_code=409,
                detail={"code": "idempotency_conflict", "message": "header and body idempotency keys differ"},
            )
        capability = generation.requested_capability
        capability_view = next((item for item in backend.capabilities() if item.name == capability), None)
        if not capability_view or not capability_view.available:
            reason = capability_view.reason if capability_view else "capability is unknown"
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "capability_not_available",
                    "message": reason,
                    "retryable": False,
                    "details": {"capability": capability},
                },
            )
        if generation.turbo_lora:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "capability_not_available",
                    "message": "Turbo LoRA is not bundled; pin and accept its separate license before enabling it",
                    "retryable": False,
                },
            )
        _validate_worker_file_uris(generation, configured)
        request_hash = hashlib.sha256(
            generation.model_dump_json(exclude={"idempotency_key"}).encode()
        ).hexdigest()
        if key and key in idempotency:
            existing = load_job(idempotency[key])
            if existing.get("request_hash") != request_hash:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "idempotency_conflict",
                        "message": "key was already used for another request",
                    },
                )
            return public_job(existing)
        job_id = str(uuid4())
        timestamp = now()
        job = {
            "id": job_id,
            "status": "queued",
            "stage": "queued",
            "progress": 0.0,
            "error": None,
            "outputs": [],
            "metadata": None,
            "created_at": timestamp,
            "updated_at": timestamp,
            "started_at": None,
            "completed_at": None,
            "idempotency_key": key,
            "request_hash": request_hash,
        }
        jobs[job_id] = job
        if key:
            idempotency[key] = job_id
        persist(job)
        tasks[job_id] = asyncio.create_task(run_job(job_id, generation), name=f"h3-job-{job_id}")
        return public_job(job)

    @application.get("/v1/jobs/{job_id}", response_model=JobView, dependencies=[Depends(authorize)])
    async def get_job(job_id: str) -> JobView:
        return public_job(load_job(job_id))

    @application.post("/v1/jobs/{job_id}/cancel", response_model=JobView, dependencies=[Depends(authorize)])
    async def cancel_job(job_id: str) -> JobView:
        job = load_job(job_id)
        if job["status"] not in TERMINAL:
            job.update(status="cancelled", stage="cancelling", progress=None, completed_at=now())
            persist(job)
            task = tasks.get(job_id)
            if task:
                task.cancel()
        return public_job(job)

    @application.get("/v1/jobs/{job_id}/result", dependencies=[Depends(authorize)])
    async def get_result(job_id: str) -> dict[str, Any]:
        job = load_job(job_id)
        if job["status"] != "succeeded":
            raise HTTPException(
                status_code=409, detail={"code": "result_not_ready", "message": "result is not available"}
            )
        return {"id": job_id, "outputs": job["outputs"], "metadata": job["metadata"]}

    @application.get("/v1/jobs/{job_id}/content", dependencies=[Depends(authorize)])
    async def get_content(job_id: str, variant: int = 0):
        job = load_job(job_id)
        if job["status"] != "succeeded" or variant < 0 or variant >= len(job["outputs"]):
            raise HTTPException(
                status_code=409, detail={"code": "result_not_ready", "message": "result is not available"}
            )
        output = job["outputs"][variant]
        local = result_store.local_path(output["storage_key"])
        if local:
            return FileResponse(local, media_type=output["mime_type"], filename=output["filename"])
        return StreamingResponse(
            result_store.stream(output["storage_key"]),
            media_type=output["mime_type"],
            headers={"Content-Disposition": f'attachment; filename="{output["filename"]}"'},
        )

    return application


def _matches_signature(mime_type: str, prefix: bytes) -> bool:
    if mime_type == "video/mp4":
        return len(prefix) >= 8 and prefix[4:8] == b"ftyp"
    if mime_type == "audio/wav":
        return prefix.startswith(b"RIFF") and prefix[8:12] == b"WAVE"
    return any(prefix.startswith(signature) for signature in MIME_SIGNATURES[mime_type])


def _validate_worker_file_uris(generation: GenerateRequest, settings: Settings) -> None:
    payload = generation.model_dump(mode="json")
    allowed = (settings.result_dir / "inputs").resolve()
    total = 0

    def visit(value: Any) -> None:
        nonlocal total
        if isinstance(value, dict):
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)
        elif isinstance(value, str) and value.startswith("file:///"):
            path = Path(url2pathname(unquote(urlparse(value).path))).resolve()
            if allowed not in path.parents or not path.is_file():
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "unsafe_file_uri",
                        "message": "file URI must reference a worker-uploaded asset",
                    },
                )
            total += path.stat().st_size

    visit(payload)
    if total > settings.max_job_input_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "job_inputs_too_large",
                "message": "combined local inputs exceed configured limit",
            },
        )


def _clean_older_than(directory: Path, hours: float) -> None:
    threshold = datetime.now(UTC) - timedelta(hours=hours)
    for child in directory.iterdir() if directory.exists() else ():
        try:
            changed = datetime.fromtimestamp(child.stat().st_mtime, UTC)
            if changed < threshold:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
        except OSError:
            continue


def _note_activity(result_dir: Path) -> None:
    (result_dir / "last-activity").write_text(now(), encoding="utf-8")


app = create_app()
