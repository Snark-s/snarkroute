"""Known-answer CPU measurements; synthetic fixtures are not H3 render evidence."""
import json
import math

import pytest
import torch

from app.backends.h3_latent_metrics import measure_video


def gray_frames(values, height=4, width=4):
    return torch.tensor(values, dtype=torch.float32)[:, None, None, None].expand(
        -1, height, width, 3
    ).clone()


def linear_gray(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def test_reports_known_linear_brightness_and_drift_with_equal_analysis_windows():
    frames = gray_frames([0.5] * 5 + [0.75] * 3)
    report = measure_video(frames, [5], window_frames=4)
    first, second = report["segments"]
    assert report["analysis_frames_per_segment"] == 3
    assert first["analysis_start_frame"] == 0
    assert second["analysis_start_frame"] == 5
    assert first["median_linear_luma"] == pytest.approx(linear_gray(0.5), abs=1e-6)
    assert first["p05_linear_luma"] == pytest.approx(first["median_linear_luma"])
    assert first["p95_linear_luma"] == pytest.approx(first["median_linear_luma"])
    assert second["drift_from_initial"]["median_linear_luma_delta"] == pytest.approx(
        linear_gray(0.75) - linear_gray(0.5), abs=1e-6
    )
    assert first["mean_hsv_saturation"] == 0.0
    assert first["local_contrast_std"] == pytest.approx(0.0, abs=1e-7)
    seam = report["seams"][0]
    assert seam["rgb_mae"] == pytest.approx(0.25)
    assert seam["linear_luma_jump"] == pytest.approx(
        linear_gray(0.75) - linear_gray(0.5), abs=1e-6
    )
    assert seam["relative_rgb_mae_valid"] is False
    json.dumps(report, allow_nan=False)


def test_rec709_weights_and_hsv_saturation():
    frames = torch.zeros((4, 3, 3, 3))
    frames[:2, ..., 0] = 1.0
    frames[2:, ..., 1] = 1.0
    report = measure_video(frames, [2], window_frames=2)
    assert report["segments"][0]["median_linear_luma"] == pytest.approx(0.2126)
    assert report["segments"][1]["median_linear_luma"] == pytest.approx(0.7152)
    assert report["segments"][0]["mean_hsv_saturation"] == 1.0


def test_spatial_percentiles_and_texture_contrast():
    linear = torch.tensor([[0.04, 0.1], [0.3, 0.8]])
    encoded = torch.where(linear <= 0.0031308, 12.92 * linear,
                          1.055 * linear.pow(1 / 2.4) - 0.055)
    frames = encoded[None, ..., None].expand(2, -1, -1, 3).clone()
    segment = measure_video(frames, [], window_frames=2)["segments"][0]
    assert segment["p05_linear_luma"] == pytest.approx(0.049, abs=1e-6)
    assert segment["median_linear_luma"] == pytest.approx(0.2, abs=1e-6)
    assert segment["p95_linear_luma"] == pytest.approx(0.725, abs=1e-6)
    assert segment["local_contrast_std"] > 0.1


def test_seam_relative_mae_excludes_the_join_and_respects_neighbor_segments():
    frames = gray_frames([0.1, 0.2, 0.3, 0.6, 0.7, 0.8])
    seam = measure_video(frames, [3], window_frames=3)["seams"][0]
    assert seam["typical_neighbor_rgb_mae"] == pytest.approx(0.1, abs=1e-6)
    assert seam["relative_rgb_mae_valid"] is True
    assert seam["rgb_mae_over_typical"] == pytest.approx(3.0, abs=1e-5)
    assert seam["neighbor_frame_pair_count"] == 4


def test_audio_silence_produces_finite_json_and_unavailable_correlation():
    report = measure_video(gray_frames([0.5] * 8), [4], audio=torch.zeros(1, 2, 800),
                           audio_sample_rate=2400, audio_window_seconds=0.1)
    seam = report["seams"][0]["audio"]
    assert seam["boundary_sample"] == 400
    assert seam["normalized_seam_jump"] == 0.0
    assert seam["normalized_seam_jump_valid"] is False
    assert seam["window_xcorr"]["valid"] is False
    assert seam["window_xcorr"]["max_correlation"] == 0.0
    json.dumps(report, allow_nan=False)


def test_audio_step_is_measured_without_inventing_a_correlation():
    waveform = torch.cat((torch.zeros(2, 300), torch.ones(2, 300)), dim=-1)
    seam = measure_video(gray_frames([0.5] * 6), [3], fps=10, audio=waveform,
                         audio_sample_rate=1000, audio_window_seconds=0.1,
                         max_audio_lag_ms=3)["seams"][0]["audio"]
    assert seam["seam_derivative_rms"] == 1.0
    assert seam["normalized_seam_jump"] == pytest.approx(math.sqrt(2))
    assert seam["normalized_seam_jump_valid"] is True
    assert seam["nearby_derivative_rms"] == 0.0
    assert seam["window_xcorr"]["valid"] is False


def test_audio_contiguous_periodic_windows_have_known_xcorr_and_keep_stereo():
    signal = torch.sin(torch.arange(600, dtype=torch.float64) * (2 * math.pi / 10))
    waveform = torch.stack((signal, -signal)).unsqueeze(0)
    report = measure_video(gray_frames([0.5] * 6), [3], fps=10,
                           audio={"waveform": waveform, "sample_rate": 1000},
                           audio_window_seconds=0.1, max_audio_lag_ms=3)
    xcorr = report["seams"][0]["audio"]["window_xcorr"]
    assert xcorr["valid"] is True
    assert xcorr["max_correlation"] == pytest.approx(1.0, abs=1e-8)
    assert xcorr["lag_samples"] == 0
    assert xcorr["lag_ms"] == 0.0
    json.dumps(report, allow_nan=False)


def test_boundary_endpoints_are_accepted_but_only_internal_seams_are_measured():
    report = measure_video(gray_frames([0.5] * 8), [0, 4, 8])
    assert report["boundaries"] == [4]
    assert len(report["segments"]) == 2
    assert len(report["seams"]) == 1


@pytest.mark.parametrize("boundaries", [[4, 3], [4, 4], [-1], [9], [1.5], [True]])
def test_invalid_boundaries_are_rejected(boundaries):
    with pytest.raises(ValueError, match="boundaries"):
        measure_video(gray_frames([0.5] * 8), boundaries)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -0.01, 1.01])
def test_invalid_pixel_values_are_rejected(value):
    frames = gray_frames([0.5] * 4)
    frames[0, 0, 0, 0] = value
    with pytest.raises(ValueError, match="finite|\\[0, 1\\]"):
        measure_video(frames, [2])


def test_invalid_or_short_audio_is_rejected_instead_of_skipped():
    frames = gray_frames([0.5] * 8)
    with pytest.raises(ValueError, match="sample rate"):
        measure_video(frames, [4], audio=torch.zeros(100))
    with pytest.raises(ValueError, match="audio.*boundary|audio.*window"):
        measure_video(frames, [4], audio=torch.zeros(10), audio_sample_rate=2400)
    with pytest.raises(ValueError, match="finite"):
        measure_video(frames, [4], audio=torch.full((800,), float("nan")),
                      audio_sample_rate=2400)
