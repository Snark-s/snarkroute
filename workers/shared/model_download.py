from __future__ import annotations

import hashlib
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DiskGate:
    available_bytes: int
    required_bytes: int

    @property
    def allowed(self) -> bool:
        return self.available_bytes >= self.required_bytes


def disk_gate(target: Path, expected_bytes: int, reserve_bytes: int) -> DiskGate:
    parent = target.resolve()
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    return DiskGate(
        available_bytes=shutil.disk_usage(parent).free,
        required_bytes=expected_bytes + reserve_bytes,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_verified_file(
    *,
    url: str,
    destination: Path,
    expected_bytes: int,
    expected_sha256: str,
    user_agent: str,
    timeout_seconds: float = 60,
) -> None:
    """Resume a pinned HTTPS file and atomically publish it after size/hash verification."""
    if not url.startswith("https://"):
        raise ValueError("model download URL must use HTTPS")
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": user_agent}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        append = offset > 0 and response.status == 206
        with partial.open("ab" if append else "wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
    if partial.stat().st_size != expected_bytes:
        raise RuntimeError(f"downloaded size {partial.stat().st_size} does not match {expected_bytes}")
    actual = sha256_file(partial)
    if actual != expected_sha256:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual}")
    partial.replace(destination)
