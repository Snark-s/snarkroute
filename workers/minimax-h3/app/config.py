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
    matlow_profile: str
    matlow_comfyui_dir: Path
    matlow_transformer_file: Path
    matlow_10eros_max_file: Path
    matlow_10eros_max_turbo_file: Path
    matlow_text_encoder_file: Path
    matlow_video_vae_file: Path
    matlow_audio_vae_file: Path
    matlow_native_audio: bool
    matlow_max_swap_gib: float
    matlow_vae_tile_size: int
    matlow_vae_tile_overlap: int
    matlow_vram_headroom_gib: float
    matlow_memory_mode: str
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
        if backend not in {"mock", "sglang", "matlow_int8", "diffusers", "vdn"}:
            raise RuntimeError("H3_BACKEND must be mock, sglang, matlow_int8, diffusers, or vdn")
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
        matlow_profile = os.getenv("H3_MATLOW_PROFILE", "local_fast").strip().lower()
        if matlow_profile != "local_fast":
            raise RuntimeError("H3_MATLOW_PROFILE must be local_fast; local_quality is not GPU-validated")
        matlow_memory_mode = os.getenv("H3_MATLOW_MEMORY_MODE", "dynamic").strip().lower()
        if matlow_memory_mode not in {"normal", "novram", "dynamic"}:
            raise RuntimeError("H3_MATLOW_MEMORY_MODE must be normal, novram, or dynamic")
        matlow_vae_tile_size = int(_positive_number("H3_MATLOW_VAE_TILE_SIZE", "256", integer=True))
        matlow_vae_tile_overlap = int(_positive_number("H3_MATLOW_VAE_TILE_OVERLAP", "64", integer=True))
        if matlow_vae_tile_size % 16 or matlow_vae_tile_overlap % 16:
            raise RuntimeError("H3 MATLOW VAE tile size and overlap must be multiples of 16")
        if matlow_vae_tile_overlap >= matlow_vae_tile_size:
            raise RuntimeError("H3_MATLOW_VAE_TILE_OVERLAP must be smaller than the tile size")
        matlow_root = Path(
            os.getenv(
                "H3_MATLOW_MODEL_ROOT",
                "/home/serge/h3/models",
            )
        )
        return cls(
            service_token=os.getenv("H3_WORKER_SERVICE_TOKEN", "").strip(),
            backend=backend,
            enabled_variants=variants,
            fl2va_url=os.getenv("SGLANG_FL2VA_URL", "http://h3-fl2va:30010").rstrip("/"),
            ref2va_url=os.getenv("SGLANG_REF2VA_URL", "http://h3-ref2va:30011").rstrip("/"),
            sglang_precision_profile=precision_profile,
            matlow_profile=matlow_profile,
            matlow_comfyui_dir=Path(
                os.getenv("H3_MATLOW_COMFYUI_DIR", "/home/serge/h3/runtime/comfyui-core")
            ).resolve(),
            matlow_transformer_file=Path(
                os.getenv(
                    "H3_MATLOW_TRANSFORMER_FILE",
                    str(
                        matlow_root
                        / "MATLOWAI/minimax-h3-fused-turbo-int8-convrot/diffusion_models"
                        / "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors"
                    ),
                )
            ).resolve(),
            matlow_10eros_max_file=Path(
                os.getenv(
                    "H3_MATLOW_10EROS_MAX_FILE",
                    str(
                        matlow_root
                        / "TenStrip/10Eros-Max"
                        / "10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors"
                    ),
                )
            ).resolve(),
            matlow_10eros_max_turbo_file=Path(
                os.getenv(
                    "H3_MATLOW_10EROS_MAX_TURBO_FILE",
                    str(
                        matlow_root
                        / "TenStrip/10Eros-Max"
                        / "10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors"
                    ),
                )
            ).resolve(),
            matlow_text_encoder_file=Path(
                os.getenv(
                    "H3_MATLOW_TEXT_ENCODER_FILE",
                    str(
                        matlow_root
                        / "Comfy-Org/MiniMax-H3/text_encoders"
                        / "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
                    ),
                )
            ).resolve(),
            matlow_video_vae_file=Path(
                os.getenv(
                    "H3_MATLOW_VIDEO_VAE_FILE",
                    str(
                        matlow_root
                        / "Kijai/MiniMax-H3-experimental"
                        / "minimax_h3_video_vae_int8_convrot.safetensors"
                    ),
                )
            ).resolve(),
            matlow_audio_vae_file=Path(
                os.getenv(
                    "H3_MATLOW_AUDIO_VAE_FILE",
                    str(matlow_root / "Comfy-Org/MiniMax-H3/vae" / "minimax_h3_audio_vae_fp32.safetensors"),
                )
            ).resolve(),
            matlow_native_audio=os.getenv("H3_MATLOW_NATIVE_AUDIO", "1").strip().lower()
            in {"1", "true", "yes", "on"},
            matlow_max_swap_gib=float(_positive_number("H3_MATLOW_MAX_SWAP_GIB", "12")),
            matlow_vae_tile_size=matlow_vae_tile_size,
            matlow_vae_tile_overlap=matlow_vae_tile_overlap,
            matlow_vram_headroom_gib=float(_positive_number("H3_MATLOW_VRAM_HEADROOM_GIB", "2")),
            matlow_memory_mode=matlow_memory_mode,
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
