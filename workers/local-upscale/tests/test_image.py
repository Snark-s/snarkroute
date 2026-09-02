from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from app.image import process_image
from app.registry import ModelRegistry
from app.runtime import MockRuntime


def test_rgba_alpha_is_preserved_and_output_is_lossless_png(tmp_path: Path):
    source = np.zeros((5, 7, 4), dtype=np.uint8)
    source[:, :, :3] = [12, 34, 56]
    source[:, :, 3] = np.arange(35, dtype=np.uint8).reshape(5, 7) * 7
    input_path, output_path = tmp_path / "input.png", tmp_path / "output.png"
    Image.fromarray(source).save(input_path)
    model = ModelRegistry.load().get("4x-realesrgan-x4plus-anime-6b")
    metadata = process_image(input_path, output_path, model, MockRuntime(4), 16, 4, 1000)
    with Image.open(output_path) as result:
        assert result.format == "PNG"
        assert result.mode == "RGBA"
        assert result.size == (28, 20)
        assert result.getchannel("A").getextrema() != (255, 255)
    assert metadata["mime_type"] == "image/png"
