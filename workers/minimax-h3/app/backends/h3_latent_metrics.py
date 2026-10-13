"""CPU measurements for decoded H3 experiments, with explicit measurement units.

These measurements describe brightness, texture, and transitions. They do not
prove semantic quality, continuation identity, or that an H3 render succeeded.
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

import torch
import torch.nn.functional as functional

_EPS = 1e-12
_SEGMENT_MEASURES = (
    "median_linear_luma", "p05_linear_luma", "p95_linear_luma",
    "local_contrast_std", "mean_hsv_saturation",
)


def _linear_luma(frame: torch.Tensor) -> torch.Tensor:
    # Decoded display RGB is treated as sRGB; luma uses Rec.709 primaries.
    rgb = frame.detach().to(device="cpu", dtype=torch.float32)
    linear = torch.where(rgb <= 0.04045, rgb / 12.92,
                         ((rgb + 0.055) / 1.055).pow(2.4))
    return linear[..., 0] * 0.2126 + linear[..., 1] * 0.7152 + linear[..., 2] * 0.0722


def _spatial_quantiles(luma: torch.Tensor) -> list[float]:
    flat = luma.flatten()
    if flat.numel() <= 2**24:
        return torch.quantile(flat, torch.tensor([0.05, 0.5, 0.95])).tolist()
    # torch.quantile has a 2**24 input-size limit; exact order statistics avoid it.
    out = []
    for probability in (0.05, 0.5, 0.95):
        rank = probability * (flat.numel() - 1)
        low, high = math.floor(rank), math.ceil(rank)
        a = float(flat.kthvalue(low + 1).values)
        b = a if low == high else float(flat.kthvalue(high + 1).values)
        out.append(a + (b - a) * (rank - low))
    return out


def _frame_measures(frame: torch.Tensor) -> dict[str, float]:
    rgb = frame.detach().to(device="cpu", dtype=torch.float32)
    luma = _linear_luma(rgb)
    p05, median, p95 = _spatial_quantiles(luma)
    smooth = functional.avg_pool2d(
        functional.pad(luma[None, None], (1, 1, 1, 1), mode="replicate"),
        kernel_size=3, stride=1,
    )[0, 0]
    highpass = luma - smooth
    maximum, minimum = rgb.amax(dim=-1), rgb.amin(dim=-1)
    saturation = torch.where(maximum > 0, (maximum - minimum) / maximum.clamp_min(_EPS),
                             torch.zeros_like(maximum))
    return {
        "median_linear_luma": median,
        "p05_linear_luma": p05,
        "p95_linear_luma": p95,
        "local_contrast_std": float(highpass.std(correction=0)),
        "mean_hsv_saturation": float(saturation.mean()),
    }


def _median(values: list[float]) -> float:
    return float(torch.quantile(torch.tensor(values, dtype=torch.float64), 0.5))


def _rgb_mae(images: torch.Tensor, left: int, right: int) -> float:
    a = images[left].detach().to(device="cpu", dtype=torch.float32)
    b = images[right].detach().to(device="cpu", dtype=torch.float32)
    return float((a - b).abs().mean())


def _window_xcorr(left: torch.Tensor, right: torch.Tensor, max_lag: int,
                  sample_rate: int) -> dict:
    # Pearson correlation over the overlapping samples for each integer lag;
    # channel means are removed separately, then channel energies are summed.
    best, best_lag, valid = -1.0, 0, False
    count = left.shape[-1]
    limit = min(max_lag, count - 2)
    for lag in range(-limit, limit + 1):
        if lag >= 0:
            a, b = left[..., :count - lag], right[..., lag:]
        else:
            a, b = left[..., -lag:], right[..., :count + lag]
        a = a - a.mean(dim=-1, keepdim=True)
        b = b - b.mean(dim=-1, keepdim=True)
        energy = float(a.square().sum() * b.square().sum())
        if energy <= _EPS**2:
            continue
        correlation = max(-1.0, min(1.0, float((a * b).sum()) / math.sqrt(energy)))
        if not valid or correlation > best + 1e-12 or (
                abs(correlation - best) <= 1e-12 and abs(lag) < abs(best_lag)):
            best, best_lag, valid = correlation, lag, True
    return {
        "valid": valid, "max_correlation": best if valid else 0.0,
        "lag_samples": best_lag, "lag_ms": best_lag * 1000.0 / sample_rate,
        "max_lag_samples": limit,
    }


def _audio_seam(waveform: torch.Tensor, frame: int, fps: float, sample_rate: int,
                window_seconds: float, max_lag_ms: float) -> dict:
    position = round(frame * sample_rate / fps)
    if not 0 < position < waveform.shape[-1]:
        raise ValueError("audio does not cover the video seam boundary")
    count = min(round(window_seconds * sample_rate), position, waveform.shape[-1] - position)
    if count < 2:
        raise ValueError("audio seam window must have at least two samples on each side")
    left, right = waveform[..., position - count:position], waveform[..., position:position + count]
    context = torch.cat((left, right), dim=-1)
    signal_rms = float(context.square().mean().sqrt())
    jump_rms = float((right[..., 0] - left[..., -1]).square().mean().sqrt())
    derivatives = torch.cat((left.diff(dim=-1), right.diff(dim=-1)), dim=-1)
    return {
        "boundary_sample": position, "window_samples_per_side": count,
        "seam_derivative_rms": jump_rms,
        "nearby_derivative_rms": float(derivatives.square().mean().sqrt()),
        "context_signal_rms": signal_rms,
        "normalized_seam_jump": jump_rms / signal_rms if signal_rms > _EPS else 0.0,
        "normalized_seam_jump_valid": signal_rms > _EPS,
        "left_signal_rms": float(left.square().mean().sqrt()),
        "right_signal_rms": float(right.square().mean().sqrt()),
        "window_xcorr": _window_xcorr(left, right, round(max_lag_ms * sample_rate / 1000.0),
                                      sample_rate),
    }


def measure_video(images: torch.Tensor, boundaries: Sequence[int], *, fps: float = 24.0,
                  window_frames: int = 24, audio=None, audio_sample_rate: int | None = None,
                  audio_window_seconds: float = 0.1, max_audio_lag_ms: float = 20.0) -> dict:
    """Measure decoded FHWC RGB [0,1] with delivered-segment frame boundaries.

    ``boundaries`` contains increasing frame offsets where a new segment starts;
    optional endpoints 0/F are accepted. Each segment is analyzed over the same
    number of leading frames, capped by its shortest neighbor's length. Audio
    accepts [samples], [channels,samples], [1,channels,samples], or the worker's
    {waveform, sample_rate} mapping. No tensor or NaN/Infinity is returned.
    """
    if (not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[-1] != 3
            or min(images.shape) < 1 or not images.is_floating_point()):
        raise ValueError("images must be a nonempty floating FHWC RGB tensor")
    if not math.isfinite(float(fps)) or fps <= 0:
        raise ValueError("fps must be finite and positive")
    if isinstance(window_frames, bool) or not isinstance(window_frames, int) or window_frames < 1:
        raise ValueError("window_frames must be a positive integer")
    if (not math.isfinite(float(audio_window_seconds)) or audio_window_seconds <= 0
            or not math.isfinite(float(max_audio_lag_ms)) or max_audio_lag_ms < 0):
        raise ValueError("audio window and lag must be finite, with positive window and nonnegative lag")
    total = images.shape[0]
    points = list(boundaries)
    if (any(isinstance(p, bool) or not isinstance(p, int) or not 0 <= p <= total for p in points)
            or any(a >= b for a, b in zip(points, points[1:], strict=False))):
        raise ValueError("boundaries must be strictly increasing integer frame offsets within the video")
    points = [p for p in points if 0 < p < total]
    edges = [0, *points, total]
    for block in images.split(16, dim=0):
        if not bool(torch.isfinite(block).all()):
            raise ValueError("images must contain finite values")
        if float(block.amin()) < 0.0 or float(block.amax()) > 1.0:
            raise ValueError("images must be in [0, 1]")
    common_window = min(window_frames, min(b - a for a, b in zip(edges, edges[1:], strict=False)))
    segments = []
    for index, (start, end) in enumerate(zip(edges, edges[1:], strict=False)):
        rows = [_frame_measures(images[i]) for i in range(start, start + common_window)]
        segment = {
            "index": index, "start_frame": start, "end_frame_exclusive": end,
            "frame_count": end - start, "analysis_start_frame": start,
            "analysis_end_frame_exclusive": start + common_window,
            **{key: _median([row[key] for row in rows]) for key in _SEGMENT_MEASURES},
        }
        initial = segments[0] if segments else segment
        segment["drift_from_initial"] = {
            key + "_delta": segment[key] - initial[key] for key in _SEGMENT_MEASURES
        }
        segments.append(segment)
    waveform = None
    if audio is not None:
        if isinstance(audio, Mapping):
            audio_sample_rate = audio_sample_rate or audio.get("sample_rate")
            audio = audio.get("waveform")
        if (isinstance(audio_sample_rate, bool) or not isinstance(audio_sample_rate, int)
                or audio_sample_rate < 1):
            raise ValueError("audio sample rate must be a positive integer")
        if not isinstance(audio, torch.Tensor) or not audio.is_floating_point():
            raise ValueError("audio waveform must be a floating tensor")
        if audio.ndim == 1:
            audio = audio.unsqueeze(0)
        elif audio.ndim == 3 and audio.shape[0] == 1:
            audio = audio[0]
        if audio.ndim != 2 or min(audio.shape) < 1:
            raise ValueError("audio waveform must have shape [channels,samples] and batch size 1")
        waveform = audio.detach().to(device="cpu", dtype=torch.float64)
        if not bool(torch.isfinite(waveform).all()):
            raise ValueError("audio waveform must contain finite values")
        if float(waveform.abs().amax()) > 1.0:
            raise ValueError("audio waveform must be normalized PCM in [-1, 1]")
    seams = []
    for index, boundary in enumerate(points):
        neighbors = []
        for start, end in ((max(edges[index], boundary - window_frames), boundary),
                           (boundary, min(edges[index + 2], boundary + window_frames))):
            neighbors.extend(_rgb_mae(images, i - 1, i) for i in range(start + 1, end))
        typical = _median(neighbors) if neighbors else 0.0
        seam_mae = _rgb_mae(images, boundary - 1, boundary)
        left_luma = _linear_luma(images[boundary - 1])
        right_luma = _linear_luma(images[boundary])
        seam = {
            "boundary_frame": boundary, "time_seconds": boundary / fps,
            "rgb_mae": seam_mae, "typical_neighbor_rgb_mae": typical,
            "neighbor_frame_pair_count": len(neighbors),
            "rgb_mae_over_typical": seam_mae / typical if typical > _EPS else 0.0,
            "relative_rgb_mae_valid": typical > _EPS,
            "linear_luma_jump": float(right_luma.mean() - left_luma.mean()),
            "linear_luma_mae": float((right_luma - left_luma).abs().mean()),
        }
        if waveform is not None:
            seam["audio"] = _audio_seam(waveform, boundary, fps, audio_sample_rate,
                                         audio_window_seconds, max_audio_lag_ms)
        seams.append(seam)
    return {
        "format": "snarkroute.h3.latent-metrics.v1", "frame_count": total,
        "fps": float(fps), "boundaries": points,
        "analysis_frames_per_segment": common_window,
        "segments": segments, "seams": seams,
        "definitions": {
            "linear_luma": "sRGB inverse transfer; linear Rec.709 weights 0.2126,0.7152,0.0722",
            "segment_statistics": "median across equal leading frame windows of per-frame spatial measurements",
            "local_contrast_std": "population std of linear luma minus replicate-padded 3x3 spatial average",
            "mean_hsv_saturation": "spatial mean of (RGB max-min)/max; black saturation=0",
            "rgb_mae": "mean absolute display RGB difference between frames around the boundary",
            "typical_neighbor_rgb_mae": "median adjacent-frame RGB MAE within neighboring segments, excluding the seam",
            "linear_luma_jump": "signed change in spatial mean linear luma, next minus previous frame",
            "audio_seam_jump": "RMS across channels of boundary first difference, divided by local signal RMS",
            "window_xcorr": "max mean-centered Pearson correlation of consecutive equal windows over integer lags; positive lag shifts right window forward; similarity does not prove overlap identity",
            "invalid_normalization": "valid=false and numeric 0 when denominator is zero; unavailable is not a pass",
        },
    }
