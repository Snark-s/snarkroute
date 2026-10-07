from __future__ import annotations

import os
import json
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path

import numpy as np

from app.errors import WorkerError
from app.registry import ModelRegistry
from app.runtime import RuntimeFactory
from app.tiling import tiled_inference
from app.video_registry import VideoUpscaleModel
from app.video_runtime import TemporalRuntimeFactory
from app.video_benchmark import Policy, query_gpu, decoder_command, encoder_command, mux_command, validate_ort_profile
from app.video_production import delivery_geometry, production_encoder_command, ffprobe_streams, source_color, source_fps, verify_output_metadata, file_sha


@dataclass(frozen=True)
class VideoProbe:
    width: int
    height: int
    fps: float
    frame_count: int | None
    duration: float | None
    codec: str
    pixel_format: str
    has_audio: bool
    audio_codec: str | None
    rotation: int


def ffmpeg_executable() -> str:
    configured = os.getenv("LOCAL_VIDEO_UPSCALE_FFMPEG_PATH", "").strip()
    if configured:
        if not Path(configured).is_file():
            raise WorkerError("runtime_failed", "LOCAL_VIDEO_UPSCALE_FFMPEG_PATH does not point to a file.")
        return configured
    try:
        from imageio_ffmpeg import get_ffmpeg_exe

        return get_ffmpeg_exe()
    except Exception as exc:
        raise WorkerError("runtime_failed", "FFmpeg is unavailable. Install imageio-ffmpeg or configure LOCAL_VIDEO_UPSCALE_FFMPEG_PATH.") from exc


def probe_video(path: Path) -> VideoProbe:
    try:
        result = subprocess.run(
            [ffmpeg_executable(), "-hide_banner", *(["-threads","2"] if Policy.from_env().enabled else []), "-i", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise WorkerError("timeout", "Video probe timed out.", True) from exc
    diagnostics = _bounded_diagnostics(result.stderr)
    video_line = next((line for line in diagnostics.splitlines() if " Video: " in line), "")
    if not video_line:
        raise WorkerError("invalid_input", "Input asset does not contain a decodable video stream.", details={"diagnostics": diagnostics})
    dimensions = re.search(r"(?<![\d.])(\d{2,5})x(\d{2,5})(?![\d.])", video_line)
    if not dimensions:
        raise WorkerError("decode_failed", "FFmpeg did not report video dimensions.", details={"diagnostics": diagnostics})
    fps_match = re.search(r"([\d.]+)\s+fps", video_line)
    fps = float(fps_match.group(1)) if fps_match else 0.0
    if fps <= 0 or fps > 240:
        raise WorkerError("unsupported_codec", "Only videos with a reported frame rate between 0 and 240 fps are supported.")
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", diagnostics)
    duration = None
    if duration_match:
        duration = int(duration_match.group(1)) * 3600 + int(duration_match.group(2)) * 60 + float(duration_match.group(3))
    codec_match = re.search(r"Video:\s*([^,\s]+)", video_line)
    pixel_match = re.search(r"Video:\s*[^,]+,\s*([^,(\s]+)", video_line)
    rotation_match = re.search(r"rotation of\s+(-?[\d.]+)\s+degrees", diagnostics)
    rotation = int(round(float(rotation_match.group(1)))) % 360 if rotation_match else 0
    width, height = int(dimensions.group(1)), int(dimensions.group(2))
    if rotation in {90, 270}:
        width, height = height, width
    audio_line = next((line for line in diagnostics.splitlines() if " Audio: " in line), "")
    audio_match = re.search(r"Audio:\s*([^,\s]+)", audio_line)
    frame_count = round(duration * fps) if duration else None
    return VideoProbe(
        width=width,
        height=height,
        fps=fps,
        frame_count=frame_count,
        duration=duration,
        codec=codec_match.group(1) if codec_match else "unknown",
        pixel_format=pixel_match.group(1) if pixel_match else "unknown",
        has_audio=bool(audio_line),
        audio_codec=audio_match.group(1) if audio_match else None,
        rotation=rotation,
    )


def process_video(
    input_path: Path,
    output_path: Path,
    model: VideoUpscaleModel,
    model_dir: Path,
    image_registry: ModelRegistry,
    runtimes: RuntimeFactory,
    temporal_runtimes: TemporalRuntimeFactory,
    device: str,
    chunk_size: int,
    overlap_frames: int,
    crf: int,
    audio_handling: str,
    tile_size: int,
    tile_overlap: int,
    max_input_pixels: int,
    progress: Callable[[float, str], None],
    cancelled: Callable[[], bool],
    delivery: list[int] | None = None,
    preset: str = "medium",
    gop: int = 48,
) -> dict[str, object]:
    started = time.perf_counter()
    benchmark = Policy.from_env()
    progress(0.01, "probing")
    probe = probe_video(input_path)
    production = os.getenv("LOCAL_VIDEO_PRODUCTION") == "1"
    color = None
    source_streams = None
    if production:
        if device != "cuda":
            raise WorkerError("cuda_required", "Production Video Upscale requires CUDA; CPU fallback is disabled.")
        source_streams = ffprobe_streams(input_path)
        source_stream = next(s for s in source_streams if s["codec_type"] == "video")
        color = source_color(source_stream)
        probe = replace(probe,fps=source_fps(source_stream))
        if audio_handling == "copy" and any(s.get("codec_name") not in {"aac","mp3","ac3","eac3","alac"} for s in source_streams if s["codec_type"] == "audio"):
            raise WorkerError("audio_copy_unavailable", "Original audio cannot be copied into MP4 with this profile. Select explicit AAC re-encode in Advanced.")
    if probe.width * probe.height > max_input_pixels:
        raise WorkerError("invalid_input", f"Video frames exceed the {max_input_pixels}-pixel safety limit.")
    if probe.pixel_format.lower().startswith(("yuv420p10", "yuv422p10", "yuv444p10", "p010")):
        raise WorkerError("unsupported_pixel_format", "10-bit input is not supported by the 8-bit RGB24 MVP pipeline.")
    if cancelled():
        raise WorkerError("cancelled", "Video upscale job was cancelled.")
    if benchmark.enabled:
        if device != "cuda" or (probe.width,probe.height,probe.fps) != (1344,768,24.0) or probe.audio_codec != "aac":
            raise WorkerError("invalid_input","Prepared benchmark requires MAX-I1 1344x768 24fps with AAC and explicit CUDA.")
        try: benchmark.check_gpu(query_gpu())
        except Exception as exc: raise WorkerError("resource_blocked",str(exc)) from exc

    temporal_runtime = None
    image_runtime = None
    image_model = None
    model_load_started = time.perf_counter()
    if model.temporal:
        weights = model.weights_path(model_dir)
        if not weights or not weights.is_file():
            raise WorkerError("missing_weights", f"Weights for {model.id} are not installed.", details={"model": model.id, "expected_path": str(weights)})
        try:
            temporal_runtime = temporal_runtimes.create(model, weights, device)
        except Exception as exc:
            if (benchmark.enabled or production) and isinstance(exc,WorkerError): raise
            if "out of memory" in str(exc).lower():
                raise WorkerError("gpu_oom", "GPU ran out of memory while loading the temporal model.", True) from exc
            raise WorkerError("runtime_failed", f"Temporal model failed to load: {type(exc).__name__}") from exc
    else:
        image_model = image_registry.get(model.framewise_model_id or "")
        image_runtime = runtimes.create(image_model, image_model.weights_path(model_dir), device, "auto")
    model_loading_seconds = time.perf_counter() - model_load_started
    active_runtime = temporal_runtime if model.temporal else image_runtime
    if (benchmark.enabled or production) and getattr(active_runtime,"device_type",None) != "cuda":
        raise WorkerError("runtime_failed","Benchmark runtime did not bind to CUDA.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    decoder = _start_decoder(input_path, color["decode_filter"] if color else None)
    encode_path = output_path.with_suffix(".video-only.mp4") if benchmark.enabled else output_path
    try:
        encoder = _start_encoder(encode_path, input_path, probe, model.native_scale, crf, audio_handling, delivery, preset, gop)
    except BaseException:
        _terminate_process(decoder)
        raise
    decoded_frames = 0
    encoded_frames = 0
    peak_vram_mb = 0.0
    inference_seconds = 0.0
    decode_read_seconds = encode_write_seconds = encoder_finalization_seconds = mux_seconds = 0.0
    peak_reserved_mb = 0.0
    chunk_boundaries = []
    left_context: list[np.ndarray] = []
    pending: list[np.ndarray] = []
    eof = False
    try:
        while not eof or pending:
            target = chunk_size + (overlap_frames if model.temporal else 0)
            while not eof and len(pending) < target:
                if cancelled():
                    raise WorkerError("cancelled", "Video upscale job was cancelled.")
                phase_started = time.perf_counter()
                frame = _read_frame(decoder, probe.width, probe.height)
                decode_read_seconds += time.perf_counter() - phase_started
                if frame is None:
                    eof = True
                    break
                pending.append(frame)
                decoded_frames += 1
                progress(_frame_progress(decoded_frames, probe.frame_count, 0.02, 0.12), "decoding")
            if not pending:
                break
            core_count = len(pending) if eof else min(chunk_size, len(pending))
            core = pending[:core_count]
            right = pending[core_count : core_count + overlap_frames] if model.temporal else []
            window = [*left_context, *core, *right]
            keep_start = len(left_context)
            if benchmark.enabled:
                chunk_boundaries.append({"output_first":encoded_frames,"output_last":encoded_frames+core_count-1,
                    "window_first":encoded_frames-keep_start,"window_last":encoded_frames+core_count+len(right)-1,
                    "left_context_frames":keep_start,"right_context_frames":len(right),
                    "model_context_frames":model.context_frames if model.temporal else None,
                    "clip_edge_policy":"repeat nearest frame","temporal_meaning":model.temporal})
            progress(_frame_progress(encoded_frames, probe.frame_count, 0.15, 0.75), "inference")
            if model.temporal:
                _reset_cuda_peak(temporal_runtime)
                inference_started = time.perf_counter()
                enhanced = _run_temporal(temporal_runtime, model, window, keep_start, core_count)
                inference_seconds += time.perf_counter() - inference_started
                peak_vram_mb = max(peak_vram_mb, _cuda_peak_vram_mb(temporal_runtime))
            else:
                _reset_cuda_peak(image_runtime)
                inference_started = time.perf_counter()
                enhanced = [
                    _run_framewise(frame, image_model, image_runtime, tile_size, tile_overlap, cancelled)
                    for frame in core
                ]
                inference_seconds += time.perf_counter() - inference_started
                peak_vram_mb = max(peak_vram_mb, _cuda_peak_vram_mb(image_runtime))
            if benchmark.enabled:
                peak_reserved_mb = max(peak_reserved_mb,_cuda_peak_reserved_mb(active_runtime))
            for frame in enhanced:
                if cancelled():
                    raise WorkerError("cancelled", "Video upscale job was cancelled.")
                phase_started = time.perf_counter()
                _write_frame(encoder, frame)
                encode_write_seconds += time.perf_counter() - phase_started
                encoded_frames += 1
                progress(_frame_progress(encoded_frames, probe.frame_count, 0.2, 0.72), "encoding")
            left_context = core[-overlap_frames:] if model.temporal and overlap_frames else []
            pending = pending[core_count:]
        if decoded_frames == 0 or encoded_frames != decoded_frames:
            raise WorkerError("decode_failed", "Decoded and encoded frame counts do not match.", details={"decoded": decoded_frames, "encoded": encoded_frames})
        _close_process(decoder, "decode_failed", "FFmpeg decoder failed")
        phase_started = time.perf_counter()
        _close_encoder(encoder)
        encoder_finalization_seconds = time.perf_counter() - phase_started
        if production and model.runtime == "onnxruntime":
            profile_path = active_runtime.session.end_profiling()
            try: validate_ort_profile(json.loads(Path(profile_path).read_text(encoding="utf-8")))
            except Exception as exc: raise WorkerError("runtime_failed",f"CUDA-only profile verification failed: {exc}") from exc
        if benchmark.enabled:
            if model.runtime == "onnxruntime":
                profile_path = active_runtime.session.end_profiling()
                try:
                    profile_check = validate_ort_profile(json.loads(Path(profile_path).read_text(encoding="utf-8")))
                except Exception as exc:
                    raise WorkerError("runtime_failed",f"CUDA-only profiling validation failed: {exc}",details={"profile_path":profile_path}) from exc
                active_runtime.benchmark_profile = dict(profile_check,path=profile_path)
            phase_started = time.perf_counter()
            subprocess.run(mux_command(ffmpeg_executable(),encode_path,input_path,output_path,benchmark.threads),
                capture_output=True,check=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            mux_seconds = time.perf_counter()-phase_started
            encode_path.unlink(missing_ok=True)
    except Exception:
        _terminate_process(decoder)
        _terminate_process(encoder)
        output_path.unlink(missing_ok=True)
        if benchmark.enabled: encode_path.unlink(missing_ok=True)
        raise
    progress(0.98, "finalizing")
    output_probe = probe_video(output_path)
    geometry = delivery_geometry(probe.width*model.native_scale,probe.height*model.native_scale,delivery)
    verified = None
    if production:
        streams = ffprobe_streams(output_path)
        verified = verify_output_metadata(next(s for s in streams if s["codec_type"] == "video"),geometry["width"],geometry["height"],encoded_frames,probe.fps)
        output_probe = replace(output_probe,fps=float(Fraction(verified["avg_frame_rate"])))
        if audio_handling == "copy":
            before = [(s.get("codec_name"),s.get("sample_rate"),s.get("channels")) for s in source_streams if s["codec_type"] == "audio"]
            after = [(s.get("codec_name"),s.get("sample_rate"),s.get("channels")) for s in streams if s["codec_type"] == "audio"]
            if before != after: raise WorkerError("output_verification_failed","Original audio streams changed during mux.")
    elapsed = time.perf_counter() - started
    return {
        "filename": output_path.name,
        "mime_type": "video/mp4",
        "width": output_probe.width,
        "height": output_probe.height,
        "fps": output_probe.fps,
        "frame_count": encoded_frames,
        "duration": output_probe.duration,
        "codec": output_probe.codec,
        "pixel_format": output_probe.pixel_format,
        "audio_preserved": probe.has_audio and output_probe.has_audio and audio_handling == "copy",
        "audio_codec": output_probe.audio_codec,
        "bytes": output_path.stat().st_size,
        "temporal": model.temporal,
        "processing_seconds": elapsed,
        "model_loading_seconds": model_loading_seconds,
        "inference_seconds": inference_seconds,
        "processing_fps": encoded_frames / elapsed if elapsed else 0.0,
        "peak_vram_mb": peak_vram_mb or None,
        "vram_measurement": "torch_peak_allocated" if peak_vram_mb else (
            "unavailable_for_onnxruntime_under_wddm" if model.runtime == "onnxruntime" else None
        ),
        "runtime_device": getattr(temporal_runtime if model.temporal else image_runtime, "device_type", device),
        "input": probe.__dict__,
        "provenance": {
            "source_sha256": file_sha(input_path), "model_id": model.id,
            "model_sha256": file_sha(model.weights_path(model_dir)) if model.weights_path(model_dir) and model.weights_path(model_dir).is_file() else None,
            "model_scale": model.native_scale, "temporal_context": model.context_frames,
            "backend": model.runtime, "device": getattr(active_runtime,"device_type",device),
            "settings": dict(scale=model.native_scale,chunk_size=chunk_size,overlap_frames=overlap_frames,device=device,audio_handling=audio_handling,delivery=delivery,preset=preset,crf=crf,gop=gop,output_codec="libx264"),
            "native_resolution": [probe.width*model.native_scale,probe.height*model.native_scale],
            "delivery_resolution": [geometry["width"],geometry["height"]], "geometry": geometry,
            "frames": encoded_frames, "fps": output_probe.fps, "audio_handling": audio_handling,
            "audio_reencoded": audio_handling == "aac", "color_handling": color, "output_verification": verified,
            "runtime_seconds": elapsed, "output_sha256": file_sha(output_path),
        },
        "benchmark": {
            "enabled":benchmark.enabled,
            "decode_read_wait_seconds":decode_read_seconds,
            "encode_pipe_wait_seconds":encode_write_seconds,
            "encoder_finalization_wait_seconds":encoder_finalization_seconds,
            "mux_seconds":mux_seconds,
            "runtime_phases":getattr(active_runtime,"benchmark_timings",{}),
            "torch_peak_allocated_mib":peak_vram_mb or None,
            "torch_peak_reserved_mib":peak_reserved_mb or None,
            "ort_profile":getattr(active_runtime,"benchmark_profile",None),
            "chunk_boundaries":chunk_boundaries,
            "timing_convention":"Piped decode/encode overlap inference; wait durations are not codec compute time. Forward timing synchronizes CUDA; ORT session.run includes copies.",
        } if benchmark.enabled else None,
    }


def _start_decoder(path: Path, color_filter: str | None = None) -> subprocess.Popen[bytes]:
    command = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    policy = Policy.from_env()
    if policy.enabled: command = decoder_command(ffmpeg_executable(),path,policy.threads)
    if color_filter:
        command = decoder_command(ffmpeg_executable(),path,2)
        command[command.index("-vf")+1] = color_filter
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def _start_encoder(path: Path, source: Path, probe: VideoProbe, scale: int, crf: int, audio_handling: str, delivery=None, preset="medium", gop=48) -> subprocess.Popen[bytes]:
    command = [
        ffmpeg_executable(), "-y", "-nostdin", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{probe.width * scale}x{probe.height * scale}",
        "-r", f"{probe.fps:.8f}", "-i", "pipe:0", "-i", str(source), "-map", "0:v:0",
    ]
    if audio_handling == "copy":
        command += ["-map", "1:a:0?", "-c:a", "copy"]
    command += [
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709",
        "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709",
        "-color_trc", "bt709", "-color_primaries", "bt709", str(path),
    ]
    policy = Policy.from_env()
    if policy.enabled:
        command = encoder_command(ffmpeg_executable(),path,source,probe.width*scale,probe.height*scale,probe.fps,policy.threads,video_only=True)
    if os.getenv("LOCAL_VIDEO_PRODUCTION") == "1":
        command = production_encoder_command(ffmpeg_executable(),path,source,probe.width*scale,probe.height*scale,probe.fps,probe.has_audio,audio_handling,delivery,crf,preset,gop)
    return subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def _read_frame(process: subprocess.Popen[bytes], width: int, height: int) -> np.ndarray | None:
    if process.stdout is None:
        raise WorkerError("decode_failed", "FFmpeg decoder stdout is unavailable.")
    expected = width * height * 3
    data = bytearray()
    while len(data) < expected:
        chunk = process.stdout.read(expected - len(data))
        if not chunk:
            break
        data.extend(chunk)
    if not data:
        return None
    if len(data) != expected:
        raise WorkerError("decode_failed", "FFmpeg returned a truncated video frame.")
    return np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3).copy()


def _write_frame(process: subprocess.Popen[bytes], frame: np.ndarray) -> None:
    if process.stdin is None:
        raise WorkerError("encode_failed", "FFmpeg encoder stdin is unavailable.")
    try:
        process.stdin.write(np.ascontiguousarray(frame).tobytes())
    except BrokenPipeError as exc:
        diagnostics = _read_stderr(process)
        raise WorkerError("encode_failed", "FFmpeg stopped while encoding video.", details={"diagnostics": diagnostics}) from exc


def _run_temporal(runtime, model: VideoUpscaleModel, frames: list[np.ndarray], keep_start: int, core_count: int) -> list[np.ndarray]:
    if model.inference_mode == "sequence":
        output = runtime.infer(frames)
        if len(output) != len(frames):
            raise WorkerError("runtime_output_invalid", "Sequence temporal model changed the frame count.")
        return output[keep_start : keep_start + core_count]
    output = []
    for center in range(keep_start, keep_start + core_count):
        window = _center_context_window(frames, center, model.context_frames)
        enhanced = runtime.infer(window)
        if len(enhanced) != 1:
            raise WorkerError("runtime_output_invalid", "Center-frame temporal model must emit one frame.")
        output.append(enhanced[0])
    return output


def _center_context_window(frames: list[np.ndarray], center: int, context_frames: int) -> list[np.ndarray]:
    radius = context_frames // 2
    return [frames[min(max(index, 0), len(frames) - 1)] for index in range(center - radius, center + radius + 1)]


def _run_framewise(frame, model, runtime, tile_size: int, tile_overlap: int, cancelled) -> np.ndarray:
    output = tiled_inference(
        frame.astype(np.float32) / 255.0,
        model.scale_factor,
        tile_size,
        tile_overlap,
        runtime.infer,
        cancelled=cancelled,
    )
    return np.clip(output * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _reset_cuda_peak(runtime) -> None:
    device = getattr(runtime, "torch_device", None)
    if not device or device.type != "cuda":
        return
    import torch

    torch.cuda.reset_peak_memory_stats(device)


def _cuda_peak_vram_mb(runtime) -> float:
    device = getattr(runtime, "torch_device", None)
    if not device or device.type != "cuda":
        return 0.0
    import torch

    return torch.cuda.max_memory_allocated(device) / (1024 * 1024)


def _cuda_peak_reserved_mb(runtime) -> float:
    device = getattr(runtime,"torch_device",None)
    if device is None or device.type != "cuda": return 0.0
    return runtime.torch.cuda.max_memory_reserved(device) / (1024 * 1024)


def _close_encoder(process: subprocess.Popen[bytes]) -> None:
    if process.stdin:
        process.stdin.close()
    try:
        code = process.wait(timeout=60)
    except subprocess.TimeoutExpired as exc:
        _terminate_process(process)
        raise WorkerError("timeout", "FFmpeg encoder did not finish in time.", True) from exc
    if code:
        raise WorkerError("encode_failed", "FFmpeg encoder failed.", details={"diagnostics": _read_stderr(process)})


def _close_process(process: subprocess.Popen[bytes], code: str, message: str) -> None:
    try:
        result = process.wait(timeout=10)
    except subprocess.TimeoutExpired as exc:
        _terminate_process(process)
        raise WorkerError("timeout", f"{message} to exit.", True) from exc
    if result:
        raise WorkerError(code, message, details={"diagnostics": _read_stderr(process)})


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _read_stderr(process: subprocess.Popen[bytes]) -> str:
    if not process.stderr:
        return ""
    try:
        return _bounded_diagnostics(process.stderr.read().decode("utf-8", errors="replace"))
    except Exception:
        return ""


def _bounded_diagnostics(value: str) -> str:
    return value[-4000:]


def _frame_progress(value: int, total: int | None, offset: float, span: float) -> float:
    if not total:
        return min(offset + span * 0.95, offset + value * 0.001)
    return min(offset + span, offset + span * min(value / total, 1.0))
