"""Opt-in bake-off policy and pure command builders. Importing this loads no ML library."""
from __future__ import annotations

import json
import os
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

CANDIDATES = {
    "vimeo": {"model":"openmodeldb/vimeoscale-unet-x2", "scale":2, "chunk_size":3, "overlap_frames":1, "tile_size":256, "tile_overlap":32},
    "span": {"model":"framewise/4x-purephoto-span", "scale":4, "chunk_size":1, "overlap_frames":0, "tile_size":256, "tile_overlap":32},
    "gameup": {"model":"openmodeldb/gameup-v2-tscunet-small-x2", "scale":2, "chunk_size":4, "overlap_frames":2, "tile_size":256, "tile_overlap":32},
}
DECODE_FILTER = "scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24"
ENCODE_FILTER = "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
NORMALIZE_FILTER = DECODE_FILTER + ",scale=2520:1440:flags=lanczos:in_range=full:out_range=full,format=rgb24,pad=2560:1440:20:0:color=black,format=rgb24,setsar=1," + ENCODE_FILTER


@dataclass(frozen=True)
class Policy:
    enabled: bool = False
    candidate: str = ""
    threads: int = 2
    min_free_mib: int = 8192
    runtime_min_free_mib: int = 512
    process_cpu_limit: float = 180
    total_cpu_limit: float = 85
    sustained_seconds: float = 10
    min_available_ram_mib: int = 4096

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        if env.get("LOCAL_VIDEO_BENCHMARK", "0") != "1": return cls()
        value = cls(True, env.get("LOCAL_VIDEO_BENCHMARK_CANDIDATE", ""),
                    int(env.get("LOCAL_VIDEO_BENCHMARK_THREADS", "2")),
                    int(env.get("LOCAL_VIDEO_BENCHMARK_MIN_FREE_MIB", "8192")),
                    int(env.get("LOCAL_VIDEO_BENCHMARK_RUNTIME_MIN_FREE_MIB", "512")),
                    float(env.get("LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT", "180")),
                    float(env.get("LOCAL_VIDEO_BENCHMARK_TOTAL_CPU_LIMIT", "85")),
                    float(env.get("LOCAL_VIDEO_BENCHMARK_SUSTAINED_SECONDS", "10")),
                    int(env.get("LOCAL_VIDEO_BENCHMARK_MIN_RAM_MIB", "4096")))
        if value.candidate not in CANDIDATES or not 1 <= value.threads <= 2:
            raise ValueError("Benchmark requires one known candidate and 1..2 CPU threads")
        numbers = (value.min_free_mib,value.runtime_min_free_mib,value.process_cpu_limit,
                   value.total_cpu_limit,value.sustained_seconds,value.min_available_ram_mib)
        import math
        if any(not math.isfinite(n) or n <= 0 for n in numbers):
            raise ValueError("Benchmark safety thresholds must be finite and positive")
        return value

    def check_gpu(self, gpu):
        if gpu["free_mib"] < self.min_free_mib:
            raise RuntimeError(f"Blocked by current GPU usage. Current GPU: {gpu['name']}; Used: {gpu['used_mib']} MiB; Free: {gpu['free_mib']} MiB; Required safety threshold: {self.min_free_mib} MiB")


def candidate_job(name: str, asset: str) -> dict:
    return dict(CANDIDATES[name], input_asset=asset,device="cuda",output_codec="libx264",
                output_container="mp4",crf=18,audio_handling="copy")


def ffmpeg_base(exe, threads):
    return [str(exe),"-y","-nostdin","-v","error","-filter_threads",str(threads),
            "-filter_complex_threads",str(threads)]


def encode_profile(threads):
    return ["-c:v","libx264","-preset","medium","-crf","18","-threads:v",str(threads),
            "-pix_fmt","yuv420p","-r","24","-g","48","-keyint_min","48","-sc_threshold","0",
            "-color_range","tv","-colorspace","bt709","-color_trc","bt709","-color_primaries","bt709"]


def decoder_command(exe, path, threads):
    return ffmpeg_base(exe,threads) + ["-threads:v",str(threads),"-i",str(path),"-map","0:v:0",
        "-vf",DECODE_FILTER,"-vsync","0","-threads:v",str(threads),"-f","rawvideo","-pix_fmt","rgb24","pipe:1"]


def encoder_command(exe, path, source, width, height, fps, threads, video_only=False):
    command = ffmpeg_base(exe,threads) + ["-threads:v",str(threads),"-f","rawvideo","-pix_fmt","rgb24",
        "-s",f"{width}x{height}","-r",f"{fps:.8f}","-i","pipe:0"]
    if not video_only:
        command += ["-threads",str(threads),"-i",str(source)]
    command += ["-map","0:v:0"]
    if not video_only: command += ["-map","1:a:0","-c:a","copy"]
    return command + ["-vf",ENCODE_FILTER] + encode_profile(threads) + [str(path)]


def normalization_command(exe, native, source, output, threads):
    return ffmpeg_base(exe,threads) + ["-threads:v",str(threads),"-i",str(native),"-threads",str(threads),
        "-i",str(source),"-map","0:v:0","-map","1:a:0","-c:a","copy","-vf",NORMALIZE_FILTER] + encode_profile(threads) + [str(output)]


def mux_command(exe, video, source, output, threads):
    return ffmpeg_base(exe,threads) + ["-threads",str(threads),"-i",str(video),"-threads",str(threads),
        "-i",str(source),"-map","0:v:0","-map","1:a:0","-c","copy",str(output)]


def parse_gpu(text):
    rows = [line for line in text.splitlines() if line.strip()]
    if len(rows) != 1: raise ValueError("Expected exactly one selected GPU")
    values = [v.strip() for v in rows[0].split(",")]
    if len(values) != 6: raise ValueError("Invalid GPU metric row")
    return dict(index=int(values[0]),name=values[1],total_mib=int(values[2]),used_mib=int(values[3]),
                free_mib=int(values[4]),utilization_percent=int(values[5]))


def query_gpu():
    result = subprocess.run(["nvidia-smi","-i","0","--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu", "--format=csv,noheader,nounits"],
        capture_output=True,text=True,check=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    return parse_gpu(result.stdout)


class AttemptLock:
    """Cross-process exclusive active lock plus persistent no-retry marker; no stale lock recovery."""
    def __init__(self, root, candidate): self.root,self.candidate,self.claimed = Path(root),candidate,False
    def __enter__(self):
        self.root.mkdir(parents=True,exist_ok=True)
        self.path = self.root / "active.lock"
        with self.path.open("x",encoding="utf-8") as handle:
            json.dump(dict(pid=os.getpid(),candidate=self.candidate),handle)
        self.claimed = True
        try:
            with (self.root/f"{self.candidate}.attempt.json").open("x",encoding="utf-8") as handle:
                json.dump(dict(candidate=self.candidate,retry=False),handle)
        except BaseException:
            self.path.unlink()
            self.claimed = False
            raise
        return self
    def __exit__(self,*_):
        if self.claimed: self.path.unlink()


class SustainedGuard:
    def __init__(self, process_limit, total_limit, seconds):
        self.process_limit,self.total_limit,self.seconds = process_limit,total_limit,seconds
        self.since = None
    def update(self, now, process_percent, total_percent):
        if process_percent > self.process_limit or total_percent > self.total_limit:
            if self.since is None: self.since = now
            return now-self.since >= self.seconds
        self.since = None
        return False


def strict_ort_options(ort, threads, profile):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.disable_cpu_ep_fallback","1")
    options.add_session_config_entry("session.intra_op.allow_spinning","0")
    options.add_session_config_entry("session.inter_op.allow_spinning","0")
    options.enable_profiling = True
    options.profile_file_prefix = profile
    return options


def validate_ort_profile(events):
    providers = {e.get("args",{}).get("provider") for e in events if e.get("cat") == "Node" and e.get("args",{}).get("provider")}
    if providers != {"CUDAExecutionProvider"}:
        raise RuntimeError(f"Invalid CUDA-only ORT profile providers: {sorted(providers)}")
    return {"valid":True,"node_providers":sorted(providers)}


def configure_torch(torch):
    policy = Policy.from_env()
    if (policy.enabled or os.getenv("LOCAL_VIDEO_PRODUCTION") == "1") and not getattr(torch,"_snark_benchmark_threads",False):
        torch.set_num_threads(policy.threads)
        torch.set_num_interop_threads(1)
        torch._snark_benchmark_threads = True


def ort_session(ort, path, device):
    policy = Policy.from_env()
    if device != "cuda": raise RuntimeError("Benchmark requires explicit CUDA")
    # ORT 1.22.0's public constructor unconditionally enables an EP retry before
    # returning a session. Disabling fallback afterwards is insufficient for load
    # failures. This narrow version-pinned hook disables it before the first load.
    if getattr(ort,"__version__",None) != "1.22.0" or not hasattr(ort.InferenceSession,"_create_inference_session"):
        raise RuntimeError("Strict no-retry constructor requires the reviewed ORT 1.22.0 API")
    class NoRetrySession(ort.InferenceSession):
        def _create_inference_session(self, providers, provider_options, disabled_optimizers=None):
            self.disable_fallback()
            return super()._create_inference_session(providers,provider_options,disabled_optimizers)
    profile = Path(os.environ["LOCAL_UPSCALE_DATA_DIR"]) / "ort-profile"
    profile.parent.mkdir(parents=True,exist_ok=True)
    session = NoRetrySession(str(path),providers=["CUDAExecutionProvider"],
        sess_options=strict_ort_options(ort,policy.threads,str(profile)))
    session.disable_fallback()
    registered = set(session.get_providers())
    # ORT implicitly registers CPU EP even with CPU graph assignment disabled.
    # Registration is not execution: the option rejects CPU nodes at load time,
    # and the completed profile must still prove exclusively CUDA node execution.
    if "CUDAExecutionProvider" not in registered or registered - {"CUDAExecutionProvider","CPUExecutionProvider"}:
        raise RuntimeError("Benchmark session did not register the requested CUDA provider")
    return session


@contextmanager
def phase(runtime, name):
    if not Policy.from_env().enabled:
        yield; return
    torch = getattr(runtime,"torch",None)
    device = getattr(runtime,"torch_device",None)
    if torch and device is not None: torch.cuda.synchronize(device)
    started = time.perf_counter()
    try: yield
    finally:
        if torch and device is not None: torch.cuda.synchronize(device)
        timings = getattr(runtime,"benchmark_timings",{})
        timings[name] = timings.get(name,0.0) + time.perf_counter()-started
        runtime.benchmark_timings = timings


def worker_launch(worker_root, session, candidate, token, policy):
    worker_root,session = Path(worker_root).resolve(),Path(session).resolve()
    # Explicit environment; do not load root .env containing hosted-provider secrets.
    env = dict(os.environ)
    env.update({"LOCAL_UPSCALE_RUNTIME":"auto","LOCAL_UPSCALE_WORKER_TOKEN":token,
        "LOCAL_UPSCALE_MODEL_DIR":str(worker_root/"models"),"LOCAL_UPSCALE_DATA_DIR":str(session/"worker-data"),
        "LOCAL_UPSCALE_JOB_TIMEOUT_SECONDS":"1800","LOCAL_VIDEO_BENCHMARK":"1",
        "LOCAL_VIDEO_BENCHMARK_CANDIDATE":candidate,"LOCAL_VIDEO_BENCHMARK_THREADS":str(policy.threads),
        "LOCAL_VIDEO_BENCHMARK_MIN_FREE_MIB":str(policy.min_free_mib),
        "LOCAL_VIDEO_BENCHMARK_RUNTIME_MIN_FREE_MIB":str(policy.runtime_min_free_mib),
        "LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT":str(policy.process_cpu_limit),
        "LOCAL_VIDEO_BENCHMARK_TOTAL_CPU_LIMIT":str(policy.total_cpu_limit),
        "LOCAL_VIDEO_BENCHMARK_SUSTAINED_SECONDS":str(policy.sustained_seconds),
        "LOCAL_VIDEO_BENCHMARK_MIN_RAM_MIB":str(policy.min_available_ram_mib),
        "OMP_NUM_THREADS":str(policy.threads),"MKL_NUM_THREADS":str(policy.threads),"OPENBLAS_NUM_THREADS":str(policy.threads),
        "NUMEXPR_NUM_THREADS":str(policy.threads),"VECLIB_MAXIMUM_THREADS":str(policy.threads),
        "CUDA_VISIBLE_DEVICES":"0","PYTHONUNBUFFERED":"1","PYTHONUTF8":"1"})
    return [str(worker_root/".venv/Scripts/python.exe"),"-m","app.benchmark_worker","--port","8092"],env
