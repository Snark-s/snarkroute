import os
from dataclasses import dataclass
from pathlib import Path


def _positive_number(name: str, default: str, *, integer: bool = False) -> float | int:
    raw = os.getenv(name, default)
    try:
        value = int(raw) if integer else float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive number") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return value


@dataclass(frozen=True)
class Settings:
    service_token: str
    backend: str
    enabled_variants: frozenset[str]
    fl2va_url: str
    ref2va_url: str
    sglang_precision_profile: str
    result_dir: Path
    temp_dir: Path
    model_dir: Path
    storage_backend: str
    s3_endpoint_url: str | None
    s3_region: str | None
    s3_bucket: str | None
    s3_prefix: str
    request_timeout_seconds: float
    poll_interval_seconds: float
    job_timeout_seconds: float
    max_request_bytes: int
    max_upload_bytes: int
    max_job_input_bytes: int
    result_retention_hours: float
    temp_retention_hours: float
    idle_shutdown_minutes: float

    @classmethod
    def from_env(cls) -> "Settings":
        backend = os.getenv("H3_BACKEND", "mock").strip().lower()
        if backend not in {"mock", "sglang", "diffusers"}:
            raise RuntimeError("H3_BACKEND must be mock, sglang, or diffusers")
        variants = frozenset(
            value.strip().lower()
            for value in os.getenv("H3_ENABLED_VARIANTS", "fl2va").split(",")
            if value.strip()
        )
        if not variants or not variants.issubset({"fl2va", "ref2va"}):
            raise RuntimeError("H3_ENABLED_VARIANTS must contain fl2va and/or ref2va")
        storage_backend = os.getenv("H3_STORAGE_BACKEND", "local").strip().lower()
        if storage_backend not in {"local", "s3"}:
            raise RuntimeError("H3_STORAGE_BACKEND must be local or s3")
        precision_profile = os.getenv("H3_SGLANG_PRECISION_PROFILE", "bf16_offload").strip().lower()
        if precision_profile not in {"bf16_offload", "kitchen_int8"}:
            raise RuntimeError("H3_SGLANG_PRECISION_PROFILE must be bf16_offload or kitchen_int8")
        return cls(
            service_token=os.getenv("H3_WORKER_SERVICE_TOKEN", "").strip(),
            backend=backend,
            enabled_variants=variants,
            fl2va_url=os.getenv("SGLANG_FL2VA_URL", "http://h3-fl2va:30010").rstrip("/"),
            ref2va_url=os.getenv("SGLANG_REF2VA_URL", "http://h3-ref2va:30011").rstrip("/"),
            sglang_precision_profile=precision_profile,
            result_dir=Path(os.getenv("H3_RESULT_DIR", "/data/results")).resolve(),
            temp_dir=Path(os.getenv("H3_TEMP_DIR", "/data/tmp")).resolve(),
            model_dir=Path(os.getenv("H3_MODEL_DIR", "/models")).resolve(),
            storage_backend=storage_backend,
            s3_endpoint_url=os.getenv("H3_S3_ENDPOINT_URL") or None,
            s3_region=os.getenv("H3_S3_REGION") or None,
            s3_bucket=os.getenv("H3_S3_BUCKET") or None,
            s3_prefix=os.getenv("H3_S3_PREFIX", "h3-results").strip("/"),
            request_timeout_seconds=float(_positive_number("H3_UPSTREAM_REQUEST_TIMEOUT_SECONDS", "30")),
            poll_interval_seconds=float(_positive_number("H3_POLL_INTERVAL_SECONDS", "2")),
            job_timeout_seconds=float(_positive_number("H3_JOB_TIMEOUT_SECONDS", "3600")),
            max_request_bytes=int(
                _positive_number("H3_MAX_REQUEST_BYTES", str(2 * 1024 * 1024), integer=True)
            ),
            max_upload_bytes=int(
                _positive_number("H3_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024), integer=True)
            ),
            max_job_input_bytes=int(
                _positive_number("H3_MAX_JOB_INPUT_BYTES", str(500 * 1024 * 1024), integer=True)
            ),
            result_retention_hours=float(_positive_number("H3_RESULT_RETENTION_HOURS", "168")),
            temp_retention_hours=float(_positive_number("H3_TEMP_RETENTION_HOURS", "24")),
            idle_shutdown_minutes=float(_positive_number("H3_IDLE_SHUTDOWN_MINUTES", "20")),
        )
