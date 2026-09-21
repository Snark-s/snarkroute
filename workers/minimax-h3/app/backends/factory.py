from ..config import Settings
from .base import Backend
from .diffusers import DiffusersBackend
from .matlow_int8 import MatlowInt8Backend
from .mock import MockBackend
from .sglang import SGLangBackend
from .vdn import VDNBackend


def create_backend(settings: Settings) -> Backend:
    if settings.backend == "sglang":
        return SGLangBackend(settings)
    if settings.backend == "matlow_int8":
        return MatlowInt8Backend(settings)
    if settings.backend == "diffusers":
        return DiffusersBackend()
    if settings.backend == "vdn":
        return VDNBackend()
    if settings.backend == "mock":
        return MockBackend(settings.enabled_variants)
    raise RuntimeError(f"Unsupported H3 backend: {settings.backend}")
