from pathlib import Path
from typing import Any

import yaml


def default_manifest() -> Path:
    return Path(__file__).resolve().parents[1] / "model-manifest.yaml"


def load_manifest(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    validate_manifest(data)
    return data


def validate_manifest(data: Any) -> None:
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("manifest schema_version must be 1")
    model = data.get("model")
    if not isinstance(model, dict) or not model.get("repository") or not model.get("revision"):
        raise ValueError("manifest model repository and revision are required")
    components = data.get("components")
    if not isinstance(components, list) or not components:
        raise ValueError("manifest components must be a non-empty list")
    seen: set[str] = set()
    required = {"id", "repository", "revision", "allow_patterns", "variant", "purpose", "path", "license"}
    for component in components:
        if not isinstance(component, dict) or not required.issubset(component):
            raise ValueError(f"manifest component is missing required fields: {component!r}")
        if component["id"] in seen:
            raise ValueError(f"duplicate component id: {component['id']}")
        seen.add(component["id"])
