import asyncio
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx

from ..config import Settings
from ..models import CapabilityView, GenerateRequest, ResultMetadata
from .base import BackendOutput, ProgressCallback

MODEL_REVISION = "42ed227ee7df40d41602854ae760620d6eb651fe"
SGLANG_COMMIT = "3f26febaff04bac4cfefd60bdc9097bc26a96cb8"


class SGLangBackend:
    name = "sglang"
    version = f"git:{SGLANG_COMMIT}"

    def __init__(self, settings: Settings):
        self.settings = settings

    def capabilities(self) -> list[CapabilityView]:
        variants = self.settings.enabled_variants
        return [
            CapabilityView(name="fl2va", available="fl2va" in variants),
            CapabilityView(name="ref2va", available="ref2va" in variants),
            CapabilityView(
                name="preview",
                available=True,
                experimental=True,
                reason="Turbo LoRA remains optional and separately licensed",
            ),
            CapabilityView(name="final", available=True),
            CapabilityView(
                name="kitchen_int8",
                available=self.settings.sglang_precision_profile == "kitchen_int8",
                experimental=True,
                reason=(
                    "configured; CUDA kernel self-test is mandatory at backend startup; "
                    "end-to-end H3 inference still requires target-GPU verification"
                    if self.settings.sglang_precision_profile == "kitchen_int8"
                    else "optional CUDA/SGLang precision profile is not active"
                ),
            ),
            CapabilityView(
                name="video_inpaint",
                available=False,
                experimental=True,
                reason="Pinned SGLang source exposes Ref2VA, not pixel-aligned latent noise masks",
            ),
            CapabilityView(
                name="automatic_tracking",
                available=False,
                experimental=True,
                reason="No tracking adapter is configured",
            ),
            CapabilityView(
                name="resample",
                available=False,
                experimental=True,
                reason="H3-Regenerate-2K is hosted-only and outside H3-Base",
            ),
        ]

    async def ready(self) -> tuple[bool, str | None]:
        urls = [self.settings.fl2va_url] if self.settings.enabled_variants == {"fl2va"} else []
        if "fl2va" in self.settings.enabled_variants and self.settings.fl2va_url not in urls:
            urls.append(self.settings.fl2va_url)
        if "ref2va" in self.settings.enabled_variants:
            urls.append(self.settings.ref2va_url)
        try:
            async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
                for url in urls:
                    response = await client.get(f"{url}/health")
                    response.raise_for_status()
            return True, None
        except (httpx.HTTPError, OSError) as exc:
            return False, f"SGLang is not ready: {type(exc).__name__}"

    async def execute(
        self, request: GenerateRequest, work_dir: Path, progress: ProgressCallback
    ) -> list[BackendOutput]:
        started = perf_counter()
        upstream = self.settings.ref2va_url if request.task == "ref2va" else self.settings.fl2va_url
        await progress(0.03, "submitting_backend")
        timeout = httpx.Timeout(self.settings.request_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"{upstream}/v1/videos", json=request.sglang_payload())
            response.raise_for_status()
            upstream_id = str(response.json()["id"])
            deadline = asyncio.get_running_loop().time() + (
                request.timeout_seconds or self.settings.job_timeout_seconds
            )
            state: dict[str, Any] = {}
            while True:
                if asyncio.get_running_loop().time() > deadline:
                    raise TimeoutError("SGLang generation timed out")
                await asyncio.sleep(self.settings.poll_interval_seconds)
                state_response = await client.get(f"{upstream}/v1/videos/{upstream_id}")
                state_response.raise_for_status()
                state = state_response.json()
                status = str(state.get("status", "")).lower()
                if status in {"failed", "error"}:
                    raise RuntimeError("SGLang generation failed")
                if status in {"cancelled", "canceled"}:
                    raise asyncio.CancelledError
                if status in {"completed", "succeeded"}:
                    break
                raw_progress = state.get("progress")
                normalized = float(raw_progress) if isinstance(raw_progress, int | float) else 0.05
                await progress(max(0.05, min(normalized, 0.85)), "generating")

            outputs: list[BackendOutput] = []
            for index in range(request.num_outputs_per_prompt):
                suffix = f"?variant={index}" if request.num_outputs_per_prompt > 1 else ""
                path = work_dir / f"variant-{index}.mp4"
                async with client.stream(
                    "GET", f"{upstream}/v1/videos/{upstream_id}/content{suffix}", timeout=None
                ) as content:
                    content.raise_for_status()
                    with path.open("wb") as stream:
                        async for chunk in content.aiter_bytes():
                            stream.write(chunk)
                metadata = _metadata(
                    request,
                    state,
                    path.stat().st_size,
                    perf_counter() - started,
                    self.settings.sglang_precision_profile,
                )
                outputs.append(BackendOutput(path, f"h3-{upstream_id}-{index}.mp4", "video/mp4", metadata))
        await progress(0.9, "persisting_result")
        return outputs


def _metadata(
    request: GenerateRequest,
    state: dict[str, Any],
    size: int,
    elapsed: float,
    precision_profile: str,
) -> ResultMetadata:
    upstream = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
    return ResultMetadata(
        backend="sglang",
        backend_version=f"git:{SGLANG_COMMIT}",
        model_revision=MODEL_REVISION,
        variant="ref2va" if request.task == "ref2va" else "fl2va",
        gpu=upstream.get("gpu"),
        vram_gib=upstream.get("vram_gib"),
        resolution=upstream.get("resolution")
        or (f"short-edge:{request.target.short_edge}" if request.target else None),
        frames=upstream.get("frames"),
        duration_seconds=request.target.duration_seconds if request.target else None,
        steps=request.num_inference_steps or (8 if request.quality_mode == "preview" else 30),
        seed=request.seed,
        quantization=upstream.get("quantization")
        or ("kitchen_int8" if precision_profile == "kitchen_int8" else None),
        attention_backend=upstream.get("attention_backend"),
        lora={"enabled": request.turbo_lora, "strength": request.lora_scale} if request.turbo_lora else None,
        render_time_seconds=elapsed,
        peak_vram_gib=upstream.get("peak_vram_gib"),
        input_bytes=int(upstream.get("input_bytes") or 0),
        output_bytes=size,
        verified_gpu_inference=True,
    )
