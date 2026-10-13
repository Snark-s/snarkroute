"""CPU-only tests for the opt-in H3 AV latent archive."""
import json
from pathlib import Path

import pytest
import torch
from safetensors.torch import save_file

from app.backends import h3_latent_archive
from app.backends.h3_latent_archive import read_h3_latent, save_h3_latent


class H3NestedPair:
    def __init__(self, video, audio):
        self.tensors = (video, audio)

    def __getitem__(self, index):
        raise AssertionError("NestedTensor indexing must not select an AV stream")


def example_latent():
    video = torch.arange(1 * 24 * 3 * 4 * 5, dtype=torch.float16).reshape(1, 24, 3, 4, 5)
    audio = torch.arange(1 * 32 * 2 * 9, dtype=torch.float32).reshape(1, 32, 2, 9)
    return {"samples": H3NestedPair(video, audio)}, video, audio


def test_archive_roundtrip_is_lossless_and_keeps_both_streams(tmp_path: Path):
    latent, video, audio = example_latent()
    path = save_h3_latent(
        latent, tmp_path, seed=42, model_variant="h3_base",
        frames=22, width=80, height=64,
    )
    assert path.suffix == ".safetensors"
    recovered_video, recovered_audio, manifest = read_h3_latent(path)
    assert torch.equal(recovered_video, video)
    assert torch.equal(recovered_audio, audio)
    assert recovered_video.dtype == video.dtype
    assert recovered_audio.dtype == audio.dtype
    assert manifest["frames"] == 22
    assert manifest["model_variant"] == "h3_base"
    assert manifest["format"] == "snarkroute.h3.av-latent.v1"


def test_rejects_non_h3_latent(tmp_path: Path):
    latent, video, _ = example_latent()
    with pytest.raises(ValueError, match="paired"):
        save_h3_latent(
            {"samples": video}, tmp_path, seed=1,
            model_variant="h3_base", frames=22, width=80, height=64,
        )
    with pytest.raises(ValueError, match="shapes"):
        save_h3_latent(
            {"samples": H3NestedPair(video[:, :23], latent["samples"].tensors[1])},
            tmp_path, seed=1, model_variant="h3_base", frames=22, width=80, height=64,
        )


def test_rejects_relative_capture_directory():
    latent, _, _ = example_latent()
    with pytest.raises(ValueError, match="absolute"):
        save_h3_latent(
            latent, Path("relative/path"), seed=1,
            model_variant="h3_base", frames=22, width=80, height=64,
        )


@pytest.mark.parametrize("dtype", [torch.float16, torch.bfloat16, torch.float32, torch.float64])
def test_archive_preserves_bits_including_nan_and_signed_zero(tmp_path: Path, dtype):
    values = torch.tensor([0.0, -0.0, float("inf"), -float("inf"), float("nan")], dtype=dtype)
    # Slicing makes the inputs non-contiguous, as real sampler views may be.
    video = values.repeat(24 * 3 * 4 * 2).reshape(1, 24, 3, 4, 10)[..., ::2]
    audio = values.repeat(32 * 2 * 2).reshape(1, 32, 2, 10)[..., ::2]
    path = save_h3_latent(
        {"samples": H3NestedPair(video, audio)}, tmp_path,
        seed=42, model_variant="h3_base", frames=22, width=80, height=64,
    )
    restored_video, restored_audio, manifest = read_h3_latent(path)
    for actual, expected in ((restored_video, video), (restored_audio, audio)):
        assert actual.device.type == "cpu"
        assert actual.dtype == expected.dtype
        assert torch.equal(actual.view(torch.uint8), expected.contiguous().view(torch.uint8))
    assert manifest["video_dtype"] == str(dtype)
    assert manifest["audio_dtype"] == str(dtype)
    assert len(manifest["video_sha256"]) == len(manifest["audio_sha256"]) == 64


def test_read_accepts_original_v1_archive_without_checksums(tmp_path: Path):
    _, video, audio = example_latent()
    manifest = {
        "format": "snarkroute.h3.av-latent.v1", "seed": 42,
        "model_variant": "h3_base", "frames": 22, "width": 80,
        "height": 64, "vae_mode": "stock",
        "video_shape": list(video.shape), "audio_shape": list(audio.shape),
    }
    path = tmp_path / "original.safetensors"
    save_file({"video": video, "audio": audio}, path, metadata={"h3_manifest": json.dumps(manifest)})
    restored_video, restored_audio, restored_manifest = read_h3_latent(path)
    assert torch.equal(restored_video, video)
    assert torch.equal(restored_audio, audio)
    assert restored_manifest == manifest


@pytest.mark.parametrize("container", [tuple, list])
def test_restored_av_pairs_can_be_saved_again(tmp_path: Path, container):
    _, video, audio = example_latent()
    path = save_h3_latent(
        {"samples": container((video, audio))}, tmp_path,
        seed=42, model_variant="h3_base", frames=22, width=80, height=64,
    )
    assert torch.equal(read_h3_latent(path)[0], video)


@pytest.mark.parametrize("invalid", ["audio_integer", "batch", "empty", "not_tensor"])
def test_rejects_malformed_streams_before_writing(tmp_path: Path, invalid):
    _, video, audio = example_latent()
    if invalid == "audio_integer":
        audio = audio.to(torch.int32)
    elif invalid == "batch":
        audio = audio.repeat(2, 1, 1, 1)
    elif invalid == "empty":
        video = video[:, :, :0]
    else:
        audio = None
    with pytest.raises(ValueError, match="shapes|dtypes|tensors"):
        save_h3_latent(
            {"samples": H3NestedPair(video, audio)}, tmp_path,
            seed=42, model_variant="h3_base", frames=22, width=80, height=64,
        )
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("stream", ["video", "audio"])
def test_rejects_corruption_even_when_shapes_match(tmp_path: Path, stream):
    latent, video, audio = example_latent()
    path = save_h3_latent(
        latent, tmp_path, seed=42, model_variant="h3_base", frames=22, width=80, height=64,
    )
    manifest = read_h3_latent(path)[2]
    tensors = {"video": video.clone(), "audio": audio.clone()}
    tensors[stream].flatten()[0] = 123
    save_file(tensors, path, metadata={"h3_manifest": json.dumps(manifest)})
    with pytest.raises(ValueError, match="checksum"):
        read_h3_latent(path)


@pytest.mark.parametrize("corrupt", ["json", "format", "shape", "dtype", "missing_audio"])
def test_rejects_invalid_archive_manifest_or_streams(tmp_path: Path, corrupt):
    latent, video, audio = example_latent()
    path = save_h3_latent(
        latent, tmp_path, seed=42, model_variant="h3_base", frames=22, width=80, height=64,
    )
    manifest = read_h3_latent(path)[2]
    tensors = {"video": video, "audio": audio}
    if corrupt == "format":
        manifest["format"] = "foreign-format"
    elif corrupt == "shape":
        manifest["audio_shape"][-1] += 1
    elif corrupt == "dtype":
        manifest["video_dtype"] = "torch.float64"
    elif corrupt == "missing_audio":
        tensors.pop("audio")
    metadata = "not json" if corrupt == "json" else json.dumps(manifest)
    save_file(tensors, path, metadata={"h3_manifest": metadata})
    with pytest.raises(ValueError):
        read_h3_latent(path)


def test_size_limit_is_checked_before_tensor_materialization(tmp_path: Path, monkeypatch):
    import safetensors

    latent, _, _ = example_latent()
    path = save_h3_latent(
        latent, tmp_path, seed=42, model_variant="h3_base", frames=22, width=80, height=64,
    )
    real_safe_open = safetensors.safe_open

    class HeaderOnlyArchive:
        def __init__(self, *args, **kwargs):
            self.archive = real_safe_open(*args, **kwargs)

        def __enter__(self):
            self.archive.__enter__()
            return self

        def __exit__(self, *args):
            return self.archive.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.archive, name)

        def get_tensor(self, name):
            raise AssertionError("Over-limit tensors must not be materialized")

    monkeypatch.setattr(safetensors, "safe_open", HeaderOnlyArchive)
    monkeypatch.setattr(h3_latent_archive, "MAX_CAPTURE_BYTES", 64)
    with pytest.raises(ValueError, match="safety limit"):
        read_h3_latent(path)
    with pytest.raises(ValueError, match="safety limit"):
        save_h3_latent(
            latent, tmp_path, seed=42, model_variant="h3_base", frames=22, width=80, height=64,
        )


def test_failed_save_removes_temporary_file(tmp_path: Path, monkeypatch):
    import safetensors.torch

    def fail(*args, **kwargs):
        raise OSError("simulated write failure")

    monkeypatch.setattr(safetensors.torch, "save_file", fail)
    latent, _, _ = example_latent()
    with pytest.raises(OSError, match="simulated"):
        save_h3_latent(
            latent, tmp_path, seed=42, model_variant="h3_base", frames=22, width=80, height=64,
        )
    assert not list(tmp_path.iterdir())


def test_rejects_oversized_header_before_safetensors_parses_it(tmp_path: Path):
    path = tmp_path / "huge-header.safetensors"
    path.write_bytes((h3_latent_archive.MAX_HEADER_BYTES + 1).to_bytes(8, "little"))
    with pytest.raises(ValueError, match="header exceeds safety limit"):
        read_h3_latent(path)


def test_assembled_archive_keeps_cumulative_extend_provenance(tmp_path: Path):
    latent, _, _ = example_latent()
    provenance = {
        "experimental": True, "overlap_frames": 22, "video_prefix_tokens": 4,
        "audio_prefix_cells": 37, "appended_frames": 102,
        "verified_prefix": True, "segment_count": 3,
    }
    path = save_h3_latent(
        latent, tmp_path, seed=42, model_variant="h3_base", frames=22,
        width=80, height=64, latent_extend=provenance,
    )
    provenance["segment_count"] = 99
    manifest = read_h3_latent(path)[2]
    assert manifest["latent_extend"]["segment_count"] == 3
    assert manifest["latent_extend"]["verified_prefix"] is True
    assert "assembled" in manifest["note"]
    assert manifest["video_sha256"] and manifest["audio_sha256"]


@pytest.mark.parametrize("invalid", ["type", "leaf", "nan", "size", "depth", "cycle", "key"])
def test_rejects_invalid_extend_provenance_before_creating_directory(tmp_path: Path, invalid):
    provenance = {"segment_count": 3}
    if invalid == "type":
        provenance = []
    elif invalid == "leaf":
        provenance["bad"] = object()
    elif invalid == "nan":
        provenance["bad"] = float("nan")
    elif invalid == "size":
        provenance["bad"] = "x" * (h3_latent_archive.MAX_HEADER_BYTES + 1)
    elif invalid == "depth":
        for _ in range(10):
            provenance = {"nested": provenance}
    elif invalid == "cycle":
        provenance["cycle"] = provenance
    else:
        provenance[123] = True
    latent, _, _ = example_latent()
    directory = tmp_path / "not-created"
    with pytest.raises(ValueError, match="provenance|manifest"):
        save_h3_latent(
            latent, directory, seed=42, model_variant="h3_base", frames=22,
            width=80, height=64, latent_extend=provenance,
        )
    assert not directory.exists()
