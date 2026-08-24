from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.errors import WorkerError
from app.registry import ModelRegistry, ModelResource


@dataclass(frozen=True)
class VideoUpscaleModel:
    id: str
    display_name: str
    architecture: str
    runtime: str
    file_format: str
    native_scale: int
    temporal: bool
    context_frames: int
    recurrent: str
    supported_pixel_formats: tuple[str, ...]
    supported_content_types: tuple[str, ...]
    supported_output_codecs: tuple[str, ...]
    supported_output_containers: tuple[str, ...]
    license: str
    license_url: str
    source_url: str
    checkpoint_source: str
    estimated_vram_mb: int | None
    recommended_chunk_size: int
    spatial_tiling_supported: bool
    notes: str
    resource: ModelResource | None = None
    framewise_model_id: str | None = None
    recommended_tile_size: int | None = None

    def weights_path(self, model_dir: Path) -> Path | None:
        return model_dir / self.resource.filename if self.resource else None

    def public_view(self, model_dir: Path, image_model_dir: Path, runtime_override: str = "auto") -> dict[str, Any]:
        weights = self.weights_path(model_dir)
        image_weights = image_model_dir / self.resource.filename if self.framewise_model_id and self.resource else None
        return {
            "id": self.id,
            "display_name": self.display_name,
            "architecture": self.architecture,
            "runtime": self.runtime if runtime_override in {"auto", "mock"} else runtime_override,
            "file_format": self.file_format,
            "native_scale": self.native_scale,
            "temporal": self.temporal,
            "context_frames": self.context_frames,
            "recurrent": self.recurrent,
            "supported_pixel_formats": list(self.supported_pixel_formats),
            "supported_content_types": list(self.supported_content_types),
            "supported_output_codecs": list(self.supported_output_codecs),
            "supported_output_containers": list(self.supported_output_containers),
            "license": self.license,
            "license_url": self.license_url,
            "source_url": self.source_url,
            "checkpoint_source": self.checkpoint_source,
            "estimated_vram_mb": self.estimated_vram_mb,
            "recommended_chunk_size": self.recommended_chunk_size,
            "recommended_tile_size": self.recommended_tile_size,
            "spatial_tiling_supported": self.spatial_tiling_supported,
            "framewise_model_id": self.framewise_model_id,
            "notes": self.notes,
            "weights_installed": runtime_override == "mock" or bool((image_weights or weights) and (image_weights or weights).is_file()),
        }


class VideoModelRegistry:
    def __init__(self, models: list[VideoUpscaleModel]):
        self._models = {model.id: model for model in models}
        if len(self._models) != len(models):
            raise ValueError("video model registry contains duplicate ids")

    @classmethod
    def load(cls, image_registry: ModelRegistry, path: Path | None = None) -> VideoModelRegistry:
        registry_path = path or Path(__file__).resolve().parents[1] / "video-model-registry.json"
        raw = json.loads(registry_path.read_text(encoding="utf-8"))
        temporal = [_parse_model(item) for item in raw.get("models", [])]
        framewise = [
            VideoUpscaleModel(
                id=f"framewise/{model.id}",
                display_name=f"Framewise — {model.display_name}",
                architecture=f"Framewise {model.architecture}",
                runtime=model.runtime,
                file_format=model.file_format,
                native_scale=model.scale_factor,
                temporal=False,
                context_frames=1,
                recurrent="none",
                supported_pixel_formats=("8-bit YUV/RGB decoded to RGB24",),
                supported_content_types=("video/mp4", "video/quicktime", "video/webm", "video/x-matroska"),
                supported_output_codecs=("libx264",),
                supported_output_containers=("mp4",),
                license=model.license,
                license_url=model.license_url,
                source_url=model.source_url,
                checkpoint_source=model.resource.url,
                estimated_vram_mb=model.estimated_vram_mb,
                recommended_chunk_size=1,
                spatial_tiling_supported=model.tiling_supported,
                notes="Framewise baseline using the existing local_upscale runtime; temporal context is not used.",
                resource=model.resource,
                framewise_model_id=model.id,
                recommended_tile_size=model.recommended_tile_size,
            )
            for model in image_registry.list()
        ]
        return cls([*temporal, *framewise])

    def list(self) -> list[VideoUpscaleModel]:
        return list(self._models.values())

    def get(self, model_id: str) -> VideoUpscaleModel:
        model = self._models.get(model_id)
        if not model:
            raise WorkerError("invalid_model_id", f"Unknown local video upscale model: {model_id}")
        return model


def _parse_model(raw: dict[str, Any]) -> VideoUpscaleModel:
    resource = raw["resource"]
    model = VideoUpscaleModel(
        id=str(raw["id"]),
        display_name=str(raw["display_name"]),
        architecture=str(raw["architecture"]),
        runtime=str(raw["runtime"]),
        file_format=str(raw["file_format"]),
        native_scale=int(raw["native_scale"]),
        temporal=bool(raw["temporal"]),
        context_frames=int(raw["context_frames"]),
        recurrent=str(raw["recurrent"]),
        supported_pixel_formats=tuple(map(str, raw["supported_pixel_formats"])),
        supported_content_types=tuple(map(str, raw["supported_content_types"])),
        supported_output_codecs=tuple(map(str, raw["supported_output_codecs"])),
        supported_output_containers=tuple(map(str, raw["supported_output_containers"])),
        license=str(raw["license"]),
        license_url=str(raw["license_url"]),
        source_url=str(raw["source_url"]),
        checkpoint_source=str(raw["checkpoint_source"]),
        estimated_vram_mb=int(raw["estimated_vram_mb"]) if raw.get("estimated_vram_mb") is not None else None,
        recommended_chunk_size=int(raw["recommended_chunk_size"]),
        spatial_tiling_supported=bool(raw["spatial_tiling_supported"]),
        notes=str(raw["notes"]),
        resource=ModelResource(
            url=str(resource["url"]),
            sha256=str(resource["sha256"]).lower(),
            size_bytes=int(resource["size_bytes"]),
            filename=str(resource["filename"]),
        ),
    )
    if not model.temporal or model.context_frames < 2 or model.native_scale < 1:
        raise ValueError(f"invalid temporal model registry entry: {model.id}")
    if not model.resource or len(model.resource.sha256) != 64:
        raise ValueError(f"invalid checkpoint metadata: {model.id}")
    return model
