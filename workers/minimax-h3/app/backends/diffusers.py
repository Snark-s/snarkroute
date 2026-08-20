from pathlib import Path

from ..models import CapabilityView, GenerateRequest
from .base import BackendOutput, CapabilityUnavailable, ProgressCallback


class DiffusersBackend:
    name = "diffusers"
    version = "f53d552036a0d1bd5570782a39cd40cfabf112bc"

    def capabilities(self) -> list[CapabilityView]:
        reason = "Backend adapter is isolated but GPU loading has not been implemented or validated"
        return [
            CapabilityView(name="fl2va", available=False, experimental=True, reason=reason),
            CapabilityView(name="ref2va", available=False, experimental=True, reason=reason),
            CapabilityView(name="preview", available=False, experimental=True, reason=reason),
            CapabilityView(name="final", available=False, experimental=True, reason=reason),
            CapabilityView(
                name="video_inpaint",
                available=False,
                experimental=True,
                reason="Merged Modular Diffusers H3 blocks do not expose a noise-mask workflow",
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
                reason="Open H3-Regenerate-2K weights are unavailable",
            ),
        ]

    async def ready(self) -> tuple[bool, str | None]:
        return (
            False,
            "Diffusers backend is a reserved integration boundary, not an implemented inference path",
        )

    async def execute(
        self, request: GenerateRequest, work_dir: Path, progress: ProgressCallback
    ) -> list[BackendOutput]:
        raise CapabilityUnavailable(request.requested_capability, "Diffusers H3 execution is not implemented")
