from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..models import CapabilityView, GenerateRequest, ResultMetadata

ProgressCallback = Callable[[float, str], Awaitable[None]]


class CapabilityUnavailable(RuntimeError):
    def __init__(self, capability: str, reason: str):
        super().__init__(reason)
        self.capability = capability
        self.reason = reason


class BackendFailure(RuntimeError):
    """A backend error safe to expose through the stable worker job contract."""

    def __init__(self, code: str, message: str, *, retryable: bool):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class BackendOutput:
    path: Path
    filename: str
    mime_type: str
    metadata: ResultMetadata


class Backend(Protocol):
    name: str
    version: str

    def capabilities(self) -> list[CapabilityView]: ...

    async def ready(self) -> tuple[bool, str | None]: ...

    async def execute(
        self,
        request: GenerateRequest,
        work_dir: Path,
        progress: ProgressCallback,
    ) -> list[BackendOutput]: ...
