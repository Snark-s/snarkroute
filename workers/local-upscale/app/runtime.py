from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np
from PIL import Image

from app.errors import WorkerError
from app.registry import UpscaleModel


class ImageRuntime(Protocol):
    def infer(self, tile: np.ndarray) -> np.ndarray: ...


class MockRuntime:
    def __init__(self, scale: int):
        self.scale = scale

    def infer(self, tile: np.ndarray) -> np.ndarray:
        source = Image.fromarray(np.clip(tile * 255.0, 0, 255).astype(np.uint8))
        result = source.resize((source.width * self.scale, source.height * self.scale), Image.Resampling.NEAREST)
        return np.asarray(result, dtype=np.float32) / 255.0


class OnnxRuntime:
    def __init__(self, path: Path, device: str):
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise WorkerError("runtime_unavailable", "Install the worker gpu extra to use ONNX Runtime.") from exc
        wants_cuda = device.startswith("cuda")
        preload_dlls = getattr(ort, "preload_dlls", None)
        if wants_cuda and callable(preload_dlls):
            # ORT 1.21+ can reuse the CUDA/cuDNN DLLs shipped with the matching
            # PyTorch wheel. This avoids requiring a separate system CUDA install.
            preload_dlls()
        if wants_cuda and "CUDAExecutionProvider" not in ort.get_available_providers():
            raise WorkerError("runtime_unavailable", "ONNX Runtime CUDAExecutionProvider is not available.")
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if wants_cuda else ["CPUExecutionProvider"]
        try:
            self.session = ort.InferenceSession(str(path), providers=providers)
        except Exception as exc:
            if wants_cuda:
                raise WorkerError("runtime_unavailable", "ONNX Runtime could not initialize CUDAExecutionProvider.") from exc
            raise
        if wants_cuda and "CUDAExecutionProvider" not in self.session.get_providers():
            raise WorkerError("runtime_unavailable", "ONNX Runtime silently fell back from CUDAExecutionProvider.")
        self.input_name = self.session.get_inputs()[0].name

    def infer(self, tile: np.ndarray) -> np.ndarray:
        value = np.transpose(tile.astype(np.float32), (2, 0, 1))[None]
        result = self.session.run(None, {self.input_name: value})[0]
        if result.ndim != 4:
            raise WorkerError("runtime_output_invalid", "ONNX model output must be NCHW.")
        return np.transpose(result[0], (1, 2, 0))


class PyTorchRuntime:
    def __init__(self, path: Path, device: str):
        try:
            import torch
            from spandrel import ModelLoader
        except ImportError as exc:
            raise WorkerError("runtime_unavailable", "Install the worker gpu extra to use PyTorch models.") from exc
        # Refuse checkpoints that cannot be parsed through PyTorch's safe weights-only loader.
        torch.load(path, map_location="cpu", weights_only=True)
        resolved_device = torch.device(device if device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
        descriptor = ModelLoader(device=resolved_device).load_from_file(path)
        descriptor.model.to(resolved_device).eval()
        self.torch = torch
        # Spandrel descriptors normalize architecture-specific inputs and outputs;
        # invoke the descriptor rather than bypassing it through the raw module.
        self.model = descriptor
        self.device = resolved_device

    def infer(self, tile: np.ndarray) -> np.ndarray:
        tensor = self.torch.from_numpy(np.transpose(tile.astype(np.float32), (2, 0, 1))).unsqueeze(0).to(self.device)
        with self.torch.inference_mode():
            result = self.model(tensor).detach().float().cpu().numpy()[0]
        return np.transpose(result, (1, 2, 0))


class RuntimeFactory:
    def __init__(self):
        self._cache: dict[tuple[str, str], ImageRuntime] = {}
        self._extensions: dict[str, Callable[[Path, str], ImageRuntime]] = {}

    def register(self, runtime: str, factory: Callable[[Path, str], ImageRuntime]) -> None:
        """Extension boundary for a future TensorRT runtime without changing job logic."""
        self._extensions[runtime] = factory

    def create(self, model: UpscaleModel, path: Path, device: str, override: str = "auto") -> ImageRuntime:
        runtime = model.runtime if override == "auto" else override
        if runtime == "mock":
            return MockRuntime(model.scale_factor)
        key = (model.id, f"{runtime}:{device}")
        if key not in self._cache:
            if runtime == "onnxruntime":
                self._cache[key] = OnnxRuntime(path, device)
            elif runtime == "pytorch":
                self._cache[key] = PyTorchRuntime(path, device)
            elif runtime in self._extensions:
                self._cache[key] = self._extensions[runtime](path, device)
            else:
                raise WorkerError("runtime_unavailable", f"Runtime {runtime} is not available in this worker.")
        return self._cache[key]


def is_out_of_memory(error: BaseException) -> bool:
    return "out of memory" in str(error).lower() or error.__class__.__name__ in {"OutOfMemoryError", "CUDAOutOfMemoryError"}
