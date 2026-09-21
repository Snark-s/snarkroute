from pathlib import Path

from ..models import CapabilityName, CapabilityView, GenerateRequest
from .base import BackendOutput, CapabilityUnavailable, ProgressCallback

VDN_SCAFFOLD_REASON = (
    "VDN-H3 adapter scaffold only: its network transport, request/result schema, "
    "progress reporting, cancellation, and non-T2VA modes require validation on "
    "an external OpenVDN deployment"
)


class VDNBackend:
    """Reserved backend boundary; no OpenVDN API contract is assumed here."""

    name = "vdn"
    version = "scaffold"

    def capabilities(self) -> list[CapabilityView]:
        names: tuple[CapabilityName, ...] = (
            "fl2va",
            "ref2va",
            "preview",
            "final",
            "kitchen_int8",
            "video_inpaint",
            "automatic_tracking",
            "resample",
        )
        return [
            CapabilityView(
                name=name,
                available=False,
                experimental=True,
                reason=VDN_SCAFFOLD_REASON,
            )
            for name in names
        ]

    async def ready(self) -> tuple[bool, str | None]:
        return False, VDN_SCAFFOLD_REASON

    async def execute(
        self,
        request: GenerateRequest,
        work_dir: Path,
        progress: ProgressCallback,
    ) -> list[BackendOutput]:
        raise CapabilityUnavailable(request.requested_capability, VDN_SCAFFOLD_REASON)
