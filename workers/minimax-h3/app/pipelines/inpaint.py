from pathlib import Path
from typing import Protocol

INPAINT_STAGES = (
    "decode",
    "track_or_load_mask",
    "stable_crop",
    "encode_latents",
    "masked_h3_sampling",
    "composite",
    "audio_mux",
)


class TrackingAdapter(Protocol):
    """Replaceable boundary for SAM3 or another tracker; no implementation is bundled."""

    name: str
    version: str

    async def track(self, source_video: Path, selected_subject: str, output_mask: Path) -> Path: ...
