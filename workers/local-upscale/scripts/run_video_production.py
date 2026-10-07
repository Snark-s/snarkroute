"""One queue job per contained worker; emits bounded JSON progress, never benchmarks."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import secrets
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(WORKER))
from app.video_benchmark import Policy, worker_launch, query_gpu
from app.benchmark_resources import OwnedSession, cap_current_process
from app.video_production import file_sha
from scripts.run_video_bakeoff import Sampler, port_free, request, shutdown_owned, write_json, check_available_ram, listener_state


def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)


def stale_workers():
    command = "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*app.benchmark_worker*' } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress"
    probe = subprocess.run(["powershell","-NoProfile","-Command",command],capture_output=True,text=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
    if probe.returncode: raise RuntimeError("Blocked by resources: stale worker inspection failed")
    value = json.loads(probe.stdout) if probe.stdout.strip() else []
    return value if isinstance(value,list) else [value]


def run(source,session,settings,mime):
    session.mkdir(parents=True,exist_ok=True)
    root = WORKER / "data/video-production"
    root.mkdir(parents=True,exist_ok=True)
    lock = root / "active.lock"
    claimed = False
    owned = sampler = worker = None
    token = secrets.token_urlsafe(32)
    result = dict(status="FAILED",source_asset=str(source),settings=settings)
    started = time.perf_counter()
    policy = replace(Policy(),enabled=True,candidate="vimeo")  # keep the reviewed safety thresholds
    try:
        try:
            with lock.open("x",encoding="utf-8") as handle: json.dump(dict(pid=os.getpid(),session=str(session)),handle)
            claimed = True
        except FileExistsError: raise RuntimeError("Blocked by resources: active Video Upscale lock; inspect diagnostics before manual cleanup")
        if os.name != "nt": raise RuntimeError("Blocked by resources: Windows owned-process containment is required")
        if (WORKER.parents[1]/"apps/server/data/video-upscale-eval/2026-09-30/controlled/active.lock").exists():
            raise RuntimeError("Blocked by resources: active bake-off lock")
        port_free()
        if stale_workers(): raise RuntimeError("Blocked by resources: stale local upscale worker; no external process was changed")
        result["gpu_precheck"] = query_gpu()
        policy.check_gpu(result["gpu_precheck"])
        owned = OwnedSession(policy.threads)
        cap_current_process(policy.threads)
        result["ram_precheck"] = owned.sample()
        check_available_ram(result["ram_precheck"],policy)
        from app.registry import ModelRegistry
        from app.video_registry import VideoModelRegistry
        registry = VideoModelRegistry.load(ModelRegistry.load())
        model = registry.get(settings["model"])
        weights = model.weights_path(WORKER/"models")
        if not weights or not weights.is_file(): raise RuntimeError("Missing model weights; automatic downloads are disabled")
        if weights.stat().st_size != model.resource.size_bytes or file_sha(weights) != model.resource.sha256:
            raise RuntimeError("Installed model checksum/size mismatch; model was not loaded")
        command,env = worker_launch(WORKER,session,"vimeo",token,policy)
        env.update(LOCAL_VIDEO_BENCHMARK="0",LOCAL_VIDEO_PRODUCTION="1",LOCAL_UPSCALE_JOB_TIMEOUT_SECONDS="7200")
        sampler = Sampler(owned,policy)
        with (session/"worker.log").open("wb") as log:
            worker = subprocess.Popen(command,cwd=WORKER,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
            try: owned.add(worker.pid)
            except BaseException:
                worker.kill(); worker.wait(timeout=5); raise
            sampler.thread.start()
            startup = time.perf_counter()
            while True:
                sampler.check()
                if worker.poll() is not None: raise RuntimeError("Worker exited during startup; see worker.log")
                if (session/"cancel.flag").exists(): raise RuntimeError("cancelled")
                try:
                    if request("/ready",token)["ok"]: break
                except (ConnectionError,OSError): pass
                if time.perf_counter()-startup > 30: raise TimeoutError("Worker startup timed out")
                time.sleep(.25)
            policy.check_gpu(query_gpu())
            asset = request("/v1/video/assets",token,"POST",source.read_bytes(),mime)
            job_request = {k:v for k,v in settings.items() if k not in {"context","profile"}}
            job_request["input_asset"] = asset["id"]
            job = request("/v1/video/jobs",token,"POST",job_request)
            result["worker_job_id"] = job["id"]
            while job["status"] not in {"succeeded","failed","cancelled"}:
                sampler.check()
                emit(dict(progress=job.get("progress",0),stage=job.get("stage"),workerJobId=job["id"]))
                if (session/"cancel.flag").exists():
                    request("/v1/video/jobs/"+job["id"]+"/cancel",token,"POST")
                    raise RuntimeError("cancelled")
                if time.perf_counter()-started > 7300: raise TimeoutError("Video Upscale wall timeout")
                time.sleep(.5)
                job = request("/v1/video/jobs/"+job["id"],token)
            result["worker_output"] = job.get("output")
            if job["status"] != "succeeded":
                result["worker_error"] = job.get("error")
                raise RuntimeError(str(job.get("error") or job["status"]))
            output = session/"result.mp4"
            output.write_bytes(request("/v1/video/jobs/"+job["id"]+"/content",token))
            result.update(status="SUCCEEDED",output=str(output))
    except Exception as exc:
        message = str(exc)
        result.update(status="BLOCKED" if "Blocked by " in message or "Port 8092" in message else "CANCELLED" if message == "cancelled" else "FAILED",error=message)
    finally:
        if worker and owned:
            emit(dict(progress=.99,stage="worker shutdown"))
            try: result["shutdown"] = shutdown_owned(worker,owned,token,session/"worker.log")
            except Exception as exc: result["shutdown"] = dict(classification="UNKNOWN",error=str(exc))
            if result["shutdown"]["classification"] not in {"CLEAN","DELAYED_CLEAN"}:
                result.update(status="FAILED",error="Worker lifecycle: "+result["shutdown"]["classification"])
        if sampler:
            sampler.close()
            write_json(session/"resource-samples.json",sampler.samples)
            if sampler.failure: result.update(status="BLOCKED",error="Blocked by resources: "+sampler.failure)
        cleanup_ok = True
        if owned:
            try:
                if owned.accounting().ActiveProcesses:
                    result["forced_owned_cleanup"] = True
                    owned.terminate()
                    deadline = time.perf_counter()+10
                    while owned.accounting().ActiveProcesses and time.perf_counter()<deadline: time.sleep(.1)
                cleanup_ok = owned.accounting().ActiveProcesses == 0
                result["cleanup"] = owned.snapshot()
            except Exception as exc:
                cleanup_ok = False
                result["cleanup_error"] = str(exc)
            finally: owned.close()
        if worker:
            result["final_port_state"] = listener_state()
            cleanup_ok = cleanup_ok and not result["final_port_state"]["open"]
        if claimed and cleanup_ok: lock.unlink(missing_ok=True)
        if not cleanup_ok: result.update(status="FAILED",error="Worker cleanup could not be verified; active lock retained")
        result["total_wall_seconds"] = time.perf_counter()-started
        result["software_versions"] = {}
        for name in ("torch","numpy","spandrel","imageio-ffmpeg","uvicorn"):
            try: result["software_versions"][name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError: result["software_versions"][name] = "not installed"
        write_json(session/"diagnostics.json",result)
        emit(dict(result=result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request",required=True)
    args = parser.parse_args()
    data = json.loads(Path(args.request).read_text(encoding="utf-8"))
    run(Path(data["source"]),Path(data["session"]),data["settings"],data["mime"])
