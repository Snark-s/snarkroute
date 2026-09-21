from __future__ import annotations

import gc
import importlib.metadata
import json
import logging
import os
import secrets
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from ..config import Settings
from ..models import GenerateRequest
from .matlow_int8 import COMFY_KITCHEN_VERSION, COMFYUI_REVISION

GIB = 1024**3

MODEL_SPECS = {
    "h3_base": {
        "revision": "8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3",
        "quantization": "int8_convrot",
        "sampler": "res_multistep",
        "scheduler": "simple",
        "fused_turbo": True,
    },
    "10eros_max": {
        "revision": "8a198588c8870ab0d613b3492a3150d091c8c2dd",
        "quantization": "w4a8_14gb_optimized",
        "sampler": "res_multistep",
        "scheduler": "simple",
        "fused_turbo": False,
    },
    "10eros_max_turbo": {
        "revision": "8a198588c8870ab0d613b3492a3150d091c8c2dd",
        "quantization": "w4a8_14gb_optimized",
        "sampler": "lcm",
        "scheduler": "simple",
        "fused_turbo": True,
    },
}


class _ResourceMonitor:
    def __init__(self, max_swap_gib: float, interrupt):
        self.max_swap_bytes = int(max_swap_gib * GIB)
        self.interrupt = interrupt
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.peak_ram = 0
        self.peak_system_ram = 0
        self.peak_swap = 0
        self.peak_swap_growth = 0
        self.swap_baseline = 0
        self.abort_reason: str | None = None

    def __enter__(self):
        import psutil

        self.swap_baseline = psutil.swap_memory().used
        self.thread = threading.Thread(target=self._run, name="h3-resource-monitor", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def _run(self) -> None:
        import psutil

        process = psutil.Process()
        while not self.stop_event.wait(0.5):
            self.peak_ram = max(self.peak_ram, process.memory_info().rss)
            self.peak_system_ram = max(self.peak_system_ram, psutil.virtual_memory().used)
            swap_used = psutil.swap_memory().used
            self.peak_swap = max(self.peak_swap, swap_used)
            swap_growth = max(0, swap_used - self.swap_baseline)
            self.peak_swap_growth = max(self.peak_swap_growth, swap_growth)
            if swap_growth > self.max_swap_bytes and not self.abort_reason:
                self.abort_reason = (
                    f"swap growth exceeded {self.max_swap_bytes / GIB:.1f} GiB; "
                    "generation was interrupted to prevent swap thrashing"
                )
                self.interrupt()


class MatlowRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._modules: dict[str, Any] | None = None
        self._models: dict[str, Any] | None = None
        self._probe_status: dict[str, Any] | None = None
        self._probe_lock = threading.Lock()
        self._lock = threading.Lock()

    def model_path(self, variant: str) -> Path:
        return {
            "h3_base": self.settings.matlow_transformer_file,
            "10eros_max": self.settings.matlow_10eros_max_file,
            "10eros_max_turbo": self.settings.matlow_10eros_max_turbo_file,
        }[variant]

    def unload(self) -> None:
        """Release every loaded component while keeping the worker process healthy."""
        modules = self._imports()
        model_management = modules["model_management"]
        self._models = None
        model_management.unload_all_models()
        gc.collect()
        model_management.soft_empty_cache(force=True)
        modules["torch"].cuda.empty_cache()
        model_management.interrupt_current_processing(False)

    def _imports(self) -> dict[str, Any]:
        if self._modules is not None:
            return self._modules
        comfyui_dir = str(self.settings.matlow_comfyui_dir)
        if comfyui_dir not in sys.path:
            sys.path.insert(0, comfyui_dir)
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")

        # A headless library import does not run ComfyUI's CLI parser. Pin the
        # local_fast VAE activation dtype explicitly; otherwise the default is
        # FP32 and the MiniMax video decoder exceeds a 16 GiB Ampere card.
        import comfy.cli_args

        comfy.cli_args.args.fp16_vae = True
        comfy.cli_args.args.bf16_vae = False
        comfy.cli_args.args.fp32_vae = False
        comfy.cli_args.args.novram = self.settings.matlow_memory_mode == "novram"
        comfy.cli_args.args.disable_dynamic_vram = self.settings.matlow_memory_mode != "dynamic"
        if self.settings.matlow_memory_mode == "dynamic":
            import comfy_aimdo.control

            try:
                comfy_aimdo.control.init(nvml_pressure=True)
            except TypeError:
                comfy_aimdo.control.init()
        import comfy.memory_management
        import comfy.model_management as model_management

        if self.settings.matlow_memory_mode == "dynamic":
            import comfy.model_patcher

            try:
                aimdo_initialized = comfy_aimdo.control.init_devices(
                    (device.index, int(self.settings.matlow_vram_headroom_gib * GIB))
                    for device in model_management.get_all_torch_devices()
                )
            except TypeError:
                aimdo_initialized = comfy_aimdo.control.init_devices(
                    device.index for device in model_management.get_all_torch_devices()
                )
            if not aimdo_initialized:
                raise RuntimeError("comfy-aimdo DynamicVRAM initialization failed")
            comfy.model_patcher.CoreModelPatcher = comfy.model_patcher.ModelPatcherDynamic
            comfy.memory_management.aimdo_enabled = True
        import comfy.sd
        import comfy.utils
        import torch
        from comfy_api.latest import Types
        from comfy_extras.nodes_audio import VAEDecodeAudio
        from comfy_extras.nodes_custom_sampler import (
            BasicGuider,
            BasicScheduler,
            KSamplerSelect,
            RandomNoise,
            SamplerCustomAdvanced,
        )
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo, MiniMaxH3SigmaShift
        from comfy_extras.nodes_video import CreateVideo
        from nodes import VAEDecode

        self._modules = {
            "torch": torch,
            "comfy": comfy,
            "model_management": model_management,
            "Types": Types,
            "VAEDecodeAudio": VAEDecodeAudio,
            "BasicGuider": BasicGuider,
            "BasicScheduler": BasicScheduler,
            "KSamplerSelect": KSamplerSelect,
            "RandomNoise": RandomNoise,
            "SamplerCustomAdvanced": SamplerCustomAdvanced,
            "MiniMaxH3ImageToVideo": MiniMaxH3ImageToVideo,
            "MiniMaxH3ReferenceToVideo": MiniMaxH3ReferenceToVideo,
            "MiniMaxH3SigmaShift": MiniMaxH3SigmaShift,
            "CreateVideo": CreateVideo,
            "VAEDecode": VAEDecode,
        }
        return self._modules

    def probe(self) -> dict[str, Any]:
        if self._probe_status is not None:
            return self._probe_status
        with self._probe_lock:
            if self._probe_status is not None:
                return self._probe_status
            return self._probe_locked()

    def _probe_locked(self) -> dict[str, Any]:
        try:
            modules = self._imports()
            torch = modules["torch"]
            if not torch.cuda.is_available():
                self._probe_status = {"ready": False, "reason": "CUDA is unavailable"}
                return self._probe_status
            comfy_revision = subprocess.run(
                ["git", "-C", str(self.settings.matlow_comfyui_dir), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            if comfy_revision != COMFYUI_REVISION:
                raise RuntimeError(
                    f"ComfyUI core revision mismatch: expected {COMFYUI_REVISION}, got {comfy_revision}"
                )
            kitchen_version = importlib.metadata.version("comfy-kitchen")
            if kitchen_version != COMFY_KITCHEN_VERSION:
                raise RuntimeError(
                    f"comfy-kitchen version mismatch: expected {COMFY_KITCHEN_VERSION}, got {kitchen_version}"
                )
            self._run_kernel_selftest(torch)
            properties = torch.cuda.get_device_properties(0)
            self._probe_status = {
                "ready": True,
                "gpu": properties.name,
                "compute_capability": f"{properties.major}.{properties.minor}",
                "cuda": torch.version.cuda,
                "torch": torch.__version__,
                "comfy_kitchen": kitchen_version,
                "kernel": "comfy_kitchen.int8_linear.cuda",
                "fallback": False,
                "dtype": "int8_convrot/bfloat16",
                "vae_dtype": "float16",
                "memory_mode": self.settings.matlow_memory_mode,
                "vram_headroom_gib": self.settings.matlow_vram_headroom_gib,
                "vram_gib": properties.total_memory / GIB,
                "native_audio": self.settings.matlow_native_audio,
                "profile": self.settings.matlow_profile,
            }
            logging.info("H3 MATLOW runtime: %s", json.dumps(self._probe_status, sort_keys=True))
        except Exception as exc:
            self._probe_status = {
                "ready": False,
                "reason": f"{type(exc).__name__}: {exc}",
            }
        return self._probe_status

    @staticmethod
    def _run_kernel_selftest(torch) -> None:
        import comfy_kitchen  # noqa: F401
        from comfy_kitchen.tensor.int8 import TensorWiseINT8Layout

        if not hasattr(torch.ops.comfy_kitchen, "int8_linear"):
            raise RuntimeError("comfy-kitchen did not register int8_linear")
        activation = torch.randn((16, 256), device="cuda", dtype=torch.bfloat16)
        weight = torch.randn((256, 256), device="cuda", dtype=torch.bfloat16)
        qdata, params = TensorWiseINT8Layout.quantize(
            weight,
            is_weight=True,
            per_channel=True,
            convrot=True,
            convrot_groupsize=256,
            stochastic_rounding=0,
        )
        output = torch.ops.comfy_kitchen.int8_linear(activation, qdata, params.scale, None, 2, True, 256)
        torch.cuda.synchronize()
        if output.shape != (16, 256) or not torch.isfinite(output).all().item():
            raise RuntimeError("comfy-kitchen INT8 ConvRot CUDA self-test failed")

    def _load_models(self) -> tuple[dict[str, Any], float]:
        if self._models is not None:
            return self._models, 0.0
        modules = self._imports()
        comfy_sd = modules["comfy"].sd
        comfy_utils = modules["comfy"].utils
        started = time.perf_counter()

        def load_vae(path: Path):
            state, metadata = comfy_utils.load_torch_file(str(path), return_metadata=True)
            vae = comfy_sd.VAE(sd=state, metadata=metadata)
            vae.throw_exception_if_invalid()
            return vae

        video_vae = load_vae(self.settings.matlow_video_vae_file)
        video_vae.first_stage_model.tile_size = self.settings.matlow_vae_tile_size
        video_vae.first_stage_model.tile_overlap_min = self.settings.matlow_vae_tile_overlap
        audio_vae = (
            load_vae(self.settings.matlow_audio_vae_file) if self.settings.matlow_native_audio else None
        )
        self._models = {
            "video_vae": video_vae,
            "audio_vae": audio_vae,
        }
        return self._models, time.perf_counter() - started

    def generate(
        self,
        request: GenerateRequest,
        output_path: Path,
        variant_index: int,
        stage_callback: Callable[[float, str], None] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            return self._generate_locked(request, output_path, variant_index, stage_callback)

    def _generate_locked(
        self,
        request: GenerateRequest,
        output_path: Path,
        variant_index: int,
        stage_callback: Callable[[float, str], None] | None,
    ) -> dict[str, Any]:
        status = self.probe()
        if not status.get("ready"):
            raise RuntimeError(status.get("reason") or "MATLOW runtime is not ready")
        modules = self._imports()
        torch = modules["torch"]
        model_management = modules["model_management"]
        model_management.interrupt_current_processing(False)
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        input_bytes = 0
        model_spec = MODEL_SPECS[request.model_variant]
        transformer_path = self.model_path(request.model_variant)
        steps = request.effective_steps
        self._log_vram(torch, "before component loading", "none")

        with _ResourceMonitor(self.settings.matlow_max_swap_gib, self.cancel) as resources:
            try:
                models, model_load_seconds = self._load_models()
                self._log_vram(torch, "after VAE loading", "video_vae,audio_vae")
                _report(stage_callback, 0.2, "models_loaded")
                width, height = _dimensions(request.target.aspect_ratio if request.target else "16:9")
                duration = request.target.duration_seconds if request.target else 5.0
                frames = _frame_count(duration)
                seed = (
                    (request.seed if request.seed is not None else secrets.randbelow(2**31)) + variant_index
                ) % (2**31)
                first_frame = None
                last_frame = None
                reference_inputs = None
                if request.task == "ref2va":
                    _report(stage_callback, 0.21, "loading_references")
                    reference_inputs, input_bytes = _reference_inputs(request.conditions, torch)
                for condition in ([] if reference_inputs is not None else request.conditions):
                    if condition.get("type") != "image" or condition.get("role") != "keyframe":
                        raise RuntimeError("matlow_int8 FL2VA accepts keyframe images only")
                    path = _file_uri_path(str(condition["uri"]))
                    input_bytes += path.stat().st_size
                    image = _load_image(path, torch)
                    if condition.get("frame_index") == 0:
                        first_frame = image
                    elif condition.get("frame_index") == -1:
                        last_frame = image

                text_started = time.perf_counter()
                clip = modules["comfy"].sd.load_clip(
                    ckpt_paths=[str(self.settings.matlow_text_encoder_file)],
                    embedding_directory=[],
                    clip_type=modules["comfy"].sd.CLIPType.MINIMAX,
                )
                try:
                    # ComfyUI's graph executor normally supplies inference mode. This
                    # headless adapter calls the node directly, so enable it explicitly;
                    # otherwise first-frame VAE encode retains an autograd graph and can
                    # exhaust a 16 GiB device before diffusion starts.
                    with torch.inference_mode():
                        if reference_inputs is not None:
                            conditioning, latent = modules["MiniMaxH3ReferenceToVideo"].execute(
                                clip, models["video_vae"], models["audio_vae"],
                                request.prompt.strip(), width, height, frames,
                                ref_image_size="match", **reference_inputs,
                            ).result
                        else:
                            conditioning, latent = modules["MiniMaxH3ImageToVideo"].execute(
                                clip,
                                models["video_vae"],
                                request.prompt.strip(),
                                width,
                                height,
                                frames,
                                first_frame=first_frame,
                                last_frame=last_frame,
                            ).result
                        # Raw video frames are no longer needed after conditioning.
                        reference_inputs = None
                finally:
                    clip_patcher = getattr(clip, "patcher", None)
                    if clip_patcher is not None:
                        model_management.unload_model_and_clones(clip_patcher, all_devices=True)
                    del clip
                    # The video VAE is only needed to encode keyframes here and to
                    # decode after diffusion. Recreate it after DiT is released instead
                    # of keeping another ~2.6 GiB of weights resident in host memory.
                    video_vae = models.get("video_vae")
                    vae_patcher = getattr(video_vae, "patcher", None)
                    if vae_patcher is not None:
                        model_management.unload_model_and_clones(vae_patcher, all_devices=True)
                    models.clear()
                    self._models = None
                    del video_vae, first_frame, last_frame
                    gc.collect()
                    model_management.soft_empty_cache(force=True)
                text_encoder_seconds = time.perf_counter() - text_started
                _report(stage_callback, 0.35, "conditioning_ready")

                diffusion_model_started = time.perf_counter()
                model = modules["comfy"].sd.load_diffusion_model(str(transformer_path))
                model_load_seconds += time.perf_counter() - diffusion_model_started
                self._log_vram(torch, "after transformer loading", request.model_variant)
                shifted = modules["MiniMaxH3SigmaShift"].execute(model, shift_video=12.0, shift_audio=3.0)[0]
                sampler = modules["KSamplerSelect"].execute(model_spec["sampler"])[0]
                sigmas = modules["BasicScheduler"].execute(shifted, model_spec["scheduler"], steps, 1.0)[0]
                guider = modules["BasicGuider"].execute(shifted, conditioning)[0]
                noise = modules["RandomNoise"].execute(seed)[0]
                diffusion_started = time.perf_counter()
                sampled = modules["SamplerCustomAdvanced"].execute(noise, guider, sampler, sigmas, latent)[0]
                torch.cuda.synchronize()
                diffusion_seconds = time.perf_counter() - diffusion_started
                _report(stage_callback, 0.75, "diffusion_complete")

                # The 16 GiB profile cannot keep the diffusion model resident while the
                # video VAE materializes 124 decoded frames. Comfy's own model manager
                # performs the offload; tiled decoding bounds the VAE working set.
                model_management.unload_model_and_clones(model, all_devices=True)
                del conditioning, guider, noise, sigmas, sampler, latent, shifted, model
                gc.collect()
                model_management.unload_all_models()
                model_management.soft_empty_cache(force=True)
                torch.cuda.synchronize()
                logging.info(
                    "H3 MATLOW before VAE: allocated=%.2f GiB reserved=%.2f GiB peak=%.2f GiB",
                    torch.cuda.memory_allocated() / GIB,
                    torch.cuda.memory_reserved() / GIB,
                    torch.cuda.max_memory_reserved() / GIB,
                )
                _report(stage_callback, 0.78, "diffusion_offloaded")
                models, vae_reload_seconds = self._load_models()
                model_load_seconds += vae_reload_seconds
                vae_started = time.perf_counter()
                # MiniMaxH3VideoVAE owns its spatial and temporal chunking and ignores
                # the generic VAEDecodeTiled arguments. Configure its internal tile
                # above, then use the ordinary node so the actual memory bound is clear.
                with torch.inference_mode():
                    images = modules["VAEDecode"]().decode(models["video_vae"], sampled)[0]
                torch.cuda.synchronize()
                vae_decode_seconds = time.perf_counter() - vae_started
                _report(stage_callback, 0.86, "video_decoded")
                audio = None
                audio_seconds = None
                if self.settings.matlow_native_audio:
                    audio_started = time.perf_counter()
                    with torch.inference_mode():
                        audio = modules["VAEDecodeAudio"].execute(models["audio_vae"], sampled)[0]
                    torch.cuda.synchronize()
                    audio_seconds = time.perf_counter() - audio_started

                video = modules["CreateVideo"].execute(
                    images, 24.0, audio=audio, bit_depth=8, color_space="sRGB"
                )[0]
                output_path.parent.mkdir(parents=True, exist_ok=True)
                video.save_to(
                    str(output_path),
                    format=modules["Types"].VideoContainer("mp4"),
                    codec=modules["Types"].VideoCodec("h264"),
                    metadata=None,
                )
                _report(stage_callback, 0.9, "video_encoded")
                if resources.abort_reason:
                    raise RuntimeError(resources.abort_reason)
            except torch.cuda.OutOfMemoryError as exc:
                self.unload()
                raise RuntimeError(
                    f"CUDA out of memory in {request.model_variant}; all H3 components were unloaded and the worker is ready for another job"
                ) from exc
            except Exception as exc:
                if resources.abort_reason:
                    raise RuntimeError(resources.abort_reason) from exc
                raise
            except BaseException as exc:
                if type(exc).__name__ == "InterruptProcessingException" and resources.abort_reason:
                    raise RuntimeError(resources.abort_reason) from exc
                raise

        with output_path.open("rb") as stream:
            prefix = stream.read(12)
        if len(prefix) < 8 or prefix[4:8] != b"ftyp":
            raise RuntimeError("headless runtime did not produce a valid MP4")
        render_seconds = time.perf_counter() - started
        result = {
            **status,
            "resolution": f"{width}x{height}",
            "frames": frames,
            "duration_seconds": duration,
            "seed": seed,
            "model_variant": request.model_variant,
            "model_revision": model_spec["revision"],
            "quantization": model_spec["quantization"],
            "sampler": model_spec["sampler"],
            "scheduler": model_spec["scheduler"],
            "steps": steps,
            "fused_turbo": model_spec["fused_turbo"],
            "attention_backend": "dense",
            "vae_tile_size": self.settings.matlow_vae_tile_size,
            "model_load_seconds": model_load_seconds,
            "text_encoder_seconds": text_encoder_seconds,
            "diffusion_seconds": diffusion_seconds,
            "vae_decode_seconds": vae_decode_seconds,
            "audio_seconds": audio_seconds,
            "render_time_seconds": render_seconds,
            # DynamicVRAM allocations are not all visible to PyTorch's reserved
            # counter. Runbooks label this as an allocator peak; NVML polling is
            # deliberately disabled because it conflicts with this Aimdo build.
            "peak_vram_gib": torch.cuda.max_memory_reserved() / GIB,
            "peak_ram_gib": resources.peak_ram / GIB,
            "peak_system_ram_gib": resources.peak_system_ram / GIB,
            "peak_swap_gib": resources.peak_swap / GIB,
            "peak_swap_growth_gib": resources.peak_swap_growth / GIB,
            "input_bytes": input_bytes,
        }
        logging.info("H3 MATLOW benchmark: %s", json.dumps(result, sort_keys=True))
        return result

    @staticmethod
    def _log_vram(torch, stage: str, resident: str) -> None:
        logging.info(
            "H3 VRAM %s: allocated=%.2f GiB reserved=%.2f GiB peak=%.2f GiB resident=%s",
            stage,
            torch.cuda.memory_allocated() / GIB,
            torch.cuda.memory_reserved() / GIB,
            torch.cuda.max_memory_reserved() / GIB,
            resident,
        )

    def cancel(self) -> None:
        try:
            self._imports()["model_management"].interrupt_current_processing(True)
        except Exception:
            logging.exception("Could not interrupt MATLOW runtime")


def _file_uri_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise RuntimeError("matlow_int8 requires worker-uploaded file:/// inputs")
    return Path(url2pathname(unquote(parsed.path))).resolve()


def _report(callback: Callable[[float, str], None] | None, value: float, stage: str) -> None:
    if callback is not None:
        callback(value, stage)


def _load_image(path: Path, torch):
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None, ...]


def _reference_inputs(conditions, torch):
    refs = {"ref_images": {}, "ref_videos": {}}
    input_bytes = 0
    for condition in conditions:
        kind = condition.get("type")
        if kind not in {"image", "video"}:
            raise ValueError("Local Ref2VA supports image and video references only")
        path = _file_uri_path(str(condition["uri"]))
        input_bytes += path.stat().st_size
        if kind == "image":
            refs["ref_images"][f"ref_image_{len(refs['ref_images']) + 1}"] = _load_image(path, torch)
        else:
            refs["ref_videos"][f"ref_video_{len(refs['ref_videos']) + 1}"] = _load_reference_video(
                path,
                torch,
                condition.get("start_time_seconds", 0),
                condition.get("visual_mode", "full"),
            )
    return refs, input_bytes


def _load_reference_video(path: Path, torch, start_time=0, visual_mode="full"):
    import math
    import numpy as np

    start_time = float(start_time)
    if not math.isfinite(start_time) or start_time < 0:
        raise ValueError("Reference video start time must be finite and non-negative")
    if visual_mode not in {"full", "motion"}:
        raise ValueError("Reference video visual mode must be full or motion")
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height", "-of", "json", str(path),
    ], capture_output=True, check=True, timeout=30)
    streams = json.loads(probe.stdout).get("streams", [])
    if not streams:
        raise ValueError("Reference file contains no video stream")
    width, height = int(streams[0]["width"]), int(streams[0]["height"])
    if width <= 0 or height <= 0:
        raise ValueError("Invalid reference video dimensions")
    max_long_edge = 192 if visual_mode == "motion" else 512
    scale = min(1.0, max_long_edge / max(width, height))
    width, height = max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32)
    video_filter = f"fps=24,scale={width}:{height}"
    if visual_mode == "motion":
        video_filter += ":flags=area,format=gray,gblur=sigma=2"
    decoded = subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-ss", str(start_time), "-i", str(path),
        "-map", "0:v:0", "-an", "-t", "15", "-frames:v", "360",
        "-vf", video_filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], capture_output=True, check=True, timeout=120)
    frame_size = width * height * 3
    if len(decoded.stdout) % frame_size or len(decoded.stdout) < 5 * frame_size:
        raise ValueError("Reference video needs at least 5 decoded frames at 24 fps")
    frames = np.frombuffer(decoded.stdout, dtype=np.uint8).reshape(-1, height, width, 3)
    return torch.from_numpy(frames.astype(np.float32) / 255.0)


def _frame_count(duration_seconds: float) -> int:
    requested = max(5, round(duration_seconds * 24))
    return requested + (5 - requested % 17) % 17


def _dimensions(aspect_ratio: str) -> tuple[int, int]:
    return {
        "21:9": (1120, 480),
        "16:9": (960, 544),
        "4:3": (832, 640),
        "1:1": (736, 736),
        "3:4": (640, 832),
        "9:16": (544, 960),
        "auto": (960, 544),
    }.get(aspect_ratio, (960, 544))
