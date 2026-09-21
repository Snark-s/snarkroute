from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download

from .config import Settings


@dataclass(frozen=True)
class DownloadSpec:
    variant: str
    filename: str
    expected_bytes: int
    sha256: str


REVISION = "8a198588c8870ab0d613b3492a3150d091c8c2dd"
REPOSITORY = "TenStrip/10Eros-Max"
DOWNLOADS = {
    "10eros_max": DownloadSpec(
        "10eros_max",
        "10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors",
        13_997_668_758,
        "16249794bc0d4627a3960a6c9f32631bad267ce887c716f8e77c5356d2757ca2",
    ),
    "10eros_max_turbo": DownloadSpec(
        "10eros_max_turbo",
        "10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors",
        13_997_668_774,
        "a8067999c65594b462d581c02b8a0573dd42d9812a14c586150a947c13388f2e",
    ),
}


class H3ModelManager:
    """Fixed allow-list downloader; Hub caching provides resumable, deduplicated transfers."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._states: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def path(self, variant: str) -> Path:
        if variant == "10eros_max":
            return self.settings.matlow_10eros_max_file
        if variant == "10eros_max_turbo":
            return self.settings.matlow_10eros_max_turbo_file
        raise KeyError(variant)

    def status(self, variant: str) -> dict[str, Any]:
        spec = DOWNLOADS[variant]
        target = self.path(variant)
        current_bytes = target.stat().st_size if target.is_file() else self._partial_bytes(target.parent)
        with self._lock:
            state = dict(self._states.get(variant, {}))
        return {
            "id": variant,
            "repository": REPOSITORY,
            "revision": REVISION,
            "filename": spec.filename,
            "path": str(target),
            "expected_bytes": spec.expected_bytes,
            "downloaded_bytes": min(current_bytes, spec.expected_bytes),
            "progress": min(1.0, current_bytes / spec.expected_bytes),
            "weights_installed": target.is_file() and target.stat().st_size == spec.expected_bytes,
            "downloading": state.get("status") == "downloading",
            **state,
        }

    def start(self, variant: str) -> dict[str, Any]:
        if variant not in DOWNLOADS:
            raise ValueError("Unknown H3 model variant")
        if os.getenv("H3_ACCEPT_MODEL_LICENSE", "").strip().lower() not in {"1", "true", "yes", "on"}:
            raise RuntimeError("Set H3_ACCEPT_MODEL_LICENSE=1 after accepting the MiniMax H3 community license")
        status = self.status(variant)
        if status["weights_installed"]:
            return status
        with self._lock:
            if self._states.get(variant, {}).get("status") == "downloading":
                already_downloading = True
            else:
                already_downloading = False
                self._states[variant] = {"status": "downloading", "error": None}
        if already_downloading:
            return self.status(variant)
        threading.Thread(target=self._download, args=(variant,), daemon=True, name=f"h3-download-{variant}").start()
        return self.status(variant)

    def _download(self, variant: str) -> None:
        spec = DOWNLOADS[variant]
        target = self.path(variant)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            downloaded = Path(hf_hub_download(
                repo_id=REPOSITORY,
                filename=spec.filename,
                revision=REVISION,
                local_dir=target.parent,
                token=os.getenv("HF_TOKEN") or None,
            ))
            if downloaded.resolve() != target.resolve():
                raise RuntimeError(f"Hub returned an unexpected path: {downloaded}")
            if target.stat().st_size != spec.expected_bytes:
                raise RuntimeError(f"Size mismatch: expected {spec.expected_bytes}, got {target.stat().st_size}")
            digest = hashlib.sha256()
            with target.open("rb") as stream:
                for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != spec.sha256:
                raise RuntimeError("SHA-256 mismatch")
            with self._lock:
                self._states[variant] = {"status": "installed", "error": None}
        except Exception as exc:
            with self._lock:
                self._states[variant] = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}

    @staticmethod
    def _partial_bytes(directory: Path) -> int:
        cache = directory / ".cache" / "huggingface" / "download"
        if not cache.is_dir():
            return 0
        return max((path.stat().st_size for path in cache.glob("*.incomplete") if path.is_file()), default=0)
