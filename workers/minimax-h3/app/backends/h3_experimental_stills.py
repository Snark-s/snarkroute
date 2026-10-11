"""Experimental MiniMax H3 still-image primitives for headless SnarkRoute.

No ComfyUI custom nodes or GUI required. This module is intentionally opt-in;
the production video pipeline remains unchanged until GPU acceptance tests.
Based on the documented Fizgig single-frame convention (MIT upstream).
"""
from __future__ import annotations


def still_latent(torch, nested_tensor_type, width: int, height: int, batch_size: int = 1, device="cpu"):
    if width < 64 or height < 64 or width % 32 or height % 32:
        raise ValueError("Still image width and height must be >=64 and multiples of 32")
    if not 1 <= batch_size <= 64:
        raise ValueError("Still image batch must be 1..64")
    video = torch.zeros((batch_size, 24, 1, height // 16, width // 16), device=device)
    audio = torch.zeros((batch_size, 32, 2, 2), device=device)
    return {"samples": nested_tensor_type((video, audio))}


def decode_still(torch, model_management, vae, samples):
    """Decode a one-frame H3 video latent with replicated causal context.

    The decoder expects a five-latent window; choose pixel frame index 3.
    Do not call the stock VAE.decode on a singleton (known stripe artifacts).
    Returns BHWC on the intermediate device. Does not modify the VAE.
    """
    latent = samples["samples"]
    if getattr(latent, "is_nested", False):
        latent = latent.unbind()[0]
    if latent.ndim != 5 or latent.shape[2] != 1:
        raise ValueError("Fizgig still decode requires exactly one latent frame")
    fsm = vae.first_stage_model
    if not hasattr(fsm, "_adaptive_decode") or not hasattr(fsm, "_finalize_pixels"):
        raise RuntimeError("Installed H3 video VAE lacks required still decode internals")
    group_shape = (1, latent.shape[1], 5, latent.shape[3], latent.shape[4])
    required = vae.memory_used_decode(group_shape, vae.vae_dtype)
    model_management.load_models_gpu(
        [vae.patcher], memory_required=required,
        force_full_load=getattr(vae, "disable_offload", False),
    )
    frames = []
    with torch.inference_mode():
        for b in range(latent.shape[0]):
            z = latent[b:b+1].to(device=vae.device, dtype=vae.vae_dtype)
            mean = fsm.latents_mean.view(1, -1, 1, 1, 1).to(z)
            std = fsm.latents_std.view(1, -1, 1, 1, 1).to(z)
            raw = fsm._adaptive_decode((z * std + mean).repeat(1, 1, 5, 1, 1))
            pixels = fsm._finalize_pixels(raw[:, :, 3:4])
            frames.append(pixels[:, :, 0].movedim(1, -1).to(model_management.intermediate_device()))
    return torch.cat(frames, dim=0)


def x2_decoder_geometry(decoder):
    """Validate that an H3 VAE projection is RGB or 2x packed RGB."""
    from math import isqrt
    rows = int(decoder.proj_out.weight.shape[0])
    volume = int(decoder.patch_size_t) * int(decoder.patch_size) ** 2
    if rows % volume:
        raise ValueError("VAE projection rows not divisible by patch volume")
    channels = rows // volume
    if channels % 3:
        raise ValueError("VAE output isn't packed RGB")
    ratio = isqrt(channels // 3)
    if ratio * ratio != channels // 3 or ratio not in (1, 2):
        raise ValueError(f"Unsupported VAE PixelShuffle ratio: {channels} channels")
    return channels, ratio


def decode_x2_video(torch, model_management, vae, samples, tile_size=256, tile_overlap=64):
    """Opt-in packed RGB H3 decode, then spatial PixelShuffle x2.

    Avoid stock VAEDecode: its generic out-of-memory fallback does not
    preserve H3 video blending and it cannot unpack 12-channel RGB.
    """
    import torch.nn.functional as nnf

    latent = samples["samples"]
    if getattr(latent, "is_nested", False):
        latent = latent.unbind()[0]
    if latent.ndim != 5:
        raise ValueError("Expected B,C,T,H,W H3 video latent")
    vae.throw_exception_if_invalid()
    inner = vae.first_stage_model
    channels, upscale = x2_decoder_geometry(inner.decoder)
    if (channels, upscale) != (12, 2):
        raise ValueError("This checkpoint is not a MiniMax H3 2X VAE")
    if tile_size < 256 or tile_size % 16 or tile_overlap < 16 or tile_overlap % 16 or tile_overlap >= tile_size:
        raise ValueError("Invalid H3 VAE tile/overlap configuration")
    overlap = max(tile_overlap, tile_size // 4)
    state = (
        inner.tiling, inner.tile_size, inner.tile_overlap_min,
        inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std,
    )
    try:
        inner.tiling = True
        inner.tile_size = tile_size
        inner.tile_overlap_min = overlap
        inner.decoder.out_channels = channels
        with torch.inference_mode(), model_management.cuda_device_context(vae.device):
            mem = vae.memory_used_decode(latent.shape, vae.vae_dtype)
            model_management.load_models_gpu(
                [vae.patcher], memory_required=mem,
                force_full_load=getattr(vae, "disable_offload", False),
            )
            # Expand per-RGB-channel normalization into packed subpixel channels
            # after DynamicVRAM loads, because loading can restore stock buffers.
            def expand_rgb(stat):
                if 12 in stat.shape:
                    return stat
                dim = 1 if stat.ndim > 1 and stat.shape[1] == 3 else next(
                    (d for d, size in enumerate(stat.shape) if size == 3), None
                )
                if dim is None:
                    raise ValueError("X2 VAE has unexpected RGB normalization")
                return stat.repeat_interleave(4, dim=dim)

            inner.pixel_mean = expand_rgb(inner.pixel_mean)
            inner.pixel_std = expand_rgb(inner.pixel_std)
            device = model_management.intermediate_device()
            buf = torch.empty(
                inner.decode_output_shape(latent.shape), device=device,
                dtype=vae.vae_output_dtype(),
            )
            inner.decode(latent.to(device=vae.device, dtype=vae.vae_dtype), output_buffer=buf)
            vae.process_output(buf)
            batch, _, frames, height, width = buf.shape
            pixels = buf.permute(0, 2, 1, 3, 4).reshape(batch * frames, 12, height, width)
            pixels = nnf.pixel_shuffle(pixels, 2)
            return pixels.permute(0, 2, 3, 1).contiguous()
    finally:
        (
            inner.tiling, inner.tile_size, inner.tile_overlap_min,
            inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std,
        ) = state
