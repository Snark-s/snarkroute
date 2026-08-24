from __future__ import annotations

import numpy as np

from app.video_pipeline import _center_context_window
from app.video_runtime import prepare_tscunet_input


def _frame(value: int) -> np.ndarray:
    return np.full((7, 9, 3), value, dtype=np.uint8)


def test_center_context_repeats_video_edges_without_losing_core_frames() -> None:
    frames = [_frame(index) for index in range(4)]

    first = _center_context_window(frames, center=0, context_frames=5)
    last = _center_context_window(frames, center=3, context_frames=5)

    assert [int(frame[0, 0, 0]) for frame in first] == [0, 0, 0, 1, 2]
    assert [int(frame[0, 0, 0]) for frame in last] == [1, 2, 3, 3, 3]


def test_tscunet_input_flattens_five_rgb_frames_and_pads_to_64() -> None:
    value, original_size = prepare_tscunet_input([_frame(index) for index in range(5)])

    assert value.shape == (1, 15, 64, 64)
    assert value.dtype == np.float32
    assert original_size == (7, 9)
    assert np.allclose(value[0, 0:3, :7, :9], 0)
    assert np.allclose(value[0, 12:15, :7, :9], 4 / 255)
