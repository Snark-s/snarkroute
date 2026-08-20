from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from app.errors import WorkerError


@dataclass(frozen=True)
class ModelResource:
    url: str
    sha256: str
    size_bytes: int
    filename: str


@dataclass(frozen=True)
class UpscaleModel:
    id: str
    display_name: str
    architecture: str
    runtime: str
    file_format: str
    scale_factor: int
    supported_content_types: tuple[str, ...]
    tags: tuple[str, ...]
    license: str
    license_url: str
    source_url: str
    estimated_vram_mb: int | None
    recommended_tile_size: int
    tiling_supported: bool
    alpha_supported: bool
    resource: ModelResource

    def weights_path(self, model_dir: Path) -> Path:
        return model_dir / self.resource.filename

    def public_view(self, model_dir: Path, runtime_override: str = "auto") -> dict[str, Any]:
        runtime = self.runtime if runtime_override in {"auto", "mock"} else runtime_override
        return {
            "id": self.id,
            "display_name": self.display_name,
            "architecture": self.architecture,
            "runtime": runtime,
            "file_format": self.file_format,
            "scale_factor": self.scale_factor,
            "supported_content_types": list(self.supported_content_types),
            "tags": list(self.tags),
            "license": self.license,
            "license_url": self.license_url,
            "source_url": self.source_url,
            "estimated_vram_mb": self.estimated_vram_mb,
            "recommended_tile_size": self.recommended_tile_size,
            "tiling_supported": self.tiling_supported,
            "alpha_supported": self.alpha_supported,
            "weights_installed": runtime_override == "mock" or self.weights_path(model_dir).is_file(),
        }


class ModelRegistry:
    def __init__(self, models: list[UpscaleModel]):
        self._models = {model.id: model for model in models}
        if len(self._models) != len(models):
            raise ValueError("model registry contains duplicate ids")

    @classmethod
    def load(cls, path: Path | None = None) -> ModelRegistry:
        registry_path = path or Path(__file__).resolve().parents[1] / "model-registry.json"
        raw = json.loads(registry_path.read_text(encoding="utf-8"))
        return cls([_parse_model(item) for item in raw.get("models", [])])

    def list(self) -> list[UpscaleModel]:
        return list(self._models.values())

    def get(self, model_id: str) -> UpscaleModel:
        model = self._models.get(model_id)
        if not model:
            raise WorkerError("invalid_model_id", f"Unknown local upscale model: {model_id}", details={"model": model_id})
        return model


def _parse_model(raw: dict[str, Any]) -> UpscaleModel:
    resource = raw.get("resource") or {}
    model = UpscaleModel(
        id=str(raw["id"]),
        display_name=str(raw["display_name"]),
        architecture=str(raw["architecture"]),
        runtime=str(raw["runtime"]),
        file_format=str(raw["file_format"]),
        scale_factor=int(raw["scale_factor"]),
        supported_content_types=tuple(map(str, raw["supported_content_types"])),
        tags=tuple(map(str, raw["tags"])),
        license=str(raw["license"]),
        license_url=str(raw["license_url"]),
        source_url=str(raw["source_url"]),
        estimated_vram_mb=int(raw["estimated_vram_mb"]) if raw.get("estimated_vram_mb") is not None else None,
        recommended_tile_size=int(raw["recommended_tile_size"]),
        tiling_supported=bool(raw["tiling_supported"]),
        alpha_supported=bool(raw["alpha_supported"]),
        resource=ModelResource(
            url=str(resource["url"]),
            sha256=str(resource["sha256"]).lower(),
            size_bytes=int(resource["size_bytes"]),
            filename=str(resource["filename"]),
        ),
    )
    _validate_model(model)
    return model


def _validate_model(model: UpscaleModel) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,127}", model.id):
        raise ValueError(f"invalid model id: {model.id}")
    if model.runtime not in {"onnxruntime", "pytorch", "tensorrt"}:
        raise ValueError(f"unsupported runtime in registry: {model.runtime}")
    if model.file_format not in {"onnx", "pth"} or model.scale_factor < 1:
        raise ValueError(f"invalid model format or scale: {model.id}")
    if not re.fullmatch(r"[a-f0-9]{64}", model.resource.sha256):
        raise ValueError(f"invalid sha256: {model.id}")
    if model.resource.size_bytes <= 0 or Path(model.resource.filename).name != model.resource.filename:
        raise ValueError(f"invalid resource: {model.id}")
    if urlparse(model.resource.url).scheme != "https" or urlparse(model.source_url).scheme != "https":
        raise ValueError(f"model URLs must use HTTPS: {model.id}")
    if not model.license or model.license.lower() in {"unknown", "unlicensed"}:
        raise ValueError(f"model license must be explicit: {model.id}")
