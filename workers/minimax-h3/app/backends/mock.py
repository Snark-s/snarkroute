import asyncio
import json
from pathlib import Path
from time import perf_counter

from ..models import CapabilityView, GenerateRequest, ResultMetadata
from .base import BackendOutput, ProgressCallback


class MockBackend:
    name = "mock"
    version = "1"

    def __init__(self, enabled_variants: frozenset[str]):
        self.enabled_variants = enabled_variants

    def capabilities(self) -> list[CapabilityView]:
        return [
            CapabilityView(
                name="fl2va",
                available="fl2va" in self.enabled_variants,
                experimental=True,
                reason="mock contract only; no inference",
            ),
            CapabilityView(
                name="ref2va",
                available="ref2va" in self.enabled_variants,
                experimental=True,
                reason="mock contract only; no inference",
            ),
            CapabilityView(
                name="preview", available=True, experimental=True, reason="mock contract only; no inference"
            ),
            CapabilityView(
                name="final", available=True, experimental=True, reason="mock contract only; no inference"
            ),
            CapabilityView(
                name="video_inpaint",
                available=False,
                experimental=True,
                reason="No native noise-mask backend is implemented",
            ),
            CapabilityView(
                name="automatic_tracking",
                available=False,
                experimental=True,
                reason="Tracking adapter is not configured",
            ),
            CapabilityView(
                name="resample",
                available=False,
                experimental=True,
                reason="Open H3-Regenerate-2K weights are unavailable",
            ),
        ]

    async def ready(self) -> tuple[bool, str | None]:
        return True, "mock backend; contract checks only"

    async def execute(
        self, request: GenerateRequest, work_dir: Path, progress: ProgressCallback
    ) -> list[BackendOutput]:
        started = perf_counter()
        await progress(0.25, "mock_preparing")
        await asyncio.sleep(0.01)
        outputs: list[BackendOutput] = []
        for index in range(request.num_outputs_per_prompt):
            payload = {
                "mock": True,
                "notice": "This is not a generated video and must never be presented as inference.",
                "request": request.model_dump(
                    mode="json", exclude={"prompt", "conditions", "inpaint", "resample"}
                ),
                "index": index,
            }
            path = work_dir / f"mock-variant-{index}.mp4"
            path.write_bytes(b"SNARKROUTE-H3-MOCK\n" + json.dumps(payload, sort_keys=True).encode("utf-8"))
            size = path.stat().st_size
            outputs.append(
                BackendOutput(
                    path=path,
                    filename=f"h3-mock-{index}.mp4",
                    mime_type="video/mp4",
                    metadata=ResultMetadata(
                        backend=self.name,
                        backend_version=self.version,
                        model_revision="not-loaded",
                        variant="ref2va" if request.task == "ref2va" else "fl2va",
                        resolution="mock",
                        duration_seconds=request.target.duration_seconds if request.target else None,
                        steps=request.num_inference_steps,
                        seed=request.seed,
                        render_time_seconds=perf_counter() - started,
                        output_bytes=size,
                        verified_gpu_inference=False,
                    ),
                )
            )
        await progress(0.9, "mock_complete")
        return outputs
