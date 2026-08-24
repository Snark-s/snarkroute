from __future__ import annotations

import os
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.errors import WorkerError
from app.nanovsr import load_nanovsr
from app.registry import ModelRegistry
from app.runtime import RuntimeFactory
from app.tiling import tiled_inference
from app.video_registry import VideoUpscaleModel


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
            [ffmpeg_executable(), "-hide_banner", "-i", str(path)],
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
) -> dict[str, object]:
    started = time.perf_counter()
    progress(0.01, "probing")
    probe = probe_video(input_path)
    if probe.width * probe.height > max_input_pixels:
        raise WorkerError("invalid_input", f"Video frames exceed the {max_input_pixels}-pixel safety limit.")
    if probe.pixel_format.lower().startswith(("yuv420p10", "yuv422p10", "yuv444p10", "p010")):
        raise WorkerError("unsupported_pixel_format", "10-bit input is not supported by the 8-bit RGB24 MVP pipeline.")
    if cancelled():
        raise WorkerError("cancelled", "Video upscale job was cancelled.")

    temporal_model = None
    resolved_device = None
    image_runtime = None
    image_model = None
    if model.temporal:
        weights = model.weights_path(model_dir)
        if not weights or not weights.is_file():
            raise WorkerError("missing_weights", f"Weights for {model.id} are not installed.", details={"model": model.id, "expected_path": str(weights)})
        try:
            temporal_model, resolved_device = load_nanovsr(weights, device, use_fp16=device != "cpu")
        except Exception as exc:
            if "out of memory" in str(exc).lower():
                raise WorkerError("gpu_oom", "GPU ran out of memory while loading the temporal model.", True) from exc
            raise WorkerError("runtime_failed", f"Temporal model failed to load: {type(exc).__name__}") from exc
    else:
        image_model = image_registry.get(model.framewise_model_id or "")
        image_runtime = runtimes.create(image_model, image_model.weights_path(model_dir), device, "auto")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    decoder = _start_decoder(input_path)
    encoder = _start_encoder(output_path, input_path, probe, model.native_scale, crf, audio_handling)
    decoded_frames = 0
    encoded_frames = 0
    peak_vram_mb = 0.0
    left_context: list[np.ndarray] = []
    pending: list[np.ndarray] = []
    eof = False
    try:
        while not eof or pending:
            target = chunk_size + (overlap_frames if model.temporal else 0)
            while not eof and len(pending) < target:
                if cancelled():
                    raise WorkerError("cancelled", "Video upscale job was cancelled.")
                frame = _read_frame(decoder, probe.width, probe.height)
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
            progress(_frame_progress(encoded_frames, probe.frame_count, 0.15, 0.75), "inference")
            if model.temporal:
                enhanced = _run_temporal(temporal_model, resolved_device, window)
                enhanced = enhanced[keep_start : keep_start + core_count]
                peak_vram_mb = max(peak_vram_mb, _cuda_peak_vram_mb(resolved_device))
            else:
                enhanced = [
                    _run_framewise(frame, image_model, image_runtime, tile_size, tile_overlap, cancelled)
                    for frame in core
                ]
            for frame in enhanced:
                if cancelled():
                    raise WorkerError("cancelled", "Video upscale job was cancelled.")
                _write_frame(encoder, frame)
                encoded_frames += 1
                progress(_frame_progress(encoded_frames, probe.frame_count, 0.2, 0.72), "encoding")
            left_context = core[-overlap_frames:] if model.temporal and overlap_frames else []
            pending = pending[core_count:]
        if decoded_frames == 0 or encoded_frames != decoded_frames:
            raise WorkerError("decode_failed", "Decoded and encoded frame counts do not match.", details={"decoded": decoded_frames, "encoded": encoded_frames})
        _close_process(decoder, "decode_failed", "FFmpeg decoder failed")
        _close_encoder(encoder)
    except Exception:
        _terminate_process(decoder)
        _terminate_process(encoder)
        output_path.unlink(missing_ok=True)
        raise
    progress(0.98, "finalizing")
    output_probe = probe_video(output_path)
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
        "processing_fps": encoded_frames / elapsed if elapsed else 0.0,
        "peak_vram_mb": peak_vram_mb or None,
        "input": probe.__dict__,
    }


def _start_decoder(path: Path) -> subprocess.Popen[bytes]:
    command = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def _start_encoder(path: Path, source: Path, probe: VideoProbe, scale: int, crf: int, audio_handling: str) -> subprocess.Popen[bytes]:
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
        "-color_trc", "bt709", "-color_primaries", "bt709", "-shortest", str(path),
    ]
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


def _run_temporal(model, device, frames: list[np.ndarray]) -> list[np.ndarray]:
    import torch

    batch = np.stack(frames).astype(np.float32) / 255.0
    tensor = torch.from_numpy(batch.transpose(0, 3, 1, 2)).unsqueeze(0).to(device)
    if next(model.parameters()).dtype == torch.float16:
        tensor = tensor.half()
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    with torch.inference_mode():
        output = model(tensor).float().squeeze(0)
    array = output.clamp(0, 1).mul(255).round().to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
    return [np.ascontiguousarray(frame) for frame in array]


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


def _cuda_peak_vram_mb(device) -> float:
    if not device or device.type != "cuda":
        return 0.0
    import torch

    return torch.cuda.max_memory_allocated(device) / (1024 * 1024)


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
