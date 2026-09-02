from ..config import Settings
from .base import Backend
from .diffusers import DiffusersBackend
from .mock import MockBackend
from .sglang import SGLangBackend


def create_backend(settings: Settings) -> Backend:
    if settings.backend == "sglang":
        return SGLangBackend(settings)
    if settings.backend == "diffusers":
        return DiffusersBackend()
    return MockBackend(settings.enabled_variants)
