"""Focused CPU tests for H3 AV geometry, context transfer and exact stitching."""
from copy import deepcopy

import pytest
import torch

from app.backends.h3_latent_extend import (
    h3_audio_cells,
    h3_video_frame_spans,
    h3_video_tokens,
    prepare_h3_continuation,
    select_h3_context,
    stitch_h3_latents,
    validate_h3_geometry,
)


class NestedPair:
    def __init__(self, tensors):
        self.tensors = tuple(tensors)


def av_segment(frames=124, offset=0.0, dtype=torch.float32):
    video = torch.arange(24 * h3_video_tokens(frames) * 2 * 3, dtype=dtype).reshape(
        1, 24, h3_video_tokens(frames), 2, 3,
    ) + offset
    audio = torch.arange(32 * 2 * h3_audio_cells(frames), dtype=dtype).reshape(
        1, 32, 2, h3_audio_cells(frames),
    ) + offset
    manifest = {
        "format": "snarkroute.h3.av-latent.v1", "model_variant": "h3_base",
        "vae_mode": "stock", "frames": frames, "width": 48, "height": 32,
        "video_shape": list(video.shape), "audio_shape": list(audio.shape),
        "video_dtype": str(video.dtype), "audio_dtype": str(audio.dtype),
    }
    return video, audio, manifest


def test_temporal_geometry_uses_five_token_seventeen_frame_cycle():
    assert h3_video_tokens(5) == 2
    assert h3_video_tokens(22) == 7
    assert h3_video_tokens(124) == 37
    assert h3_video_frame_spans(7) == (1, 4, 4, 4, 4, 1, 4)
    assert sum(h3_video_frame_spans(37)) == 124
    assert h3_audio_cells(124) == 207
    for invalid in (0, 1, 21, 120, 125):
        with pytest.raises(ValueError, match="17k"):
            h3_video_tokens(invalid)


def test_context_preserves_raw_av_bits_and_absolute_audio_grid():
    video, audio, manifest = av_segment()
    context = select_h3_context(video, audio, manifest, overlap_frames=22)
    assert context.video_start == 30
    assert context.audio_start == 170
    assert context.video.shape[2] == 7
    assert context.audio.shape[-1] == 37
    assert torch.equal(context.video, video[:, :, 30:])
    assert torch.equal(context.audio, audio[..., 170:])
    context.video.zero_()
    context.audio.zero_()
    assert video.count_nonzero() > 0
    assert audio.count_nonzero() > 0


def test_rejects_phase_and_fractional_audio_boundary_instead_of_rounding():
    video, audio, manifest = av_segment()
    with pytest.raises(ValueError, match="17k"):
        select_h3_context(video, audio, manifest, overlap_frames=21)
    with pytest.raises(ValueError, match="audio grid"):
        select_h3_context(video, audio, manifest, overlap_frames=5)
    with pytest.raises(ValueError, match="overlap"):
        select_h3_context(video, audio, manifest, overlap_frames=141)


def test_manifest_geometry_and_identity_are_checked_before_stitching():
    video, audio, manifest = av_segment()
    validate_h3_geometry(video, audio, manifest)
    bad = deepcopy(manifest)
    bad["frames"] = 22
    with pytest.raises(ValueError, match="video temporal"):
        validate_h3_geometry(video, audio, bad)
    with pytest.raises(ValueError, match="audio temporal"):
        validate_h3_geometry(video, audio[..., :-1], manifest)
    new_video, new_audio, new_manifest = av_segment(offset=100)
    for key, replacement in (("model_variant", "h3_pro"), ("vae_mode", "fast"), ("width", 64)):
        bad = deepcopy(new_manifest)
        bad[key] = replacement
        with pytest.raises(ValueError):
            stitch_h3_latents(video, audio, manifest, new_video, new_audio, bad)
    with pytest.raises(ValueError, match="dtype"):
        stitch_h3_latents(video, audio, manifest, new_video.half(), new_audio, new_manifest)


def test_community_motion_context_only_is_default_and_does_not_mutate_input():
    video, audio, manifest = av_segment()
    context = select_h3_context(video, audio, manifest)
    target_video, target_audio, _ = av_segment(offset=900)
    target_video.zero_()
    target_audio.zero_()
    target = {"samples": NestedPair((target_video, target_audio)), "other": "retained"}
    conditioning = [[torch.tensor([1.0]), {"existing": 1}]]
    updated_conditioning, updated = prepare_h3_continuation(conditioning, target, context, NestedPair)
    keyframes = updated_conditioning[0][1]["minimax_keyframes"]
    assert len(keyframes) == 1
    assert keyframes[0]["resolved_frame_index"] == 0
    assert torch.equal(keyframes[0]["latent"], context.video)
    assert torch.equal(keyframes[0]["audio_latent"], context.audio)
    assert conditioning[0][1] == {"existing": 1}
    assert updated["samples"] is target["samples"]
    assert "noise_mask" not in updated
    assert updated["other"] == "retained"


def test_optional_prefix_freezing_copies_samples_and_masks_both_streams():
    video, audio, manifest = av_segment()
    context = select_h3_context(video, audio, manifest)
    target_video, target_audio, _ = av_segment()
    target_video.zero_()
    target_audio.zero_()
    target = {"samples": NestedPair((target_video, target_audio))}
    _, updated = prepare_h3_continuation([], target, context, NestedPair, freeze_prefix=True)
    frozen_video, frozen_audio = updated["samples"].tensors
    video_mask, audio_mask = updated["noise_mask"].tensors
    assert torch.equal(frozen_video[:, :, :7], context.video)
    assert torch.equal(frozen_audio[..., :37], context.audio)
    assert torch.count_nonzero(target_video) == 0
    assert torch.count_nonzero(target_audio) == 0
    assert torch.count_nonzero(video_mask[:, :, :7]) == 0
    assert torch.count_nonzero(audio_mask[..., :37]) == 0
    assert torch.all(video_mask[:, :, 7:] == 1)
    assert torch.all(audio_mask[..., 37:] == 1)


def test_stitch_uses_distinct_video_and_audio_prefix_and_keeps_old_exact():
    video, audio, manifest = av_segment()
    new_video, new_audio, new_manifest = av_segment(offset=10_000)
    old_video, old_audio = video.clone(), audio.clone()
    joined_video, joined_audio, joined_manifest = stitch_h3_latents(
        video, audio, manifest, new_video, new_audio, new_manifest,
    )
    assert joined_video.shape[2] == 67
    assert joined_audio.shape[-1] == 377
    assert joined_manifest["frames"] == 226
    assert torch.equal(joined_video[:, :, :37], old_video)
    assert torch.equal(joined_audio[..., :207], old_audio)
    assert torch.equal(joined_video[:, :, 37:], new_video[:, :, 7:])
    assert torch.equal(joined_audio[..., 207:], new_audio[..., 37:])
    assert joined_manifest["latent_extend"]["audio_prefix_cells"] == 37
    validate_h3_geometry(joined_video, joined_audio, joined_manifest)
    second_context = select_h3_context(joined_video, joined_audio, joined_manifest)
    assert second_context.video_start == 60
    assert second_context.audio_start == 340


def test_strict_prefix_verification_is_optional_and_never_replaces_sampler_output():
    video, audio, manifest = av_segment()
    new_video, new_audio, new_manifest = av_segment(offset=100)
    with pytest.raises(ValueError, match="prefix"):
        stitch_h3_latents(video, audio, manifest, new_video, new_audio, new_manifest, verify_prefix=True)
    context = select_h3_context(video, audio, manifest)
    new_video[:, :, :7] = context.video
    new_audio[..., :37] = context.audio
    joined_video, _, _ = stitch_h3_latents(
        video, audio, manifest, new_video, new_audio, new_manifest, verify_prefix=True,
    )
    assert torch.equal(joined_video[:, :, :37], video)


def test_stitch_rejects_nonintegral_audio_increment():
    video, audio, manifest = av_segment()
    new_video, new_audio, new_manifest = av_segment(frames=107)
    with pytest.raises(ValueError, match="audio grid"):
        stitch_h3_latents(video, audio, manifest, new_video, new_audio, new_manifest)


def test_tone_proxy_is_bounded_fixed_reference_context_only():
    video, audio, manifest = av_segment()
    raw_video, raw_audio = video.clone(), audio.clone()
    baseline = select_h3_context(video, audio, manifest)
    reference = baseline.video + 1000
    corrected = select_h3_context(
        video, audio, manifest, tone_reference=reference,
        tone_strength=0.5, max_mean_shift_std_fraction=0.25,
    )
    std = reference.float().std(dim=(0, 2, 3, 4), correction=0)
    shift = corrected.video.float().mean(dim=(0, 2, 3, 4)) - baseline.video.float().mean(dim=(0, 2, 3, 4))
    assert torch.all(shift.abs() <= std * 0.25 * 0.5 + 0.001)
    assert corrected.tone_shift is not None
    assert torch.equal(video, raw_video)
    assert torch.equal(audio, raw_audio)
    assert torch.equal(corrected.audio, baseline.audio)
    for invalid in (-0.1, 1.1, float("nan")):
        with pytest.raises(ValueError, match="strength"):
            select_h3_context(video, audio, manifest, tone_reference=reference, tone_strength=invalid)


def test_zero_tone_strength_preserves_float64_context_bits():
    video, audio, manifest = av_segment(dtype=torch.float64)
    video += 0.0000001
    baseline = select_h3_context(video, audio, manifest)
    unchanged = select_h3_context(video, audio, manifest, tone_reference=video, tone_strength=0.0)
    assert torch.equal(unchanged.video, baseline.video)
    assert unchanged.tone_shift is None


def test_existing_keyframes_and_noise_masks_fail_closed():
    video, audio, manifest = av_segment()
    context = select_h3_context(video, audio, manifest)
    target = {"samples": NestedPair((video, audio))}
    with pytest.raises(ValueError, match="keyframe"):
        prepare_h3_continuation([[None, {"minimax_keyframes": [{}]}]], target, context, NestedPair)
    with pytest.raises(ValueError, match="noise_mask"):
        prepare_h3_continuation([], {**target, "noise_mask": 1}, context, NestedPair, freeze_prefix=True)
