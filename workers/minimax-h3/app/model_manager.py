from __future__ import annotations

import hashlib
import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download

from .config import Settings


@dataclass(frozen=True)
class DownloadSpec:
    variant: str
    repository: str
    revision: str
    filename: str
    expected_bytes: int
    sha256: str
    remote_filename: str | None = None


REVISION = "8a198588c8870ab0d613b3492a3150d091c8c2dd"
REPOSITORY = "TenStrip/10Eros-Max"
DOWNLOADS = {
    "10eros_max": DownloadSpec(
        "10eros_max",
        REPOSITORY,
        REVISION,
        "10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors",
        13_997_668_758,
        "16249794bc0d4627a3960a6c9f32631bad267ce887c716f8e77c5356d2757ca2",
    ),
    "10eros_max_turbo": DownloadSpec(
        "10eros_max_turbo",
        REPOSITORY,
        REVISION,
        "10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors",
        13_997_668_774,
        "a8067999c65594b462d581c02b8a0573dd42d9812a14c586150a947c13388f2e",
    ),
    "faceswap_ref2va": DownloadSpec(
        "faceswap_ref2va",
        "UntMods/FaceSwap_MiniMaxH3_REF2VA",
        "b2a5823ca64bc78d91725fbfcc576095bfceb764",
        "SS_FaceSwap_MiniMax_H3_REF2VA.safetensors",
        65_623_904,
        "1e032cf519cc143f434e67516d8ad0aacf4c6e146315b2dcc3b1c2800470326d",
    ),
    "authentic_cinematic_texture": DownloadSpec(
        "authentic_cinematic_texture",
        "Alex995647/loras-minimax-h3",
        "1517498210f571b0ed956f40df2765078daa749d",
        "Minimax H3真实电影质感.safetensors",
        309_965_208,
        "51dda79218ea126cbb2e08f3a6d9cc595e2224f4977d7618061954043a8bafcf",
        "minimax-h3-authentic-cinematic-texture/Minimax H3真实电影质感.safetensors",
    ),
}

MODIFIER_METADATA = {
    "faceswap_ref2va": {"base_model": "MiniMax H3", "trigger": "Faceswap", "default_strength": 1.0},
    "authentic_cinematic_texture": {
        "title": "Authentic Cinematic Texture",
        "category": "visual",
        "source": "https://civitai.com/models/2890588/minimax-h3-authentic-cinematic-texture",
        "base_model": "MiniMax H3",
        "trigger": "DY",
        "default_strength": 0.7,
        "motion_strength": 0.5,
        "supported_task_families": ["t2va", "fl2va", "ref2va"],
        "verified_task_families": ["t2va"],
        "capability_status": "limited",
        "compatibility": "GPU-verified on MATLOW fused Turbo INT8 rev 8a8dffaa; global texture influence and byte-identical baseline reset confirmed",
        "notes": "0.7 changes lighting and subject appearance; 0.5 stays closer to Base. DY showed no clear benefit in one fixed-seed test. FL2VA/Ref2VA modifier combinations remain unverified.",
        "license": {
            "source": "Civitai custom permissions",
            "allow_no_credit": True,
            "allow_commercial_use": ["Image", "RentCivit", "Rent"],
            "allow_derivatives": True,
            "allow_different_license": True,
        },
    },
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
        if variant == "faceswap_ref2va":
            return self.settings.matlow_faceswap_lora_file
        if variant == "authentic_cinematic_texture":
            return self.settings.matlow_authentic_cinematic_lora_file
        raise KeyError(variant)

    def status(self, variant: str) -> dict[str, Any]:
        spec = DOWNLOADS[variant]
        target = self.path(variant)
        current_bytes = target.stat().st_size if target.is_file() else self._partial_bytes(target.parent)
        with self._lock:
            state = dict(self._states.get(variant, {}))
        return {
            "id": variant,
            "repository": spec.repository,
            "revision": spec.revision,
            "filename": spec.filename,
            "remote_filename": spec.remote_filename or spec.filename,
            "sha256": spec.sha256,
            "path": str(target),
            "expected_bytes": spec.expected_bytes,
            "downloaded_bytes": min(current_bytes, spec.expected_bytes),
            "progress": min(1.0, current_bytes / spec.expected_bytes),
            "weights_installed": target.is_file() and target.stat().st_size == spec.expected_bytes,
            "downloading": state.get("status") == "downloading",
            **state,
            **MODIFIER_METADATA.get(variant, {}),
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
                repo_id=spec.repository,
                filename=spec.remote_filename or spec.filename,
                revision=spec.revision,
                local_dir=None if spec.remote_filename else target.parent,
                token=os.getenv("HF_TOKEN") or None,
            ))
            if spec.remote_filename:
                staging = target.with_suffix(".safetensors.partial")
                shutil.copyfile(downloaded, staging)
                downloaded = staging
            elif downloaded.resolve() != target.resolve():
                raise RuntimeError(f"Hub returned an unexpected path: {downloaded}")
            if downloaded.stat().st_size != spec.expected_bytes:
                raise RuntimeError(f"Size mismatch: expected {spec.expected_bytes}, got {downloaded.stat().st_size}")
            digest = hashlib.sha256()
            with downloaded.open("rb") as stream:
                for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != spec.sha256:
                raise RuntimeError("SHA-256 mismatch")
            if spec.remote_filename:
                downloaded.replace(target)
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
