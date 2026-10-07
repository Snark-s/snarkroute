"""Preparation by default. Future execution requires one matching explicit approval.

No imports or actions here load a model. Only the --execute branch starts a worker.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import UTC, date, datetime
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]
ROOT = WORKER.parents[1]
sys.path.insert(0,str(WORKER))
from app.video_benchmark import (AttemptLock,CANDIDATES,Policy,SustainedGuard,candidate_job,
    normalization_command,query_gpu,worker_launch,DECODE_FILTER,ENCODE_FILTER)
from app.benchmark_resources import OwnedSession, cap_current_process

EVAL = ROOT / "apps/server/data/video-upscale-eval/2026-09-30"
SOURCE_SHA = "ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9"


def write_json(path,value):
    path = Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8")
    temporary.replace(path)


def plan(candidate,policy):
    preflight = json.loads((EVAL/"preflight.json").read_text(encoding="utf-8"))
    source = Path(preflight["source"]["path"])
    session = EVAL/"controlled"/candidate
    command,env = worker_launch(WORKER,session,candidate,"<ephemeral private token>",policy)
    ffmpeg = os.environ.get("LOCAL_VIDEO_UPSCALE_FFMPEG_PATH")
    if not ffmpeg:
        distribution=importlib.metadata.distribution("imageio-ffmpeg")
        binary=next(f for f in distribution.files if f.name.startswith("ffmpeg") and f.name.endswith(".exe"))
        ffmpeg=str(distribution.locate_file(binary).resolve())  # locate only, never invoke FFmpeg
    item = next(m for m in preflight["inventory"] if m["id"] == CANDIDATES[candidate]["model"])
    return dict(candidate=candidate,execution_approved=False,worker_cwd=str(WORKER),worker_command=command,
        worker_environment={k:v for k,v in env.items() if k.startswith(("LOCAL_UPSCALE_","LOCAL_VIDEO_BENCHMARK_")) or k in
            {"LOCAL_VIDEO_BENCHMARK","OMP_NUM_THREADS","MKL_NUM_THREADS","OPENBLAS_NUM_THREADS","NUMEXPR_NUM_THREADS","VECLIB_MAXIMUM_THREADS","CUDA_VISIBLE_DEVICES","PYTHONUTF8","PYTHONUNBUFFERED"}},
        endpoint="http://127.0.0.1:8092/v1/video/jobs",job=candidate_job(candidate,"<uploaded MAX-I1 asset>"),
        source=str(source),source_sha256=SOURCE_SHA,weights=item["modelFile"],weights_sha256=item["sha256"],weights_size_bytes=item["checkpoint_size_bytes"],license=item["license"],
        native_output=str(session/"native.mp4"),normalized_output=str(session/"normalized.mp4"),
        normalize_command=normalization_command(ffmpeg,session/"native.mp4",source,session/"normalized.mp4",policy.threads),
        source_baseline_command=normalization_command(ffmpeg,source,source,EVAL/"baseline-normalized.mp4",policy.threads),
        retry=False,next_candidate_queued=False)


def request(path,token,method="GET",body=None,content_type="application/json"):
    headers={"Authorization":f"Bearer {token}","Content-Type":content_type,"X-Filename":"MAX-I1.mp4"}
    if isinstance(body,dict): body=json.dumps(body).encode()
    req=urllib.request.Request("http://127.0.0.1:8092"+path,data=body,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=10) as response: data=response.read()
    return data if path.endswith("/content") else json.loads(data)


def probe_capture(command,owned=None):
    proc=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        if owned: owned.add(proc.pid)
        stdout,stderr=proc.communicate(timeout=30)
        if proc.returncode: raise RuntimeError(f"ffprobe failed: {stderr[-2000:].decode(errors='replace')}")
        return json.loads(stdout)
    except BaseException:
        if proc.poll() is None: proc.kill(); proc.wait(timeout=5)
        raise


def audio_signature(ffprobe,path,owned=None):
    packets=probe_capture([ffprobe,"-v","error","-threads","2","-select_streams","a:0","-show_packets","-show_data_hash","sha256",
        "-show_entries","packet=size,data_hash","-of","json",str(path)],owned)["packets"]
    if not packets or any("data_hash" not in packet for packet in packets): raise RuntimeError("Audio packet hashes unavailable")
    payload=json.dumps([(p["size"],p["data_hash"]) for p in packets],separators=(",",":")).encode()
    return dict(packets=len(packets),encoded_packet_sequence_sha256=hashlib.sha256(payload).hexdigest())


def verify_output(ffprobe,path,width,height,owned=None,frames=124):
    streams=probe_capture([ffprobe,"-v","error","-threads","2","-show_streams","-of","json",str(path)],owned)["streams"]
    video=next(s for s in streams if s["codec_type"] == "video")
    expected=dict(width=width,height=height,codec_name="h264",pix_fmt="yuv420p",color_range="tv",
        color_space="bt709",color_transfer="bt709",color_primaries="bt709",sample_aspect_ratio="1:1",avg_frame_rate="24/1",nb_frames=str(frames))
    for key,value in expected.items():
        if video.get(key) != value: raise RuntimeError(f"Invalid output {key}: {video.get(key)!r}, expected {value!r}")
    audio=next(s for s in streams if s["codec_type"] == "audio")
    if (audio["codec_name"],audio["sample_rate"],audio["channels"]) != ("aac","32000",2): raise RuntimeError("AAC format changed")
    return dict({k:video[k] for k in expected},audio={k:audio.get(k) for k in
        ("codec_name","sample_rate","channels","duration","nb_frames")})


def file_sha(path):
    with open(path,"rb") as handle: return hashlib.file_digest(handle,"sha256").hexdigest()


def port_free():
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1",8092)) == 0: raise RuntimeError("Port 8092 is already occupied; no duplicate worker will start")


def listener_state():
    with socket.socket() as sock:
        sock.settimeout(1)
        opened = sock.connect_ex(("127.0.0.1",8092)) == 0
    listing = subprocess.run(["netstat","-ano","-p","tcp"],capture_output=True,text=True,timeout=5,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    return dict(open=opened,listeners=[line.strip() for line in listing.stdout.splitlines()
        if ":8092 " in line and "LISTENING" in line],probe_returncode=listing.returncode)


def shutdown_owned(worker,owned,token,log_path,grace=15):
    diagnostics=dict(worker_pid=worker.pid,shutdown_requested_at=datetime.now(UTC).isoformat(),
        grace_seconds=grace,termination_signal="authenticated Uvicorn should_exit; no OS signal")
    try: diagnostics["response"]=request("/v1/benchmark/shutdown",token,"POST")
    except Exception as exc: diagnostics["request_error"]=str(exc)
    diagnostics["immediately_after_request"]=owned.snapshot()
    diagnostics["port_immediately_after_request"]=listener_state()
    started=time.perf_counter()
    initial_clear=worker.poll() == 0 and diagnostics["immediately_after_request"]["active_processes"] == 0
    snapshot=diagnostics["immediately_after_request"]
    while (worker.poll() is None or snapshot["active_processes"]) and time.perf_counter()-started < grace:
        time.sleep(.1)
        snapshot=owned.snapshot()
    diagnostics["after_grace"]=snapshot
    diagnostics["elapsed_seconds"]=time.perf_counter()-started
    diagnostics["worker_returncode"]=worker.poll()
    diagnostics["port_after_grace"]=listener_state()
    if worker.poll() is None or snapshot["active_processes"]:
        classification="UNCLEAN"
    elif worker.returncode != 0 or diagnostics["port_after_grace"]["open"] or snapshot.get("identity_errors"):
        classification="UNKNOWN"
    else: classification="CLEAN" if initial_clear else "DELAYED_CLEAN"
    diagnostics["classification"]=classification
    path=Path(log_path)
    if path.exists():
        with path.open("rb") as handle:
            handle.seek(max(0,path.stat().st_size-8000))
            diagnostics["stdout_stderr_tail"]=handle.read().decode("utf-8",errors="replace")
    else: diagnostics["stdout_stderr_tail"]=""
    return diagnostics


class Sampler:
    def __init__(self,owned,policy):
        self.owned,self.policy=owned,policy
        self.stop=threading.Event(); self.failure=None; self.samples=[]; self.pids=set()
        self.guard=SustainedGuard(policy.process_cpu_limit,policy.total_cpu_limit,policy.sustained_seconds)
        self.thread=threading.Thread(target=self.run,daemon=True)
    def run(self):
        while not self.stop.is_set():
            try:
                sample=self.owned.sample(); self.pids.update(self.owned.pids()); sample["gpu"]=query_gpu()
                self.samples.append(sample)
                if sample["available_ram_bytes"] < self.policy.min_available_ram_mib*1024**2:
                    raise RuntimeError("Available RAM below safety threshold")
                if sample["gpu"]["free_mib"] < self.policy.runtime_min_free_mib:
                    raise RuntimeError("Runtime free VRAM below safety threshold")
                if sample["process_cpu_percent_one_core"] is not None and self.guard.update(sample["monotonic_seconds"],sample["process_cpu_percent_one_core"],sample["total_cpu_percent"]):
                    raise RuntimeError("Sustained CPU usage above safety threshold")
            except Exception as exc:
                self.failure=str(exc); return
            self.stop.wait(2)
    def check(self):
        if self.failure: raise RuntimeError(self.failure)
    def close(self):
        self.stop.set()
        if self.thread.ident is not None: self.thread.join(timeout=10)


def run_owned(command,cwd,env,owned,sampler,log,timeout):
    proc=subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=log,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try: owned.add(proc.pid)
    except BaseException:
        proc.kill(); proc.wait(timeout=5); raise
    sampler.pids.add(proc.pid)
    started=time.perf_counter()
    while proc.poll() is None:
        sampler.check()
        if time.perf_counter()-started > timeout: raise TimeoutError("Owned subprocess timed out")
        time.sleep(.25)
    if proc.returncode: raise RuntimeError(f"Owned subprocess failed with exit code {proc.returncode}; see session log")
    return time.perf_counter()-started


def execution_attempt(root,candidate,resume_blocked):
    if not resume_blocked: return candidate,None
    if date.fromisoformat(resume_blocked).isoformat()!=resume_blocked: raise ValueError("Continuation must be an ISO date")
    session=root/candidate
    previous=json.loads((session/"result.json").read_text(encoding="utf-8"))
    if previous.get("status")!="BLOCKED" or previous.get("job_id") or previous.get("worker_job") or (session/"submitted-job.json").exists() or (session/"native.mp4").exists():
        raise ValueError("Explicit continuation requires a prior BLOCKED precheck with no job or native output")
    archive=root/"history"/f"{candidate}-blocked-before-{resume_blocked}"
    if archive.exists(): raise FileExistsError("Continuation archive already exists; no retry")
    return f"{candidate}-{resume_blocked}",archive


def check_available_ram(sample,policy):
    if sample["available_ram_bytes"]<policy.min_available_ram_mib*1024**2:
        raise RuntimeError(f"Blocked by available RAM: {sample['available_ram_bytes']/1024**2:.1f} MiB < {policy.min_available_ram_mib} MiB")


def stale_benchmark_workers():
    script="@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*app.benchmark_worker*' } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress"
    result=subprocess.run(["powershell","-NoProfile","-Command",script],capture_output=True,text=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode: raise RuntimeError("Stale worker precheck failed")
    value=json.loads(result.stdout) if result.stdout.strip() else []
    return value if isinstance(value,list) else [value]


def execute(candidate,policy,resume_blocked=None,native_only=False):
    prepared=plan(candidate,policy)
    session=EVAL/"controlled"/candidate
    result=dict(candidate=candidate,status="FAILED",retry=False,next_candidate_queued=False,
        started_at=datetime.now(UTC).isoformat(),license=prepared["license"],gpu_memory_attribution="System-level nvidia-smi; not model allocations",
        native_only=native_only,job_submission_attempts=0,resume_blocked=resume_blocked)
    started=time.perf_counter(); owned=None; sampler=None; worker=None; token=secrets.token_urlsafe(32)
    attempt_name,archive=execution_attempt(EVAL/"controlled",candidate,resume_blocked)
    with AttemptLock(EVAL/"controlled",attempt_name) as attempt:
        if archive:
            archive.mkdir(parents=True)
            for previous in session.iterdir():
                if previous.is_file(): shutil.copyfile(previous,archive/previous.name)
            result["previous_blocked_archive"]=str(archive)
        session.mkdir(parents=True,exist_ok=True)
        write_json(session/"request.json",dict(prepared,execution_approved=True))
        try:
            # All these gates precede starting worker, much less model loading.
            if os.name != "nt": raise RuntimeError("Windows containment required")
            port_free()
            result["gpu_precheck"]=query_gpu(); policy.check_gpu(result["gpu_precheck"])
            if file_sha(prepared["source"]) != SOURCE_SHA: raise RuntimeError("MAX-I1 source SHA mismatch")
            if Path(prepared["weights"]).stat().st_size != prepared["weights_size_bytes"]: raise RuntimeError("Installed checkpoint size mismatch; download/retry disabled")
            if file_sha(prepared["weights"]) != prepared["weights_sha256"]: raise RuntimeError("Installed checkpoint SHA mismatch; download/retry disabled")
            synthetic=json.loads((EVAL/"controlled/synthetic/verification.json").read_text(encoding="utf-8"))
            if synthetic.get("status") != "SUCCEEDED" or synthetic.get("decode_filter") != DECODE_FILTER or synthetic.get("encode_filter") != ENCODE_FILTER:
                raise RuntimeError("Synthetic infrastructure validation missing or stale; stop bake-off")
            compute=subprocess.run(["nvidia-smi","-i","0","--query-compute-apps=pid,process_name,used_gpu_memory","--format=csv,noheader"],
                capture_output=True,text=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW)
            result["gpu_compute_processes_precheck"]=dict(returncode=compute.returncode,output=compute.stdout.strip(),stderr=compute.stderr.strip())
            ffprobe=os.getenv("LOCAL_VIDEO_BENCHMARK_FFPROBE") or shutil.which("ffprobe")
            if not ffprobe: raise RuntimeError("ffprobe is required for output metadata/audio verification")
            from app.video_pipeline import ffmpeg_executable
            ffmpeg=ffmpeg_executable()
            command,env=worker_launch(WORKER,session,candidate,token,policy)
            env["LOCAL_VIDEO_UPSCALE_FFMPEG_PATH"]=ffmpeg
            owned=OwnedSession(policy.threads); sampler=Sampler(owned,policy)
            cap_current_process(policy.threads)  # harness/probes use the same two CPUs as the owned job
            result["resource_precheck"]=owned.sample()
            check_available_ram(result["resource_precheck"],policy)
            result["stale_worker_pids"]=stale_benchmark_workers()
            if result["stale_worker_pids"]: raise RuntimeError("Blocked by stale benchmark worker; no external processes changed")
            with (session/"worker.log").open("wb") as log:
                startup=time.perf_counter()
                worker=subprocess.Popen(command,cwd=WORKER,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
                try: owned.add(worker.pid)
                except BaseException:
                    worker.kill(); worker.wait(timeout=5); raise
                sampler.pids.add(worker.pid); sampler.thread.start()
                while True:
                    sampler.check()
                    if worker.poll() is not None: raise RuntimeError("Worker exited during startup; see worker.log")
                    try:
                        ready=request("/ready",token)
                        if ready["ok"]: break
                    except (ConnectionError,OSError): pass  # readiness polling, never retries a job
                    if time.perf_counter()-startup > 30: raise TimeoutError("Worker startup timed out")
                    time.sleep(.5)
                result["worker_startup_seconds"]=time.perf_counter()-startup
                sampler.check(); policy.check_gpu(query_gpu())
                source=Path(prepared["source"])
                asset=request("/v1/video/assets",token,"POST",source.read_bytes(),"video/mp4")
                body=candidate_job(candidate,asset["id"])
                write_json(session/"submitted-job.json",body)
                result["job_submission_attempts"]=1
                job=request("/v1/video/jobs",token,"POST",body)  # exactly one submission, no retry
                result["job_id"]=job["id"]
                while job["status"] not in {"succeeded","failed","cancelled"}:
                    sampler.check()
                    if time.perf_counter()-started > 1900: raise TimeoutError("Benchmark wall timeout")
                    time.sleep(1)
                    job=request("/v1/video/jobs/"+job["id"],token)
                result["worker_job"]=job
                if job["status"] != "succeeded": raise RuntimeError(f"Candidate ended {job['status']}: {job.get('error')}")
                (session/"native.mp4").write_bytes(request("/v1/video/jobs/"+job["id"]+"/content",token))
                # Remove the model cache before normalization; graceful Uvicorn exit first.
                result["shutdown"]=shutdown_owned(worker,owned,token,session/"worker.log")
                write_json(session/"shutdown.json",result["shutdown"])
                if result["shutdown"]["classification"] not in {"CLEAN","DELAYED_CLEAN"}:
                    raise RuntimeError("Worker shutdown infrastructure validation failed: "+result["shutdown"]["classification"])
                result["worker_exit_verified"]=True
                result["gpu_after_worker_exit"]=query_gpu()
                result["gpu_approximately_returned"]=result["gpu_after_worker_exit"]["used_mib"] <= result["gpu_precheck"]["used_mib"]+1024
                if not result["gpu_approximately_returned"]: raise RuntimeError("GPU cleanup infrastructure validation failed")
                scale=CANDIDATES[candidate]["scale"]
                result["native_metadata"]=verify_output(ffprobe,session/"native.mp4",1344*scale,768*scale,owned)
                if not native_only:
                    result["resize_normalize_encode_seconds"]=run_owned(
                        normalization_command(ffmpeg,session/"native.mp4",source,session/"normalized.mp4",policy.threads),
                        WORKER,env,owned,sampler,log,300)
                    result["normalized_metadata"]=verify_output(ffprobe,session/"normalized.mp4",2560,1440,owned)
                outputs=[("source",source),("native",session/"native.mp4")]
                if not native_only: outputs.append(("normalized",session/"normalized.mp4"))
                result["audio"]={name:audio_signature(ffprobe,path,owned) for name,path in
                    outputs}
                if any(value!=result["audio"]["source"] for value in result["audio"].values()):
                    raise RuntimeError("Encoded AAC packet sequence changed")
                sampler.check()
                result["output_bytes"]={name:(session/f"{name}.mp4").stat().st_size for name in (["native"] if native_only else ["native","normalized"])}
                result["status"]="SUCCEEDED"
        except Exception as exc:
            result["error"]=str(exc)
            result["status"]="BLOCKED" if "Blocked by " in str(exc) else "FAILED"
        finally:
            if worker and owned and "shutdown" not in result:
                try: result["shutdown"]=shutdown_owned(worker,owned,token,session/"worker.log")
                except Exception as exc: result["shutdown"]={"classification":"UNKNOWN","diagnostic_error":str(exc)}
            if result.get("shutdown",{}).get("classification") in {"UNCLEAN","UNKNOWN"}:
                result["status"]="FAILED"
            if sampler:
                sampler.close(); result["resource_samples"]=sampler.samples
                if sampler.failure:
                    result["status"]="FAILED"; result["resource_guard_error"]=sampler.failure
            if owned:
                try:
                    if owned.accounting().ActiveProcesses:
                        result["forced_owned_cleanup"]=True
                        result.setdefault("shutdown",{})["forced_termination"]="TerminateJobObject exit status 1"
                        owned.terminate()
                        deadline=time.perf_counter()+10
                        while owned.accounting().ActiveProcesses and time.perf_counter() < deadline: time.sleep(.1)
                    result["owned_process_exit_verified"]=owned.accounting().ActiveProcesses == 0
                    result["final_cleanup_snapshot"]=owned.snapshot()
                except Exception as exc:
                    result["owned_process_exit_verified"]=False
                    result["cleanup_error"]=str(exc)
                finally: owned.close()
                if not result["owned_process_exit_verified"]:
                    result["status"]="FAILED"
                    attempt.claimed=False  # retain active.lock; require manual review, never stale-lock recovery
                try: result["gpu_after_cleanup"]=query_gpu()
                except Exception as exc: result["gpu_after_cleanup_error"]=str(exc)
                result["gpu_release_verification"]="Owned processes/contexts exited; system VRAM delta is not attributable under WDDM or concurrent external workloads"
            result["final_port_state"]=listener_state() if owned else {"open":False,"scope":"No owned session started; precheck only"}
            if result["final_port_state"]["open"]: result["status"]="FAILED"
            result["total_wall_seconds"]=time.perf_counter()-started
            write_json(session/"resource-samples.json",result.get("resource_samples",[]))
            write_json(session/"metadata.json",dict(native=result.get("native_metadata"),normalized=result.get("normalized_metadata"),worker_output=result.get("worker_job",{}).get("output")))
            write_json(session/"verification.json",{k:result.get(k) for k in ("status","error","shutdown","audio","native_metadata","normalized_metadata","owned_process_exit_verified","final_port_state","gpu_approximately_returned","final_cleanup_snapshot")})
            if "shutdown" in result: write_json(session/"shutdown.json",result["shutdown"])
            write_json(session/"result.json",result)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate",choices=list(CANDIDATES),required=True)
    parser.add_argument("--execute",action="store_true")
    parser.add_argument("--approve-candidate",choices=list(CANDIDATES))
    parser.add_argument("--write-plan",type=Path)
    parser.add_argument("--resume-blocked",help="New explicit approval date for prior precheck-only BLOCKED attempt; retains history")
    parser.add_argument("--native-only",action="store_true",help="Leave normalization to separately guarded media stage")
    args=parser.parse_args()
    policy=Policy.from_env(dict(os.environ,LOCAL_VIDEO_BENCHMARK="1",LOCAL_VIDEO_BENCHMARK_CANDIDATE=args.candidate))
    if args.execute:
        if args.approve_candidate != args.candidate: parser.error("Execution requires matching --approve-candidate and separate user approval")
        result=execute(args.candidate,policy,args.resume_blocked,args.native_only)
        print(json.dumps({k:result.get(k) for k in ("candidate","status","error","total_wall_seconds")},ensure_ascii=False))
        return 0 if result["status"] == "SUCCEEDED" else 1
    if args.approve_candidate: parser.error("Approval is only accepted with --execute")
    if args.resume_blocked or args.native_only: parser.error("Continuation/native-only require explicit execution approval")
    prepared=plan(args.candidate,policy)
    if args.write_plan: write_json(args.write_plan,prepared)
    else: print(json.dumps(prepared,ensure_ascii=False,indent=2))
    return 0


if __name__ == "__main__": raise SystemExit(main())
