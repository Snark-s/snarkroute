"""Offline continuation guards; no worker or media processing."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest


def load_review():
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts))
    spec = importlib.util.spec_from_file_location("controlled_review_test", scripts / "build_controlled_review.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_continuation_uses_new_attempt_and_keeps_failed_history(tmp_path):
    module = load_review()
    previous = tmp_path / "comparison" / "verification.json"
    previous.parent.mkdir()
    content = json.dumps({"status": "FAILED", "error": "Available RAM below safety threshold"})
    previous.write_text(content)
    folder, attempt = module.review_session(tmp_path, "2026-10-03")
    assert folder == tmp_path / "comparison-2026-10-03"
    assert attempt == "review-2026-10-03"
    assert previous.read_text() == content
    assert not folder.exists()


@pytest.mark.parametrize("status", ["SUCCEEDED", "RUNNING"])
def test_continuation_refuses_completed_or_active_review(tmp_path, status):
    module = load_review()
    previous = tmp_path / "comparison" / "verification.json"
    previous.parent.mkdir()
    previous.write_text(json.dumps({"status": status}))
    with pytest.raises(ValueError):
        module.review_session(tmp_path, "2026-10-03")


def test_continuation_never_overwrites_an_existing_review(tmp_path):
    module = load_review()
    previous = tmp_path / "comparison" / "verification.json"
    previous.parent.mkdir()
    previous.write_text(json.dumps({"status": "FAILED"}))
    (tmp_path / "comparison-2026-10-03").mkdir()
    with pytest.raises(FileExistsError):
        module.review_session(tmp_path, "2026-10-03")
    with pytest.raises(ValueError):
        module.review_session(tmp_path, "../escape")


def test_review_cpu_override_keeps_all_other_limits():
    module = load_review()
    policy = module.review_policy({"LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT": "200",
        "LOCAL_VIDEO_BENCHMARK_THREADS": "12", "LOCAL_VIDEO_BENCHMARK_MIN_RAM_MIB": "1"})
    assert policy.process_cpu_limit == 200
    assert policy.threads == 2 and policy.sustained_seconds == 10
    assert policy.total_cpu_limit == 85 and policy.min_available_ram_mib == 4096
    assert policy.min_free_mib == 8192 and policy.runtime_min_free_mib == 512
    assert module.review_policy({}).process_cpu_limit == 180


@pytest.mark.parametrize("limit", ["0", "nan", "inf", "201", "-1"])
def test_review_cpu_override_refuses_invalid_or_more_than_two_cpus(limit):
    module = load_review()
    with pytest.raises(ValueError):
        module.review_policy({"LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT": limit})


def test_span_review_requires_success_and_preserves_finished_review(tmp_path):
    module=load_review()
    for candidate in ("original","vimeo"):
        path=tmp_path/"normalized"/f"{candidate}.mp4"
        path.parent.mkdir(exist_ok=True);path.write_bytes(b"existing")
    span=tmp_path/"span";span.mkdir()
    (span/"native.mp4").write_bytes(b"native")
    (span/"result.json").write_text(json.dumps({"status":"FAILED"}))
    with pytest.raises(ValueError): module.span_review_session(tmp_path)
    (span/"result.json").write_text(json.dumps({"status":"SUCCEEDED"}))
    assert module.span_review_session(tmp_path)==(tmp_path/"comparison-span","review-span")
    (tmp_path/"comparison-span").mkdir()
    with pytest.raises(FileExistsError): module.span_review_session(tmp_path)
