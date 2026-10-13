"""Offline decode of assembled H3 AV with the native temporal boundary plan."""
from __future__ import annotations

import time
from pathlib import Path

from .h3_latent_archive import read_h3_latent
from .h3_latent_extend import validate_h3_geometry


def validate_native_decoder(decoder):
    expected = {"tokens_chunk_size": 5, "token_overlap": 2,
                "frame_pre_padding": 3, "frame_overlap": 5}
    if not callable(getattr(decoder, "decode_temporal", None)) or any(
        getattr(decoder, name, None) != value for name, value in expected.items()
    ):
        raise RuntimeError("Unsupported H3 VAE temporal boundary handling; refusing independent chunk decode")
    if not getattr(decoder, "tiling", False):
        raise RuntimeError("H3 VAE spatial tiling must be enabled on the experimental 16 GiB profile")


def decode_h3_archive(runtime, archive_path: Path):
    """Return (CPU FHWC frames, audio dict, measured decode metadata).

    A single sequence is submitted to the VAE. Its own decoder overlaps seven
    tokens with stride five, blends five frames and writes final chunks to CPU.
    Arbitrary external chunks would reset the H3 temporal phase and are avoided.
    """
    with runtime._lock:
        modules = runtime._imports()
        torch = modules["torch"]
        video, audio, manifest = read_h3_latent(archive_path)
        validate_h3_geometry(video, audio, manifest)
        if manifest["vae_mode"] != "stock" or video.shape[0] != 1:
            raise ValueError("Assembled decode supports stock H3 video with batch size one")
        runtime.unload()
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        try:
            models, _ = runtime._load_models("stock")
            validate_native_decoder(models["video_vae"].first_stage_model)
            samples = {"samples": modules["NestedTensor"]((video, audio))}
            with torch.inference_mode():
                images = modules["VAEDecode"]().decode(models["video_vae"], samples)[0].cpu()
                if images.shape != (manifest["frames"], manifest["height"], manifest["width"], 3):
                    raise RuntimeError(f"Assembled H3 decoded unexpected frame shape {tuple(images.shape)}")
                decoded_audio = modules["VAEDecodeAudio"].execute(models["audio_vae"], samples)[0]
            torch.cuda.synchronize()
            waveform = decoded_audio["waveform"].cpu()
            sr = int(decoded_audio["sample_rate"])
            if sr != 32000 or waveform.shape[-1] != audio.shape[-1] * 800:
                raise RuntimeError("Unexpected H3 audio VAE sample grid")
            # H3 rounds its audio grid. Trim only the final decoded PCM tail to
            # exact video duration, never resample or lose interior AV latents.
            expected_pcm = round(manifest["frames"] * sr / 24)
            padded_pcm = max(0, expected_pcm - waveform.shape[-1])
            trimmed_pcm = max(0, waveform.shape[-1] - expected_pcm)
            if max(padded_pcm, trimmed_pcm) > 400:
                raise RuntimeError("H3 audio/video duration disagreement exceeds half an audio cell")
            if padded_pcm:
                # Some legal frame counts round down on the audio grid. Pad only
                # the sub-cell final PCM remainder with silence for exact muxing.
                waveform = torch.nn.functional.pad(waveform, (0, padded_pcm))
            if not torch.isfinite(images).all() or not torch.isfinite(waveform).all():
                raise RuntimeError("H3 VAE produced nonfinite output")
            metadata = {
                "frames": manifest["frames"], "duration_seconds": manifest["frames"] / 24,
                "audio_cells": audio.shape[-1], "pcm_samples": expected_pcm,
                "trimmed_pcm_samples": trimmed_pcm, "padded_pcm_samples": padded_pcm,
                "decode_seconds": time.perf_counter() - started,
                "peak_vram_gib": torch.cuda.max_memory_reserved() / 1024**3,
                "temporal_chunk_tokens": 7, "temporal_stride_tokens": 5,
                "blend_frames": 5, "boundary_mode": "native_h3_temporal",
            }
            return images, {"waveform": waveform[..., :expected_pcm], "sample_rate": sr}, metadata
        finally:
            runtime.unload()


def save_h3_video(runtime, images, audio, output_path: Path) -> None:
    modules = runtime._imports()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    video = modules["CreateVideo"].execute(images, 24.0, audio=audio, bit_depth=8, color_space="sRGB")[0]
    video.save_to(str(output_path), format=modules["Types"].VideoContainer("mp4"),
                  codec=modules["Types"].VideoCodec("h264"), metadata=None)
    with output_path.open("rb") as stream:
        prefix = stream.read(12)
    if prefix[4:8] != b"ftyp":
        raise RuntimeError("Experimental H3 export did not produce an MP4")
