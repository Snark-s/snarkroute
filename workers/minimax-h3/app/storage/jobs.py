import json
import re
from pathlib import Path
from typing import Any

JOB_ID = re.compile(r"^[a-f0-9-]{36}$")


class JobRepository:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def directory(self, job_id: str) -> Path:
        if not JOB_ID.fullmatch(job_id):
            raise KeyError(job_id)
        path = (self.root / "jobs" / job_id).resolve()
        if self.root not in path.parents:
            raise KeyError(job_id)
        return path

    def write(self, job: dict[str, Any]) -> None:
        directory = self.directory(str(job["id"]))
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / "job.json.tmp"
        temporary.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(directory / "job.json")

    def read(self, job_id: str) -> dict[str, Any]:
        path = self.directory(job_id) / "job.json"
        if not path.is_file():
            raise KeyError(job_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def load_all(self) -> list[dict[str, Any]]:
        jobs: list[dict[str, Any]] = []
        for path in (self.root / "jobs").glob("*/job.json"):
            try:
                jobs.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return jobs
