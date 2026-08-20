from __future__ import annotations

from collections.abc import Callable

import numpy as np

from app.errors import WorkerError

Progress = Callable[[float], None]
Cancelled = Callable[[], bool]
TileRunner = Callable[[np.ndarray], np.ndarray]


def tiled_inference(
    image: np.ndarray,
    scale: int,
    tile_size: int,
    overlap: int,
    run_tile: TileRunner,
    progress: Progress | None = None,
    cancelled: Cancelled | None = None,
) -> np.ndarray:
    if image.ndim != 3 or image.shape[2] != 3:
        raise WorkerError("invalid_input", "Tiled inference requires an RGB image.")
    if scale < 1 or tile_size < 16 or overlap < 0 or overlap >= tile_size:
        raise WorkerError("invalid_parameters", "tile_size must be >= 16 and tile_overlap must be smaller than tile_size.")
    height, width = image.shape[:2]
    x_positions = tile_positions(width, tile_size, overlap)
    y_positions = tile_positions(height, tile_size, overlap)
    output = np.zeros((height * scale, width * scale, 3), dtype=np.float32)
    weights = np.zeros((height * scale, width * scale, 1), dtype=np.float32)
    total = len(x_positions) * len(y_positions)
    completed = 0
    for yi, y in enumerate(y_positions):
        for xi, x in enumerate(x_positions):
            if cancelled and cancelled():
                raise WorkerError("cancelled", "Upscale job was cancelled.")
            tile = image[y : min(y + tile_size, height), x : min(x + tile_size, width)]
            enhanced = np.asarray(run_tile(tile), dtype=np.float32)
            expected = (tile.shape[0] * scale, tile.shape[1] * scale, 3)
            if enhanced.shape != expected:
                raise WorkerError("runtime_output_invalid", f"Model returned {enhanced.shape}; expected {expected}.")
            weight = tile_weight(xi, yi, x_positions, y_positions, tile.shape[1], tile.shape[0], scale)
            out_x, out_y = x * scale, y * scale
            output[out_y : out_y + enhanced.shape[0], out_x : out_x + enhanced.shape[1]] += enhanced * weight
            weights[out_y : out_y + enhanced.shape[0], out_x : out_x + enhanced.shape[1]] += weight
            completed += 1
            if progress:
                progress(completed / total)
    return np.clip(output / np.maximum(weights, 1e-8), 0.0, 1.0)


def tile_positions(length: int, tile_size: int, overlap: int) -> list[int]:
    if length <= tile_size:
        return [0]
    step = tile_size - overlap
    positions = list(range(0, max(1, length - tile_size + 1), step))
    final = length - tile_size
    if positions[-1] != final:
        positions.append(final)
    return positions


def tile_weight(
    xi: int,
    yi: int,
    xs: list[int],
    ys: list[int],
    width: int,
    height: int,
    scale: int,
) -> np.ndarray:
    x_weight = axis_weight(width * scale, _left_overlap(xi, xs, width) * scale, _right_overlap(xi, xs, width) * scale)
    y_weight = axis_weight(height * scale, _left_overlap(yi, ys, height) * scale, _right_overlap(yi, ys, height) * scale)
    return (y_weight[:, None] * x_weight[None, :])[:, :, None]


def axis_weight(length: int, left: int, right: int) -> np.ndarray:
    weight = np.ones(length, dtype=np.float32)
    if left:
        weight[:left] = np.linspace(1.0 / (left + 1), 1.0, left, dtype=np.float32)
    if right:
        weight[-right:] = np.minimum(weight[-right:], np.linspace(1.0, 1.0 / (right + 1), right, dtype=np.float32))
    return weight


def _left_overlap(index: int, positions: list[int], tile_length: int) -> int:
    return 0 if index == 0 else max(0, positions[index - 1] + tile_length - positions[index])


def _right_overlap(index: int, positions: list[int], tile_length: int) -> int:
    return 0 if index + 1 == len(positions) else max(0, positions[index] + tile_length - positions[index + 1])
