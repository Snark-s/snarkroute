"""Temporal video runtimes used by the existing local video upscale worker.

The SOFVSR optical-flow and SRNet structure is adapted from the Apache-2.0
BasicSR implementation:
https://github.com/mansum6/BasicSR/blob/master/codes/models/modules/architectures/SOFVSR_arch.py
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Protocol

import numpy as np

from app.errors import WorkerError
from app.nanovsr import load_nanovsr
from app.video_registry import VideoUpscaleModel


class TemporalVideoRuntime(Protocol):
    device_type: str
    torch_device: object | None

    def infer(self, frames: list[np.ndarray]) -> list[np.ndarray]: ...


class TemporalRuntimeFactory:
    def __init__(self) -> None:
        self._cache: dict[tuple[str, str], TemporalVideoRuntime] = {}

    def create(self, model: VideoUpscaleModel, path: Path, device: str) -> TemporalVideoRuntime:
        key = (model.id, device)
        if key not in self._cache:
            if model.runtime_adapter == "nanovsr-pytorch":
                runtime: TemporalVideoRuntime = NanoVSRRuntime(path, device)
            elif model.runtime_adapter == "tscunet-onnx":
                runtime = TSCUNetOnnxRuntime(path, device, model.native_scale, model.context_frames)
            elif model.runtime_adapter == "sofvsr-pytorch":
                runtime = SOFVSRRuntime(path, device, model.native_scale, model.context_frames)
            else:
                raise WorkerError(
                    "runtime_unavailable",
                    f"Temporal runtime adapter {model.runtime_adapter} is not available.",
                )
            self._cache[key] = runtime
        return self._cache[key]


class NanoVSRRuntime:
    def __init__(self, path: Path, device: str) -> None:
        self.model, self.torch_device = load_nanovsr(path, device, use_fp16=device != "cpu")
        self.device_type = self.torch_device.type

    def infer(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        import torch

        batch = np.stack(frames).astype(np.float32) / 255.0
        tensor = torch.from_numpy(batch.transpose(0, 3, 1, 2)).unsqueeze(0).to(self.torch_device)
        if next(self.model.parameters()).dtype == torch.float16:
            tensor = tensor.half()
        with torch.inference_mode():
            output = self.model(tensor).float().squeeze(0)
        array = output.clamp(0, 1).mul(255).round().to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
        return [np.ascontiguousarray(frame) for frame in array]


class TSCUNetOnnxRuntime:
    def __init__(self, path: Path, device: str, scale: int, context_frames: int) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise WorkerError("runtime_unavailable", "Install the worker gpu extra to use ONNX Runtime.") from exc
        wants_cuda = device == "auto" or device.startswith("cuda")
        preload_dlls = getattr(ort, "preload_dlls", None)
        if wants_cuda and callable(preload_dlls):
            preload_dlls()
        available = ort.get_available_providers()
        if device.startswith("cuda") and "CUDAExecutionProvider" not in available:
            raise WorkerError("runtime_unavailable", "ONNX Runtime CUDAExecutionProvider is not available.")
        use_cuda = wants_cuda and "CUDAExecutionProvider" in available
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_cuda else ["CPUExecutionProvider"]
        try:
            self.session = ort.InferenceSession(str(path), providers=providers)
        except Exception as exc:
            raise WorkerError("runtime_unavailable", "TSCUNet ONNX session could not be initialized.") from exc
        if use_cuda and "CUDAExecutionProvider" not in self.session.get_providers():
            raise WorkerError("runtime_unavailable", "ONNX Runtime silently fell back from CUDAExecutionProvider.")
        signature = self.session.get_inputs()[0]
        expected_channels = context_frames * 3
        if len(signature.shape) != 4 or signature.shape[1] != expected_channels:
            raise WorkerError(
                "runtime_output_invalid",
                f"TSCUNet checkpoint must accept {expected_channels} flattened temporal channels.",
            )
        self.input_name = signature.name
        self.scale = scale
        self.context_frames = context_frames
        self.device_type = "cuda" if use_cuda else "cpu"
        self.torch_device = None

    def infer(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        if len(frames) != self.context_frames:
            raise WorkerError("runtime_output_invalid", "TSCUNet received the wrong temporal context size.")
        value, (height, width) = prepare_tscunet_input(frames)
        output = self.session.run(None, {self.input_name: value})[0]
        if output.ndim != 4 or output.shape[0] != 1 or output.shape[1] != 3:
            raise WorkerError("runtime_output_invalid", "TSCUNet output must be one NCHW RGB frame.")
        output = output[0, :, : height * self.scale, : width * self.scale]
        frame = np.clip(output.transpose(1, 2, 0) * 255.0 + 0.5, 0, 255).astype(np.uint8)
        return [np.ascontiguousarray(frame)]


def prepare_tscunet_input(frames: list[np.ndarray]) -> tuple[np.ndarray, tuple[int, int]]:
    if not frames:
        raise WorkerError("runtime_output_invalid", "TSCUNet requires a temporal frame window.")
    height, width = frames[0].shape[:2]
    if any(frame.shape != (height, width, 3) for frame in frames):
        raise WorkerError("runtime_output_invalid", "TSCUNet frames must have matching RGB dimensions.")
    stacked = np.stack(frames).astype(np.float32) / 255.0
    channels = stacked.transpose(0, 3, 1, 2).reshape(len(frames) * 3, height, width)
    padded_height = math.ceil(height / 64) * 64
    padded_width = math.ceil(width / 64) * 64
    pad_height = padded_height - height
    pad_width = padded_width - width
    mode = "reflect" if height > 1 and width > 1 else "edge"
    channels = np.pad(channels, ((0, 0), (0, pad_height), (0, pad_width)), mode=mode)
    return np.ascontiguousarray(channels[None], dtype=np.float32), (height, width)


class SOFVSRRuntime:
    def __init__(self, path: Path, device: str, scale: int, context_frames: int) -> None:
        try:
            import torch
            from spandrel import ModelLoader
        except ImportError as exc:
            raise WorkerError("runtime_unavailable", "Install the worker gpu extra to use SOFVSR.") from exc
        state = torch.load(path, map_location="cpu", weights_only=True)
        if isinstance(state, dict):
            state = state.get("params_ema", state.get("params", state))
        if not isinstance(state, dict) or "OFR.RNN1.0.weight" not in state:
            raise WorkerError("runtime_output_invalid", "SOFVSR checkpoint state is invalid.")
        resolved = torch.device(device if device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
        channels = int(state["OFR.RNN1.0.weight"].shape[0])
        is_rrdb = "SR.model.0.weight" in state
        image_channels = 3 if is_rrdb else 1
        inferred_context = _infer_sofvsr_context(state, scale, image_channels, is_rrdb)
        if inferred_context != context_frames:
            raise WorkerError(
                "runtime_output_invalid",
                f"SOFVSR checkpoint uses {inferred_context} frames, registry declares {context_frames}.",
            )
        self.ofr = _OFRNet(scale, channels, image_channels)
        self.ofr.load_state_dict(_substate(state, "OFR."), strict=True)
        if is_rrdb:
            self.sr = ModelLoader(device=resolved).load_from_state_dict(_substate(state, "SR."))
            self.sr.model.to(resolved).eval()
        else:
            self.sr = _SOFSRNet(image_channels * (scale**2 * (context_frames - 1) + 1), scale, channels, image_channels)
            self.sr.load_state_dict(_substate(state, "SR."), strict=True)
            self.sr.to(resolved).eval()
        self.ofr.to(resolved).eval()
        self.torch = torch
        self.torch_device = resolved
        self.device_type = resolved.type
        self.scale = scale
        self.context_frames = context_frames
        self.image_channels = image_channels
        if resolved.type == "cuda":
            self.ofr.half()
            if is_rrdb:
                self.sr.model.half()
            else:
                self.sr.half()

    def infer(self, frames: list[np.ndarray]) -> list[np.ndarray]:
        if len(frames) != self.context_frames:
            raise WorkerError("runtime_output_invalid", "SOFVSR received the wrong temporal context size.")
        rgb = np.stack(frames).astype(np.float32) / 255.0
        if self.image_channels == 1:
            network_input = _rgb_to_ycbcr(rgb)[..., :1]
        else:
            network_input = rgb
        tensor = self.torch.from_numpy(network_input.transpose(0, 3, 1, 2)).unsqueeze(0).to(self.torch_device)
        if self.device_type == "cuda":
            tensor = tensor.half()
        with self.torch.inference_mode():
            output = _run_sofvsr(self.ofr, self.sr, tensor, self.scale).float()[0]
        if self.image_channels == 1:
            center = self.torch.from_numpy(_rgb_to_ycbcr(rgb[self.context_frames // 2]).transpose(2, 0, 1))
            center = center.unsqueeze(0).to(self.torch_device, dtype=output.dtype)
            chroma = self.torch.nn.functional.interpolate(
                center,
                scale_factor=self.scale,
                mode="bicubic",
                align_corners=False,
            )[0]
            chroma[0] = output[0]
            result = _ycbcr_to_rgb(chroma.permute(1, 2, 0).cpu().numpy())
        else:
            result = output.permute(1, 2, 0).cpu().numpy()
        frame = np.clip(result * 255.0 + 0.5, 0, 255).astype(np.uint8)
        return [np.ascontiguousarray(frame)]


def _infer_sofvsr_context(state, scale: int, image_channels: int, is_rrdb: bool) -> int:
    key = "SR.model.0.weight" if is_rrdb else "SR.body.0.weight"
    input_channels = int(state[key].shape[1])
    return ((input_channels - image_channels) // (image_channels * scale**2)) + 1


def _substate(state, prefix: str):
    return {key[len(prefix) :]: value for key, value in state.items() if key.startswith(prefix)}


def _run_sofvsr(ofr, sr, value, scale: int):
    import torch

    batch, frame_count, _channels, height, width = value.size()
    center = (frame_count - 1) // 2
    pairs = [torch.cat((value[:, index], value[:, center]), 1) for index in range(frame_count) if index != center]
    _flow_l1, _flow_l2, flow = ofr(torch.cat(pairs, 0))
    flow = flow.view(-1, batch, 2, height * scale, width * scale)
    draft_cube = [value[:, center]]
    for index in range(frame_count):
        if index == center:
            continue
        flow_index = index if index < center else index - 1
        for row in range(scale):
            for column in range(scale):
                draft_cube.append(
                    _optical_flow_warp(
                        value[:, index],
                        flow[flow_index, :, :, row::scale, column::scale] / scale,
                    )
                )
    return sr(torch.cat(draft_cube, 1))


def _optical_flow_warp(image, flow):
    import torch
    import torch.nn.functional as functional

    batch, _channels, height, width = image.size()
    y, x = torch.meshgrid(
        torch.linspace(-1, 1, height, device=image.device, dtype=image.dtype),
        torch.linspace(-1, 1, width, device=image.device, dtype=image.dtype),
        indexing="ij",
    )
    base = torch.stack((x, y), dim=-1).unsqueeze(0).expand(batch, -1, -1, -1)
    flow_x = flow[:, 0] * (31 / max(width - 1, 1))
    flow_y = flow[:, 1] * (31 / max(height - 1, 1))
    grid = base + torch.stack((flow_x, flow_y), dim=-1)
    return functional.grid_sample(image, grid, mode="bilinear", padding_mode="border", align_corners=True)


def _rgb_to_ycbcr(value: np.ndarray) -> np.ndarray:
    result = np.empty_like(value, dtype=np.float32)
    result[..., 0] = 16 / 255 + 0.256788 * value[..., 0] + 0.504129 * value[..., 1] + 0.097906 * value[..., 2]
    result[..., 1] = 128 / 255 - 0.148223 * value[..., 0] - 0.290993 * value[..., 1] + 0.439216 * value[..., 2]
    result[..., 2] = 128 / 255 + 0.439216 * value[..., 0] - 0.367788 * value[..., 1] - 0.071427 * value[..., 2]
    return result


def _ycbcr_to_rgb(value: np.ndarray) -> np.ndarray:
    y = value[..., 0] - 16 / 255
    cb = value[..., 1] - 128 / 255
    cr = value[..., 2] - 128 / 255
    return np.stack(
        (
            1.164383 * y + 1.596027 * cr,
            1.164383 * y - 0.391762 * cb - 0.812968 * cr,
            1.164383 * y + 2.017232 * cb,
        ),
        axis=-1,
    )


def _channel_shuffle(value, groups: int):
    batch, channels, height, width = value.size()
    return value.view(batch, groups, channels // groups, height, width).permute(0, 2, 1, 3, 4).reshape(
        batch, channels, height, width
    )


def _residual_block(channels: int):
    import torch.nn as nn

    class ResidualBlock(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            half = channels // 2
            self.body = nn.Sequential(
                nn.Conv2d(half, half, 1, bias=False),
                nn.LeakyReLU(0.1, inplace=True),
                nn.Conv2d(half, half, 3, padding=1, groups=half, bias=False),
                nn.Conv2d(half, half, 1, bias=False),
                nn.LeakyReLU(0.1, inplace=True),
            )

        def forward(self, value):
            half = value.shape[1] // 2
            return _channel_shuffle(self.torch_cat((value[:, :half], self.body(value[:, half:])), 1), 2)

        @staticmethod
        def torch_cat(values, dim):
            import torch

            return torch.cat(values, dim)

    return ResidualBlock()


def _cascade(count: int, channels: int):
    import torch.nn as nn

    class Cascade(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            # Keep the reference CasResB state-dict layout (`body.N.body.*`).
            self.body = nn.Sequential(*[_residual_block(channels) for _ in range(count)])

        def forward(self, value):
            return self.body(value)

    return Cascade()


class _OFRNet:
    def __new__(cls, scale: int, channels: int, image_channels: int):
        import torch
        import torch.nn as nn
        import torch.nn.functional as functional

        class OFRNet(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.pool = nn.AvgPool2d(2)
                self.scale = scale
                self.rnn1 = nn.Sequential(
                    nn.Conv2d(2 * (image_channels + 1), channels, 3, padding=1, bias=False),
                    nn.LeakyReLU(0.1, inplace=True),
                    _cascade(3, channels),
                )
                self.rnn2 = nn.Sequential(nn.Conv2d(channels, 2 * image_channels, 3, padding=1, bias=False))
                layers: list[nn.Module] = [_cascade(3, channels)]
                if scale == 4:
                    layers.extend(
                        [
                            nn.Conv2d(channels, 256, 1, bias=False),
                            nn.PixelShuffle(2),
                            nn.LeakyReLU(0.1, inplace=True),
                            nn.Conv2d(64, 256, 1, bias=False),
                            nn.PixelShuffle(2),
                            nn.LeakyReLU(0.1, inplace=True),
                        ]
                    )
                elif scale in {2, 3}:
                    layers.extend(
                        [
                            nn.Conv2d(channels, 64 * scale**2, 1, bias=False),
                            nn.PixelShuffle(scale),
                            nn.LeakyReLU(0.1, inplace=True),
                        ]
                    )
                else:
                    raise WorkerError("runtime_output_invalid", f"Unsupported SOFVSR scale: {scale}")
                layers.append(nn.Conv2d(64, 2 * image_channels, 3, padding=1, bias=False))
                self.sr = nn.Sequential(*layers)

            def forward(self, value):
                level1 = self.pool(value)
                batch, _channels, height, width = level1.size()
                zeros = torch.zeros(batch, 2, height, width, device=value.device, dtype=value.dtype)
                flow1 = self.rnn2(self.rnn1(torch.cat((level1, zeros), 1)))
                image_size = value.shape[-2:]
                flow1_up = functional.interpolate(flow1, size=image_size, mode="bilinear", align_corners=False) * 2
                warped2 = _optical_flow_warp(value[:, :1], flow1_up)
                flow2 = self.rnn2(self.rnn1(torch.cat((warped2, value[:, 1:2], flow1_up), 1))) + flow1_up
                warped3 = _optical_flow_warp(value[:, :1], flow2)
                flow3 = self.sr(self.rnn1(torch.cat((warped3, value[:, 1:2], flow2), 1)))
                flow3 = flow3 + functional.interpolate(
                    flow2,
                    scale_factor=self.scale,
                    mode="bilinear",
                    align_corners=False,
                ) * self.scale
                return flow1, flow2, flow3

        model = OFRNet()
        # Preserve checkpoint keys from the reference implementation.
        model.RNN1 = model.rnn1
        model.RNN2 = model.rnn2
        model.SR = model.sr
        del model.rnn1
        del model.rnn2
        del model.sr

        def forward(value):
            level1 = model.pool(value)
            batch, _channels, height, width = level1.size()
            zeros = torch.zeros(batch, 2, height, width, device=value.device, dtype=value.dtype)
            flow1 = model.RNN2(model.RNN1(torch.cat((level1, zeros), 1)))
            flow1_up = functional.interpolate(flow1, size=value.shape[-2:], mode="bilinear", align_corners=False) * 2
            warped2 = _optical_flow_warp(value[:, :1], flow1_up)
            flow2 = model.RNN2(model.RNN1(torch.cat((warped2, value[:, 1:2], flow1_up), 1))) + flow1_up
            warped3 = _optical_flow_warp(value[:, :1], flow2)
            flow3 = model.SR(model.RNN1(torch.cat((warped3, value[:, 1:2], flow2), 1)))
            flow3 += functional.interpolate(flow2, scale_factor=scale, mode="bilinear", align_corners=False) * scale
            return flow1, flow2, flow3

        model.forward = forward
        return model


class _SOFSRNet:
    def __new__(cls, input_channels: int, scale: int, channels: int, image_channels: int):
        import torch.nn as nn

        layers: list[nn.Module] = [
            nn.Conv2d(input_channels, channels, 3, padding=1, bias=False),
            nn.LeakyReLU(0.1, inplace=True),
            _cascade(8, channels),
        ]
        if scale == 4:
            layers.extend(
                [
                    nn.Conv2d(channels, 256, 1, bias=False),
                    nn.PixelShuffle(2),
                    nn.LeakyReLU(0.1, inplace=True),
                    nn.Conv2d(64, 256, 1, bias=False),
                    nn.PixelShuffle(2),
                    nn.LeakyReLU(0.1, inplace=True),
                ]
            )
        elif scale in {2, 3}:
            layers.extend(
                [
                    nn.Conv2d(channels, 64 * scale**2, 1, bias=False),
                    nn.PixelShuffle(scale),
                    nn.LeakyReLU(0.1, inplace=True),
                ]
            )
        layers.append(nn.Conv2d(64, image_channels, 3, padding=1, bias=True))

        class SOFSRNet(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.body = nn.Sequential(*layers)

            def forward(self, value):
                return self.body(value)

        return SOFSRNet()
