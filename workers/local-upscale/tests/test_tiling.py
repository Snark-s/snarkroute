from __future__ import annotations

import numpy as np

from app.tiling import tile_positions, tiled_inference


def test_non_divisible_tiles_stitch_without_seams():
    image = np.arange(37 * 53 * 3, dtype=np.float32).reshape(37, 53, 3)
    image /= image.max()
    result = tiled_inference(image, 2, 19, 6, lambda tile: np.repeat(np.repeat(tile, 2, axis=0), 2, axis=1))
    expected = np.repeat(np.repeat(image, 2, axis=0), 2, axis=1)
    assert result.shape == (74, 106, 3)
    assert np.allclose(result, expected, atol=1e-6)


def test_tile_positions_cover_small_and_irregular_images():
    assert tile_positions(10, 64, 8) == [0]
    positions = tile_positions(301, 128, 24)
    assert positions[0] == 0
    assert positions[-1] == 173
