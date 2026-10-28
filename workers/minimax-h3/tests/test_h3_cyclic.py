"""CPU-level checks for H3 circular-mode frame and audio scheduling."""
import pytest

from app.backends.h3_cyclic import audio_latents, loop_frame_count


@pytest.mark.parametrize("duration,frames", [
    (4, 107),
    (4.25, 107),
    (5, 124),
    (6.4, 158),
    (8.5, 209),
    (10, 243),
    (12.75, 311),
])
def test_loop_frame_count(duration, frames):
    assert loop_frame_count(duration) == frames
    assert (frames - 5) % 17 == 0


def test_loop_rejects_oversized_input():
    with pytest.raises(ValueError, match="12.75"):
        loop_frame_count(13)


def test_audio_span_is_aligned_to_24_fps_40_latents_per_sec():
    assert audio_latents(6) == 170
    assert audio_latents(1) == 28
