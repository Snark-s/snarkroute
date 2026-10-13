"""Opt-in MiniMax H3 AV latent archive for reproducible chaining experiments.

This module captures exact post-denoiser or explicitly assembled AV tensors
without a decode/encode round trip. Automatic worker capture is disabled unless
H3_LATENT_CAPTURE_DIR is configured; offline tools may explicitly save archives.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

MAX_CAPTURE_BYTES = 1024**3  # Prevent accidentally archiving malformed tensors.
MAX_HEADER_BYTES = 64 * 1024
FORMAT = "snarkroute.h3.av-latent.v1"
_FLOAT_DTYPES = {
    "F16": (2, "torch.float16"),
    "BF16": (2, "torch.bfloat16"),
    "F32": (4, "torch.float32"),
    "F64": (8, "torch.float64"),
}


def _validate_shapes(video_shape, audio_shape):
    if (
        len(video_shape) != 5 or video_shape[1] != 24
        or len(audio_shape) != 4 or tuple(audio_shape[1:3]) != (32, 2)
        or video_shape[0] != audio_shape[0]
        or any(dimension <= 0 for dimension in (*video_shape, *audio_shape))
    ):
        raise ValueError("Invalid MiniMax H3 AV latent stream shapes")


def _validate_av_tensors(video, audio):
    import torch

    if not isinstance(video, torch.Tensor) or not isinstance(audio, torch.Tensor):
        raise ValueError("Expected MiniMax H3 AV tensors")
    _validate_shapes(video.shape, audio.shape)
    valid_dtypes = {torch.float16, torch.bfloat16, torch.float32, torch.float64}
    if (
        video.layout != torch.strided or audio.layout != torch.strided
        or video.dtype not in valid_dtypes or audio.dtype not in valid_dtypes
    ):
        raise ValueError("Invalid MiniMax H3 AV latent stream dtypes or layout")
    size_bytes = video.numel() * video.element_size() + audio.numel() * audio.element_size()
    if size_bytes > MAX_CAPTURE_BYTES:
        raise ValueError("H3 latent capture exceeds safety limit")
    return video, audio


def _tensor_sha256(tensor) -> str:
    import torch

    # Byte view preserves NaN payloads, signed zero and bfloat16 exactly. The
    # memoryview avoids allocating a second complete tensor-sized byte string.
    return hashlib.sha256(memoryview(tensor.view(torch.uint8).numpy())).hexdigest()


def _normalize_extend_provenance(provenance: dict[str, Any] | None):
    if provenance is None:
        return None
    if not isinstance(provenance, dict):
        raise ValueError("H3 latent extend provenance must be a JSON object")
    pending = [(provenance, 0)]
    inspected = 0
    while pending:
        value, depth = pending.pop()
        inspected += 1
        if depth > 8 or inspected > 256:
            raise ValueError("H3 latent extend provenance exceeds structure limit")
        if isinstance(value, dict):
            if len(value) > 256 or any(not isinstance(key, str) for key in value):
                raise ValueError("H3 latent extend provenance requires bounded JSON string keys")
            pending.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            if len(value) > 256:
                raise ValueError("H3 latent extend provenance exceeds structure limit")
            pending.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            if len(value) > MAX_HEADER_BYTES:
                raise ValueError("H3 latent extend provenance exceeds safety limit")
        elif value is not None and not isinstance(value, bool | int | float):
            raise ValueError("H3 latent extend provenance must contain JSON values only")
    try:
        encoded = json.dumps(provenance, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("H3 latent extend provenance must contain finite JSON values") from error
    if len(encoded.encode("utf-8")) > MAX_HEADER_BYTES:
        raise ValueError("H3 latent extend provenance exceeds safety limit")
    return json.loads(encoded)


def _get_av_tensors(latent: dict[str, Any]):
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError("Expected a ComfyUI LATENT dictionary with 'samples'")
    samples = latent["samples"]
    # MiniMax H3 samples are a NestedTensor(video, audio). Normal indexing into
    # NestedTensor is NOT stream selection: it indexes both tensors instead.
    parts = samples if isinstance(samples, tuple | list) else getattr(samples, "tensors", None)
    if parts is None and hasattr(samples, "unbind"):
        parts = samples.unbind()
    if not isinstance(parts, tuple | list) or len(parts) != 2:
        raise ValueError("Expected MiniMax H3 paired video/audio NestedTensor")
    return _validate_av_tensors(*parts)


def save_h3_latent(latent: dict[str, Any], directory: Path, *,
                   seed: int, model_variant: str, frames: int,
                   width: int, height: int, vae_mode: str = "stock",
                   latent_extend: dict[str, Any] | None = None) -> Path:
    """Persist video+audio tensors atomically in safetensors, with simple metadata.

    Capture metadata omits prompts and reference content. Explicit assembled
    provenance should contain only chaining geometry and flags. The caller
    controls retention; the normal worker output is unaffected when disabled.
    """
    from safetensors.torch import save_file

    provenance = _normalize_extend_provenance(latent_extend)
    video, audio = _get_av_tensors(latent)
    destination = Path(directory)
    if not destination.is_absolute():
        raise ValueError("H3_LATENT_CAPTURE_DIR must be an absolute directory")
    target = destination / ("h3-" + uuid.uuid4().hex + ".safetensors")
    metadata = {
        "format": FORMAT,
        "seed": int(seed),
        "model_variant": str(model_variant),
        "frames": int(frames),
        "width": int(width),
        "height": int(height),
        "vae_mode": str(vae_mode),
        "video_shape": list(video.shape),
        "audio_shape": list(audio.shape),
        "note": "raw H3 post-sampler latents; not a stitched or decoded video",
    }
    if provenance is not None:
        metadata["latent_extend"] = provenance
        metadata["note"] = "assembled H3 AV latent sequence; experimental latent extend"
    # Keep the denoiser dtype and bits; never use a floating-point conversion.
    # clone also breaks shared storage between streams before safetensors saves.
    tensors = {
        "video": video.detach().to("cpu").contiguous().clone(),
        "audio": audio.detach().to("cpu").contiguous().clone(),
    }
    for name, tensor in tensors.items():
        metadata[name + "_dtype"] = str(tensor.dtype)
        metadata[name + "_sha256"] = _tensor_sha256(tensor)
    manifest_json = json.dumps(metadata, sort_keys=True, allow_nan=False)
    # safetensors quotes the manifest inside its metadata JSON. Bound that
    # representation too, reserving room for two small tensor descriptors.
    quoted_manifest = json.dumps({"h3_manifest": manifest_json}, ensure_ascii=False)
    if len(quoted_manifest.encode("utf-8")) + 1024 > MAX_HEADER_BYTES:
        raise ValueError("H3 latent archive manifest exceeds safety limit")
    destination.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".h3-", suffix=".tmp", dir=destination)
    os.close(fd)
    try:
        save_file(tensors, temporary, metadata={"h3_manifest": manifest_json})
        with open(temporary, "rb+") as written:
            os.fsync(written.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target


def read_h3_latent(path: Path):
    """Return (video, audio, metadata) on CPU, validating before materialization.

    Original v1 archives without dtype/checksum fields remain readable. New
    archives additionally verify bit-level SHA-256 integrity for both streams.
    safetensors is data-only: this function never unpickles executable objects.
    """
    from safetensors import safe_open

    path = Path(path)
    if path.stat().st_size > MAX_CAPTURE_BYTES + MAX_HEADER_BYTES:
        raise ValueError("H3 latent archive exceeds safety limit")
    with path.open("rb") as source:
        header_length_bytes = source.read(8)
    if len(header_length_bytes) != 8:
        raise ValueError("Invalid H3 latent archive header")
    if int.from_bytes(header_length_bytes, "little") > MAX_HEADER_BYTES:
        raise ValueError("H3 latent archive header exceeds safety limit")
    with safe_open(str(path), framework="pt", device="cpu") as archive:
        header = archive.metadata() or {}
        manifest_json = header.get("h3_manifest", "null")
        if len(manifest_json.encode("utf-8")) > MAX_HEADER_BYTES:
            raise ValueError("H3 latent manifest exceeds safety limit")
        try:
            metadata = json.loads(manifest_json)
        except (json.JSONDecodeError, TypeError) as error:
            raise ValueError("Invalid H3 latent archive manifest") from error
        if not isinstance(metadata, dict) or metadata.get("format") != FORMAT:
            raise ValueError("Not a SnarkRoute H3 AV latent archive")
        if "latent_extend" in metadata:
            if not isinstance(metadata["latent_extend"], dict):
                raise ValueError("H3 latent extend provenance must be a JSON object")
            _normalize_extend_provenance(metadata["latent_extend"])
        if set(archive.keys()) != {"video", "audio"}:
            raise ValueError("Incomplete MiniMax H3 AV latent archive")
        slices = {name: archive.get_slice(name) for name in ("video", "audio")}
        shapes = {name: tensor_slice.get_shape() for name, tensor_slice in slices.items()}
        _validate_shapes(shapes["video"], shapes["audio"])
        size_bytes = 0
        for name, tensor_slice in slices.items():
            dtype = _FLOAT_DTYPES.get(tensor_slice.get_dtype())
            if dtype is None:
                raise ValueError("Invalid MiniMax H3 AV latent stream dtypes")
            size_bytes += math.prod(shapes[name]) * dtype[0]
            if shapes[name] != metadata.get(name + "_shape"):
                raise ValueError("H3 latent shapes disagree with the archive manifest")
            if name + "_dtype" in metadata and metadata[name + "_dtype"] != dtype[1]:
                raise ValueError("H3 latent dtypes disagree with the archive manifest")
        if size_bytes > MAX_CAPTURE_BYTES:
            raise ValueError("H3 latent archive exceeds safety limit")
        video = archive.get_tensor("video")
        audio = archive.get_tensor("audio")
    _validate_av_tensors(video, audio)
    for name, tensor in (("video", video), ("audio", audio)):
        if name + "_sha256" in metadata and metadata[name + "_sha256"] != _tensor_sha256(tensor):
            raise ValueError("H3 latent checksum mismatch for " + name)
    return video, audio, metadata
