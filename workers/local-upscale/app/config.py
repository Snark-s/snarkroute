from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    service_token: str
    runtime_override: str
    model_dir: Path
    data_dir: Path
    job_timeout_seconds: float
    max_upload_bytes: int
    max_input_pixels: int

    @classmethod
    def from_env(cls) -> Settings:
        runtime = os.getenv("LOCAL_UPSCALE_RUNTIME", "auto").strip().lower()
        if runtime not in {"pytorch", "onnxruntime", "mock", "auto"}:
            raise RuntimeError("LOCAL_UPSCALE_RUNTIME must be pytorch, onnxruntime, mock, or auto")
        return cls(
            service_token=os.getenv("LOCAL_UPSCALE_WORKER_TOKEN", "").strip(),
            runtime_override=runtime,
            model_dir=Path(os.getenv("LOCAL_UPSCALE_MODEL_DIR", "./models")).resolve(),
            data_dir=Path(os.getenv("LOCAL_UPSCALE_DATA_DIR", "./data")).resolve(),
            job_timeout_seconds=_positive_float("LOCAL_UPSCALE_JOB_TIMEOUT_SECONDS", 1800),
            max_upload_bytes=_positive_int("LOCAL_UPSCALE_MAX_UPLOAD_BYTES", 100 * 1024 * 1024),
            max_input_pixels=_positive_int("LOCAL_UPSCALE_MAX_INPUT_PIXELS", 8192 * 8192),
        )


def _positive_float(name: str, fallback: float) -> float:
    try:
        value = float(os.getenv(name, str(fallback)))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive number") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return value


def _positive_int(name: str, fallback: int) -> int:
    value = _positive_float(name, fallback)
    if not value.is_integer():
        raise RuntimeError(f"{name} must be an integer")
    return int(value)
