# SPDX-License-Identifier: GPL-3.0-only
"""Experimental cyclic sampling for the headless MiniMax H3 runtime.

Adapted from pxl-pshr/ComfyUI-MiniMaxH3-Loop by pxl-pshr:
https://github.com/pxl-pshr/ComfyUI-MiniMaxH3-Loop (GPL-3.0).
The circular-context implementation lives in the SnarkRoute worker, not in
ComfyUI custom_nodes. This module is opt-in; GPU validation is required.
"""
from __future__ import annotations

from dataclasses import dataclass


MIN_CLIPS = 6
MAX_CLIPS = 18
CLIP_LATENTS = 5
VIDEO_TAIL = 2


def loop_frame_count(seconds: float) -> int:
    """Round UP to a supported cyclic H3 length (17*k+5 input frames)."""
    if seconds > 12.75:
        raise ValueError("H3 cyclic mode supports at most 12.75 seconds with padding")
    # The loop output excludes the 5-frame head/tail: 17*k frames at 24 fps.
    # Choose the nearest valid loop rather than skipping intermediate lengths.
    clips = max(MIN_CLIPS, min(MAX_CLIPS, round(seconds * 24 / 17)))
    return clips * 17 + 5


def audio_latents(clips: int) -> int:
    return round(clips * 17 * 40 / 24)


def _periodic(x, left: int, right: int, axis: int):
    import torch

    n = x.shape[axis]
    if n < 1:
        raise ValueError("Cyclic H3 requires a nonempty latent")
    indices = (torch.arange(-left, n + right, device=x.device) % n).long()
    return x.index_select(axis, indices)


def _audio_mix_factor(length: int, split: int, reference):
    import torch

    position = torch.arange(length, device=reference.device, dtype=torch.float32) + 0.5
    distant_from_rotated = torch.minimum((position - split) % length, (split - position) % length)
    distant_from_main = torch.minimum(position, length - position)
    return (distant_from_rotated / (distant_from_main + distant_from_rotated)).to(reference.dtype)


def _diffusion_wrapper(executor, x, timestep, context, transformer_options, **kwargs):
    import torch

    video, audio = x
    count = video.shape[2] - VIDEO_TAIL
    if count < CLIP_LATENTS or count % CLIP_LATENTS:
        raise ValueError("Cyclic H3 requires 5*k+2 video latents")
    clips = count // CLIP_LATENTS
    audio_count = audio_latents(clips)
    audio_tail = audio.shape[-1] - audio_count
    if audio_tail < 0:
        raise ValueError("Cyclic H3 audio latent shape is incompatible")
    pad_clips = transformer_options["h3_cyclic_pad"]
    pad_video = pad_clips * CLIP_LATENTS
    pad_audio = audio_latents(pad_clips)
    video_mask = kwargs.get("denoise_mask")
    audio_mask = kwargs.get("audio_denoise_mask")
    noise_delta = transformer_options["h3_cyclic_noise_delta"]
    noise_delta = noise_delta.repeat(video.shape[0] // noise_delta.shape[0], 1, 1, 1, 1)
    sigma = transformer_options["sigmas"].reshape(-1, 1, 1, 1, 1).to(video.dtype)

    def predict(rotated_clips):
        video_shift = rotated_clips * CLIP_LATENTS
        audio_shift = audio_latents(rotated_clips)
        arguments = dict(kwargs)
        payload = kwargs.get("minimax_payload")
        if payload and payload.get("keyframes"):
            total = clips * 17
            shifted_keys = [
                dict(kf, resolved_frame_index=pad_clips * 17 +
                     (kf["resolved_frame_index"] + rotated_clips * 17) % total)
                for kf in payload["keyframes"]
            ]
            arguments["minimax_payload"] = dict(payload, keyframes=shifted_keys)
        if video_mask is not None:
            arguments["denoise_mask"] = _periodic(
                video_mask[:, :, :count].roll(video_shift, dims=2),
                pad_video, pad_video + VIDEO_TAIL, 2
            )
        if audio_mask is not None:
            arguments["audio_denoise_mask"] = _periodic(
                audio_mask[..., :audio_count].roll(audio_shift, dims=-1),
                pad_audio, pad_audio + audio_tail, -1
            )
        # Distilled H3 checkpoints are sensitive to repeated boundary noise.
        replacement = _periodic(
            noise_delta[:, :, :count].roll(video_shift, dims=2),
            pad_video, pad_video + VIDEO_TAIL, 2,
        ).to(video.dtype)
        replacement[:, :, pad_video:pad_video + count] = 0
        if video_mask is not None:
            replacement = replacement * arguments["denoise_mask"]
        wrapped_video = _periodic(
            video[:, :, :count].roll(video_shift, dims=2),
            pad_video, pad_video + VIDEO_TAIL, 2,
        )
        wrapped_video = torch.addcmul(wrapped_video, sigma, replacement)
        wrapped_audio = _periodic(
            audio[..., :audio_count].roll(audio_shift, dims=-1),
            pad_audio, pad_audio + audio_tail, -1,
        )
        predicted_video, predicted_audio = executor(
            [wrapped_video, wrapped_audio], timestep, context, transformer_options, **arguments
        )
        return (
            predicted_video[:, :, pad_video:pad_video + count].roll(-video_shift, dims=2),
            predicted_audio[..., pad_audio:pad_audio + audio_count].roll(-audio_shift, dims=-1),
        )

    predicted_video, predicted_audio = predict(0)
    if transformer_options["h3_cyclic_views"] == 2 and clips > 1:
        shift = clips // 2
        _, rotated_audio = predict(shift)
        factor = _audio_mix_factor(audio_count, audio_count - audio_latents(shift), predicted_audio)
        predicted_audio = torch.lerp(predicted_audio, rotated_audio, factor.reshape(1, 1, 1, -1))
    return [
        _periodic(predicted_video, 0, VIDEO_TAIL, 2),
        _periodic(predicted_audio, 0, audio_tail, -1),
    ]


def _sample_wrapper(executor, guider, sigmas, extra_args, callback, noise, *args, **kwargs):
    import torch
    import comfy.patcher_extension
    import comfy.utils

    opts = extra_args["model_options"]["transformer_options"]
    shape_info = guider.inner_model.latent_shapes
    original = comfy.utils.unpack_latents(noise, shape_info)[0] if shape_info else noise
    if torch.count_nonzero(original) == 0:
        delta = torch.zeros_like(original)
    else:
        rng = torch.Generator().manual_seed(((extra_args.get("seed") or 0) + 1) % (2**64))
        replacement = torch.randn(original.shape, generator=rng, dtype=original.dtype)
        delta = replacement.to(original.device) - original
    opts["h3_cyclic_noise_delta"] = delta
    return executor(guider, sigmas, extra_args, callback, noise, *args, **kwargs)


def attach_cyclic_sampler(model, *, pad_clips: int = 1, views: int = 2):
    """Apply transient wrappers to a model clone, never to a shared model."""
    import comfy.patcher_extension

    if not 1 <= pad_clips <= 2 or views not in (1, 2):
        raise ValueError("Cyclic H3 accepts pad_clips=1..2, views=1..2")
    model = model.clone()
    options = model.model_options["transformer_options"]
    options["h3_cyclic_pad"] = pad_clips
    options["h3_cyclic_views"] = views
    model.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, "snarkroute_h3_cyclic",
        _diffusion_wrapper,
    )
    model.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE, "snarkroute_h3_cyclic",
        _sample_wrapper,
    )
    return model


def decode_cyclic_video(video_vae, samples, pad_clips: int = 1):
    """Decode circular context, trimming exactly 17 frames per padded clip."""
    video, _ = samples["samples"].unbind()
    n = video.shape[2] - VIDEO_TAIL
    if n < CLIP_LATENTS or n % CLIP_LATENTS:
        raise ValueError("Invalid cyclic video latent count")
    context = pad_clips * CLIP_LATENTS
    decoded = video_vae.decode(_periodic(video[:, :, :n], context, context + VIDEO_TAIL, 2))
    decoded = decoded.reshape(-1, *decoded.shape[-3:])
    start = 17 * pad_clips
    return decoded[start:start + 17 * (n // CLIP_LATENTS)]


def decode_cyclic_audio(audio_vae_node, audio_vae, samples, pad_clips: int = 1):
    """Decode the wrapped waveform and remove the outer context."""
    _, audio = samples["samples"].unbind()
    n = (audio.shape[-1] // 40)  # not used for timing: derive clips from video
    video, _ = samples["samples"].unbind()
    clips = (video.shape[2] - VIDEO_TAIL) // CLIP_LATENTS
    size = audio_latents(clips)
    padding = audio_latents(pad_clips)
    expanded = _periodic(audio[..., :size], padding, padding, -1)
    output = audio_vae_node.execute(audio_vae, {"samples": expanded})[0]
    samples_per_token = output["waveform"].shape[-1] // expanded.shape[-1]
    output["waveform"] = output["waveform"][..., padding * samples_per_token:
                                              (padding + size) * samples_per_token]
    return output
