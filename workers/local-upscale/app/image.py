from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError

from app.errors import WorkerError
from app.registry import UpscaleModel
from app.runtime import ImageRuntime
from app.tiling import tiled_inference


def process_image(
    input_path: Path,
    output_path: Path,
    model: UpscaleModel,
    runtime: ImageRuntime,
    tile_size: int,
    tile_overlap: int,
    max_input_pixels: int,
    progress: Callable[[float], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, int | str]:
    try:
        with Image.open(input_path) as source:
            if source.format not in {"PNG", "JPEG"}:
                raise WorkerError("invalid_input", "Only PNG and JPEG inputs are supported.")
            if source.width * source.height > max_input_pixels:
                raise WorkerError("input_too_large", f"Input exceeds the {max_input_pixels}-pixel safety limit.")
            source.load()
            icc_profile = source.info.get("icc_profile")
            has_alpha = source.mode in {"RGBA", "LA"} or "transparency" in source.info
            rgba = source.convert("RGBA") if has_alpha else None
            rgb = (rgba or source).convert("RGB")
            alpha = rgba.getchannel("A") if rgba else None
            pixels = np.asarray(rgb, dtype=np.float32) / 255.0
    except UnidentifiedImageError as exc:
        raise WorkerError("invalid_input", "Input is not a valid PNG or JPEG image.") from exc

    enhanced = tiled_inference(
        pixels,
        model.scale_factor,
        tile_size,
        tile_overlap,
        runtime.infer,
        progress=progress,
        cancelled=cancelled,
    )
    rgb_out = Image.fromarray(np.clip(enhanced * 255.0 + 0.5, 0, 255).astype(np.uint8))
    if alpha is not None:
        alpha_out = alpha.resize(rgb_out.size, Image.Resampling.LANCZOS)
        result = rgb_out.convert("RGBA")
        result.putalpha(alpha_out)
    else:
        result = rgb_out
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_options = {"format": "PNG", "compress_level": 6}
    if icc_profile:
        save_options["icc_profile"] = icc_profile
    result.save(output_path, **save_options)
    return {
        "filename": output_path.name,
        "mime_type": "image/png",
        "width": result.width,
        "height": result.height,
        "bytes": output_path.stat().st_size,
    }
