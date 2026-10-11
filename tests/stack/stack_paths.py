"""Resolve audited components from the canonical registry, including relocated installs."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def home(name):
    registry = Path(os.environ.get('SNARKROUTE_PORT_REGISTRY') or ROOT / 'service-endpoints.json').resolve()
    document = json.loads(registry.read_text(encoding='utf-8-sig'))
    path = Path(document['paths'][name])
    return path.resolve() if path.is_absolute() else (registry.parent / path).resolve()
