import re
import shutil
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from ..config import Settings

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class StoredResult:
    backend: str
    key: str
    filename: str
    mime_type: str
    bytes: int


class ResultStore(Protocol):
    name: str

    def put(self, job_id: str, index: int, source: Path, filename: str, mime_type: str) -> StoredResult: ...

    def local_path(self, key: str) -> Path | None: ...

    def stream(self, key: str) -> Iterator[bytes]: ...


class LocalResultStore:
    name = "local"

    def __init__(self, root: Path):
        self.root = (root / "results").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, job_id: str, index: int, source: Path, filename: str, mime_type: str) -> StoredResult:
        safe_name = SAFE_NAME.sub("_", Path(filename).name) or f"variant-{index}.mp4"
        target = (self.root / job_id / f"{index}-{safe_name}").resolve()
        if self.root not in target.parents:
            raise ValueError("unsafe result path")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), target)
        return StoredResult(
            self.name, target.relative_to(self.root).as_posix(), safe_name, mime_type, target.stat().st_size
        )

    def local_path(self, key: str) -> Path | None:
        path = (self.root / key).resolve()
        if self.root not in path.parents or not path.is_file():
            return None
        return path

    def stream(self, key: str) -> Iterator[bytes]:
        path = self.local_path(key)
        if not path:
            raise FileNotFoundError(key)
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                yield chunk


class S3ResultStore:
    name = "s3"

    def __init__(self, settings: Settings):
        if not settings.s3_bucket:
            raise RuntimeError("H3_S3_BUCKET is required when H3_STORAGE_BACKEND=s3")
        import boto3

        self.bucket = settings.s3_bucket
        self.prefix = settings.s3_prefix
        self.client: Any = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
        )

    def put(self, job_id: str, index: int, source: Path, filename: str, mime_type: str) -> StoredResult:
        safe_name = SAFE_NAME.sub("_", Path(filename).name) or f"variant-{index}.mp4"
        key = "/".join(part for part in (self.prefix, job_id, f"{index}-{safe_name}") if part)
        self.client.upload_file(str(source), self.bucket, key, ExtraArgs={"ContentType": mime_type})
        size = source.stat().st_size
        source.unlink(missing_ok=True)
        return StoredResult(self.name, key, safe_name, mime_type, size)

    def local_path(self, key: str) -> Path | None:
        return None

    def stream(self, key: str) -> Iterator[bytes]:
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        try:
            yield from body.iter_chunks(chunk_size=1024 * 1024)
        finally:
            body.close()


def create_result_store(settings: Settings) -> ResultStore:
    if settings.storage_backend == "s3":
        return S3ResultStore(settings)
    return LocalResultStore(settings.result_dir)
