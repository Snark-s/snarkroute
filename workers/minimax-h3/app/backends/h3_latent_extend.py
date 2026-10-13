"""Explicit experimental Motion Context and AV stitching for MATLOW H3.

H3 video time is a repeating [1, 4, 4, 4, 4] frame span per latent token,
not a uniform stride. Audio uses its own 40 Hz grid at 24 video fps. Exact
concatenation therefore requires both video phase and integral audio boundaries.
No function here encodes/decodes pixels or mutates a captured source segment.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def h3_video_tokens(frames: int) -> int:
    """Return exact H3 temporal length; valid generated frames are 17k+5."""
    if isinstance(frames, bool) or not isinstance(frames, int) or frames < 5 or (frames - 5) % 17:
        raise ValueError("H3 video frames must satisfy F=17k+5 for integer k>=0")
    return 5 * ((frames - 5) // 17) + 2


def h3_video_frame_spans(tokens: int) -> tuple[int, ...]:
    """Native causal VAE frame coverage for a sequence starting at phase zero."""
    _positive_int(tokens, "tokens")
    return tuple(1 if index % 5 == 0 else 4 for index in range(tokens))


def h3_audio_cells(frames: int) -> int:
    """Nearest cell count on the independent 40 Hz / 24 fps audio grid."""
    _positive_int(frames, "frames")
    # Fractions have denominator three, so no half-even rounding ambiguity.
    return (5 * frames + 1) // 3


def validate_h3_geometry(video: Any, audio: Any, manifest: dict[str, Any]) -> None:
    """Validate archive identity, frame coverage, and tensor metadata strictly."""
    if not isinstance(manifest, dict) or manifest.get("format") != "snarkroute.h3.av-latent.v1":
        raise ValueError("Expected a SnarkRoute H3 AV latent v1 manifest")
    for key in ("model_variant", "vae_mode"):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise ValueError(f"H3 manifest must identify {key}")
    frames = manifest.get("frames")
    tokens = h3_video_tokens(frames)
    width = _positive_int(manifest.get("width"), "width")
    height = _positive_int(manifest.get("height"), "height")
    if (
        getattr(video, "ndim", None) != 5 or video.shape[1] != 24
        or getattr(audio, "ndim", None) != 4 or tuple(audio.shape[1:3]) != (32, 2)
        or video.shape[0] <= 0 or video.shape[0] != audio.shape[0]
        or not video.is_floating_point() or not audio.is_floating_point()
    ):
        raise ValueError("Invalid H3 paired video/audio latent shapes or dtypes")
    if video.shape[2] != tokens:
        raise ValueError("H3 video temporal shape disagrees with F=17k+5 / T=5k+2")
    if audio.shape[-1] != h3_audio_cells(frames):
        raise ValueError("H3 audio temporal shape disagrees with the 40 Hz audio grid")
    if width % 16 or height % 16 or tuple(video.shape[-2:]) != (height // 16, width // 16):
        raise ValueError("H3 video spatial shape disagrees with width/height and VAE stride16")
    for key, tensor in (("video", video), ("audio", audio)):
        if list(tensor.shape) != manifest.get(f"{key}_shape"):
            raise ValueError(f"H3 {key} shape disagrees with manifest")
        # Early capture v1 files predate dtype fields. The actual tensors still
        # determine dtype and must match at the stitching boundary.
        declared_dtype = manifest.get(f"{key}_dtype")
        if declared_dtype is not None and declared_dtype != str(tensor.dtype):
            raise ValueError(f"H3 {key} dtype disagrees with manifest")


@dataclass(frozen=True)
class LatentContext:
    video: Any
    audio: Any
    source_frames: int
    overlap_frames: int
    video_start: int
    audio_start: int
    tone_shift: Any = None


def _context_boundaries(frames: int, overlap_frames: int) -> tuple[int, int]:
    source_tokens = h3_video_tokens(frames)
    overlap_tokens = h3_video_tokens(overlap_frames)
    if overlap_frames > frames:
        raise ValueError("H3 context overlap exceeds source frames")
    video_start = source_tokens - overlap_tokens
    if video_start % 5:
        raise ValueError("H3 overlap must start at video phase zero")
    frame_start = frames - overlap_frames
    if frame_start % 3:
        raise ValueError("H3 context start is fractional on the 40 Hz audio grid; choose a legal overlap")
    return video_start, 5 * frame_start // 3


def _tone_proxy(context: Any, reference: Any, strength: float, maximum: float):
    """Bound a per-channel mean shift; this is not calibrated RGB luminance."""
    import torch

    if not math.isfinite(strength) or not 0 <= strength <= 1:
        raise ValueError("tone strength must be finite in [0,1]")
    if not math.isfinite(maximum) or not 0 <= maximum <= 1:
        raise ValueError("maximum tone mean-shift std fraction must be finite in [0,1]")
    if reference is None:
        if strength:
            raise ValueError("tone strength requires a fixed first-segment reference")
        return context, None
    if getattr(reference, "ndim", None) != 5 or reference.shape[1] != context.shape[1]:
        raise ValueError("tone reference must be an H3 video latent with matching channels")
    if not reference.is_floating_point() or not torch.isfinite(reference).all() or not torch.isfinite(context).all():
        raise ValueError("tone context and reference must contain finite floating point values")
    if strength == 0:
        return context, None
    axes = (0, 2, 3, 4)
    fixed = reference.detach().to(device=context.device, dtype=torch.float32)
    work = context.float()
    limit = fixed.std(dim=axes, correction=0, keepdim=True) * maximum
    desired_shift = fixed.mean(dim=axes, keepdim=True) - work.mean(dim=axes, keepdim=True)
    shift = torch.maximum(-limit, torch.minimum(limit, desired_shift)) * strength
    return (work + shift).to(context.dtype), shift.detach().to("cpu")


def select_h3_context(
    video: Any, audio: Any, manifest: dict[str, Any], *, overlap_frames: int = 22,
    tone_reference: Any = None, tone_strength: float = 0.0,
    max_mean_shift_std_fraction: float = 0.25,
) -> LatentContext:
    """Copy a phase-zero AV tail without a VAE round trip.

    Context audio includes the source's rounding overhang, e.g. a 22 frame
    tail of a 124 frame segment is 37 cells, not floor(22*40/24)=36.
    """
    validate_h3_geometry(video, audio, manifest)
    frames = manifest["frames"]
    video_start, audio_start = _context_boundaries(frames, overlap_frames)
    tail_video = video[:, :, video_start:].detach().clone()
    tail_audio = audio[..., audio_start:].detach().clone()
    tail_video, shift = _tone_proxy(tail_video, tone_reference, tone_strength, max_mean_shift_std_fraction)
    return LatentContext(tail_video, tail_audio, frames, overlap_frames, video_start, audio_start, shift)


def _sample_parts(latent: dict[str, Any]):
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError("Expected an H3 LATENT dictionary containing samples")
    parts = getattr(latent["samples"], "tensors", None)
    if parts is None and hasattr(latent["samples"], "unbind"):
        parts = latent["samples"].unbind()
    if not isinstance(parts, tuple | list) or len(parts) != 2:
        raise ValueError("Expected paired H3 NestedTensor video/audio samples")
    return parts


def prepare_h3_continuation(
    conditioning: list[Any], target_latent: dict[str, Any], context: LatentContext,
    nested_tensor_cls: Any, *, freeze_prefix: bool = False,
) -> tuple[list[Any], dict[str, Any]]:
    """Inject native Motion Context conditioning into an empty target latent.

    Community continuation is conditioning-only by default. Prefix freezing
    is a separate opt-in experiment, implemented with an AV NestedTensor mask.
    Input conditioning, target samples, and archived context stay unchanged.
    """
    import torch

    video, audio = _sample_parts(target_latent)
    overlap_tokens = h3_video_tokens(context.overlap_frames)
    if (
        video.ndim != 5 or audio.ndim != 4
        or tuple(video.shape[:2]) != tuple(context.video.shape[:2])
        or tuple(video.shape[-2:]) != tuple(context.video.shape[-2:])
        or tuple(audio.shape[:3]) != tuple(context.audio.shape[:3])
        or context.video.shape[2] != overlap_tokens
        or video.shape[2] <= overlap_tokens or audio.shape[-1] <= context.audio.shape[-1]
    ):
        raise ValueError("H3 continuation context does not fit target AV sample shapes")
    if video.dtype != context.video.dtype or audio.dtype != context.audio.dtype:
        raise ValueError("H3 continuation target and context dtypes must match")
    target_frames = sum(h3_video_frame_spans(video.shape[2]))
    if h3_video_tokens(target_frames) != video.shape[2] or audio.shape[-1] != h3_audio_cells(target_frames):
        raise ValueError("H3 continuation target must contain valid AV temporal geometry")
    _context_boundaries(target_frames, context.overlap_frames)
    append_frames = target_frames - context.overlap_frames
    target_prefix_audio = audio.shape[-1] - 5 * append_frames // 3
    if target_prefix_audio != context.audio.shape[-1]:
        raise ValueError("H3 context and target prefixes disagree on the absolute audio grid")
    context_video = context.video.to(video.device).clone()
    context_audio = context.audio.to(audio.device).clone()
    updated_conditioning = []
    for item in conditioning:
        if not isinstance(item, tuple | list) or len(item) != 2 or not isinstance(item[1], dict):
            raise ValueError("Expected CONDITIONING entries of [embedding, metadata]")
        if item[1].get("minimax_keyframes"):
            raise ValueError("H3 latent continuation cannot combine existing minimax keyframes")
        values = dict(item[1])
        values["minimax_keyframes"] = [{
            "resolved_frame_index": 0, "latent": context_video, "audio_latent": context_audio,
        }]
        updated_conditioning.append([item[0], values])
    updated_latent = dict(target_latent)
    if freeze_prefix:
        if "noise_mask" in target_latent:
            raise ValueError("H3 prefix freezing cannot override an existing noise_mask")
        frozen_video, frozen_audio = video.clone(), audio.clone()
        frozen_video[:, :, :overlap_tokens] = context_video
        frozen_audio[..., :target_prefix_audio] = context_audio
        video_mask = torch.ones_like(video)
        audio_mask = torch.ones_like(audio)
        video_mask[:, :, :overlap_tokens] = 0
        audio_mask[..., :target_prefix_audio] = 0
        updated_latent["samples"] = nested_tensor_cls((frozen_video, frozen_audio))
        updated_latent["noise_mask"] = nested_tensor_cls((video_mask, audio_mask))
    return updated_conditioning, updated_latent


def stitch_h3_latents(
    previous_video: Any, previous_audio: Any, previous_manifest: dict[str, Any],
    new_video: Any, new_audio: Any, new_manifest: dict[str, Any], *,
    overlap_frames: int = 22, verify_prefix: bool = False,
) -> tuple[Any, Any, dict[str, Any]]:
    """Keep the raw previous AV streams and append only the new suffix.

    A legal 124/22 continuation adds 102 frames, 30 video tokens, and 170
    audio cells. The generated redundant prefix is discarded, never silently
    overwritten. Strict equality checking is useful only for frozen prefixes.
    """
    import torch

    validate_h3_geometry(previous_video, previous_audio, previous_manifest)
    validate_h3_geometry(new_video, new_audio, new_manifest)
    for key in ("model_variant", "vae_mode", "width", "height"):
        if previous_manifest[key] != new_manifest[key]:
            raise ValueError(f"H3 latent stitching requires identical {key}")
    for name, previous, new in (("video", previous_video, new_video), ("audio", previous_audio, new_audio)):
        if previous.dtype != new.dtype:
            raise ValueError(f"H3 latent stitching requires identical {name} dtype")
        if previous.device != new.device:
            raise ValueError(f"H3 latent stitching requires identical {name} device")
        if previous.shape[0] != new.shape[0]:
            raise ValueError(f"H3 latent stitching requires identical {name} batch size")
    video_start, audio_start = _context_boundaries(previous_manifest["frames"], overlap_frames)
    _context_boundaries(new_manifest["frames"], overlap_frames)
    append_frames = new_manifest["frames"] - overlap_frames
    if append_frames <= 0:
        raise ValueError("H3 new segment must extend beyond the overlap")
    prefix_video = h3_video_tokens(overlap_frames)
    prefix_audio = new_audio.shape[-1] - 5 * append_frames // 3
    if prefix_audio != previous_audio.shape[-1] - audio_start:
        raise ValueError("H3 previous context and new prefix disagree on the audio grid")
    if verify_prefix and (
        not torch.equal(previous_video[:, :, video_start:], new_video[:, :, :prefix_video])
        or not torch.equal(previous_audio[..., audio_start:], new_audio[..., :prefix_audio])
    ):
        raise ValueError("H3 generated AV prefix differs from raw context; sampler prefix was not frozen")
    assembled_video = torch.cat((previous_video, new_video[:, :, prefix_video:]), dim=2)
    assembled_audio = torch.cat((previous_audio, new_audio[..., prefix_audio:]), dim=-1)
    manifest = dict(previous_manifest)
    manifest.update({
        "frames": previous_manifest["frames"] + append_frames,
        "video_shape": list(assembled_video.shape), "audio_shape": list(assembled_audio.shape),
        "video_dtype": str(assembled_video.dtype), "audio_dtype": str(assembled_audio.dtype),
        "note": "raw H3 AV latent concatenation; phase-zero video and exact independent audio grid",
        "latent_extend": {
            "experimental": True, "overlap_frames": overlap_frames,
            "video_prefix_tokens": prefix_video, "audio_prefix_cells": prefix_audio,
            "appended_frames": append_frames, "verified_prefix": verify_prefix,
            "segment_count": previous_manifest.get("latent_extend", {}).get("segment_count", 1) + 1,
        },
    })
    validate_h3_geometry(assembled_video, assembled_audio, manifest)
    return assembled_video, assembled_audio, manifest
