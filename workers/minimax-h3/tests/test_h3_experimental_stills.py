"""CPU-safe checks for optional H3 stills and X2 VAE geometry."""
from types import SimpleNamespace
import pytest
from app.backends.h3_experimental_stills import x2_decoder_geometry


@pytest.mark.parametrize(("channels", "factor"), [(3, 1), (12, 2)])
def test_supported_projection(channels, factor):
    decoder = SimpleNamespace(
        patch_size_t=1, patch_size=2,
        proj_out=SimpleNamespace(weight=SimpleNamespace(shape=(4 * channels, 100))),
    )
    assert x2_decoder_geometry(decoder) == (channels, factor)


@pytest.mark.parametrize("channels", [4, 6, 15, 27])
def test_reject_bad_projection(channels):
    decoder = SimpleNamespace(
        patch_size_t=1, patch_size=2,
        proj_out=SimpleNamespace(weight=SimpleNamespace(shape=(4 * channels, 100))),
    )
    with pytest.raises(ValueError):
        x2_decoder_geometry(decoder)
