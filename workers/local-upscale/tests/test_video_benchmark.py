"""Preparation tests: no model imports, worker launch, media processing or CUDA."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.video_benchmark import (
    AttemptLock, Policy, SustainedGuard, candidate_job, decoder_command,
    encoder_command, normalization_command, mux_command, parse_gpu,
    strict_ort_options, validate_ort_profile, worker_launch, configure_torch,
)


def test_thread_cap_and_launch(tmp_path):
    policy = Policy.from_env({"LOCAL_VIDEO_BENCHMARK": "1", "LOCAL_VIDEO_BENCHMARK_CANDIDATE": "vimeo"})
    command, env = worker_launch(tmp_path, tmp_path / "session", "vimeo", "private", policy)
    assert command[-2:] == ["--port", "8092"]
    assert "app.benchmark_worker" in command
    assert env["OMP_NUM_THREADS"] == env["MKL_NUM_THREADS"] == "2"
    assert env["CUDA_VISIBLE_DEVICES"] == "0"
    assert env["LOCAL_UPSCALE_MODEL_DIR"] == str(tmp_path / "models")
    assert env["LOCAL_UPSCALE_WORKER_TOKEN"] == "private"
    with pytest.raises(ValueError):
        Policy.from_env({"LOCAL_VIDEO_BENCHMARK": "1", "LOCAL_VIDEO_BENCHMARK_CANDIDATE": "vimeo", "LOCAL_VIDEO_BENCHMARK_THREADS": "3"})


@pytest.mark.parametrize("name,scale,chunk,overlap", [("vimeo",2,3,1),("span",4,1,0),("gameup",2,4,2)])
def test_exact_jobs(name, scale, chunk, overlap):
    job = candidate_job(name, "asset")
    assert (job["scale"],job["chunk_size"],job["overlap_frames"]) == (scale,chunk,overlap)
    assert job["device"] == "cuda" and job["audio_handling"] == "copy"
    assert json.loads(json.dumps(job)) == job
    if name == "span":
        assert (job["tile_size"],job["tile_overlap"]) == (256,32)


def test_color_audio_and_normalization_commands():
    decode = decoder_command("ffmpeg", Path("source.mp4"), 2)
    assert "scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24" in decode
    native = encoder_command("ffmpeg", Path("native.mp4"), Path("source.mp4"), 2688,1536,24,2)
    final = normalization_command("ffmpeg", Path("native.mp4"), Path("source.mp4"), Path("final.mp4"), 2)
    assert "-shortest" not in native + final
    assert native[native.index("-c:a")+1] == final[final.index("-c:a")+1] == "copy"
    for key,value in [("-threads:v","2"),("-filter_threads","2"),("-crf","18"),("-preset","medium"),("-g","48"),("-color_range","tv")]:
        assert native[native.index(key)+1] == final[final.index(key)+1] == value
    filters = final[final.index("-vf")+1]
    assert "scale=2520:1440:flags=lanczos" in filters
    assert "pad=2560:1440:20:0" in filters and "setsar=1" in filters
    assert 1344/768 == 2520/1440 and (2560-2520)//2 == 20
    mux = mux_command("ffmpeg",Path("video.mp4"),Path("source.mp4"),Path("native.mp4"),2)
    assert "copy" in mux and "-shortest" not in mux


def test_active_lock_and_attempt_never_retry(tmp_path):
    first = AttemptLock(tmp_path,"vimeo")
    with first:
        with pytest.raises(FileExistsError):
            with AttemptLock(tmp_path,"span"):
                pass
    assert not (tmp_path/"active.lock").exists()
    with pytest.raises(FileExistsError):
        with AttemptLock(tmp_path,"vimeo"):
            pass
    with AttemptLock(tmp_path,"span"):
        pass


def test_gpu_parser_and_threshold():
    gpu = parse_gpu("0, RTX 3080 Laptop GPU, 16384, 12091, 4293, 9\n")
    assert gpu["free_mib"] == 4293
    with pytest.raises(RuntimeError,match="Blocked by current GPU usage"):
        Policy(enabled=True,candidate="vimeo").check_gpu(gpu)
    with pytest.raises(ValueError):
        parse_gpu("N/A")


def test_sustained_cpu_guard_resets():
    guard = SustainedGuard(180,85,10)
    assert not guard.update(0,181,10)
    assert not guard.update(8,10,10)
    assert not guard.update(9,181,10)
    assert guard.update(19,181,10)


def test_strict_ort_configuration_without_importing_ort():
    class Options:
        def __init__(self): self.entries = {}
        def add_session_config_entry(self,key,value): self.entries[key] = value
    fake = SimpleNamespace(SessionOptions=Options,ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"))
    options = strict_ort_options(fake,2,"profile")
    assert (options.intra_op_num_threads,options.inter_op_num_threads) == (2,1)
    assert options.execution_mode == "sequential"
    assert options.entries["session.disable_cpu_ep_fallback"] == "1"
    assert options.entries["session.intra_op.allow_spinning"] == "0"
    assert options.enable_profiling


def test_profile_rejects_cpu_and_missing_provider():
    assert validate_ort_profile([{"cat":"Node","args":{"provider":"CUDAExecutionProvider"}}])["valid"]
    for events in ([],[{"cat":"Node","args":{"provider":"CPUExecutionProvider"}}]):
        with pytest.raises(RuntimeError): validate_ort_profile(events)


def test_torch_pools_with_fake_object(monkeypatch):
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK","1")
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK_CANDIDATE","vimeo")
    values = {}
    fake = SimpleNamespace(set_num_threads=lambda n:values.update(intra=n),set_num_interop_threads=lambda n:values.update(inter=n))
    configure_torch(fake)
    configure_torch(fake)
    assert values == {"intra":2,"inter":1}


def test_service_refuses_cpu_and_second_job(settings,monkeypatch):
    from app.video_service import VideoUpscaleService
    from app.errors import WorkerError
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK","1")
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK_CANDIDATE","span")
    service = VideoUpscaleService(settings)
    service.assets["asset"] = Path("not-decoded.mp4")
    async def no_execution(job): pass
    monkeypatch.setattr(service,"_run",no_execution)
    async def check():
        bad = candidate_job("span","asset") | {"device":"cpu"}
        with pytest.raises(WorkerError): await service.create_job(bad)
        job = await service.create_job(candidate_job("span","asset"))
        await service.tasks[job.id]
        with pytest.raises(WorkerError): await service.create_job(candidate_job("span","asset"))
    asyncio.run(check())


def test_real_pipeline_command_hooks_are_opt_in(monkeypatch,tmp_path):
    from app.video_pipeline import _start_decoder,_start_encoder,VideoProbe
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK","1")
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK_CANDIDATE","vimeo")
    commands=[]
    monkeypatch.setattr("app.video_pipeline.subprocess.Popen",lambda command,**kw:commands.append(command))
    monkeypatch.setattr("app.video_pipeline.ffmpeg_executable",lambda:"ffmpeg")
    _start_decoder(tmp_path/"source.mp4")
    probe=VideoProbe(1344,768,24,124,124/24,"h264","yuv420p",True,"aac",0)
    _start_encoder(tmp_path/"video-only.mp4",tmp_path/"source.mp4",probe,2,18,"copy")
    assert "in_color_matrix=bt709" in commands[0][commands[0].index("-vf")+1]
    assert "-c:a" not in commands[1]  # explicit separately timed audio remux in benchmark
    assert commands[1][commands[1].index("-threads:v")+1] == "2"


def load_harness():
    import importlib.util
    path=Path(__file__).parents[1]/"scripts/run_video_bakeoff.py"
    spec=importlib.util.spec_from_file_location("bakeoff_harness",path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_harness_default_is_plan_only(monkeypatch,tmp_path):
    import sys
    module=load_harness()
    monkeypatch.setattr(module,"plan",lambda *args:{"execution_approved":False})
    monkeypatch.setattr(module,"execute",lambda *args:pytest.fail("Must never execute without approval"))
    monkeypatch.setattr(sys,"argv",["runner","--candidate","vimeo","--write-plan",str(tmp_path/"plan.json")])
    assert module.main() == 0
    assert json.loads((tmp_path/"plan.json").read_text())["execution_approved"] is False
    for argv in (["runner","--candidate","vimeo","--execute"],
                 ["runner","--candidate","vimeo","--execute","--approve-candidate","span"]):
        monkeypatch.setattr(sys,"argv",argv)
        with pytest.raises(SystemExit): module.main()


def test_harness_blocked_gpu_never_starts_worker_or_retries(monkeypatch,tmp_path):
    module=load_harness()
    monkeypatch.setattr(module,"EVAL",tmp_path)
    monkeypatch.setattr(module,"plan",lambda *args:{"license":"CC-BY-SA-4.0"})
    monkeypatch.setattr(module,"port_free",lambda:None)
    monkeypatch.setattr(module,"query_gpu",lambda:parse_gpu("0, GPU, 16384, 12091, 4293, 9"))
    monkeypatch.setattr(module.subprocess,"Popen",lambda *args,**kw:pytest.fail("Blocked precheck must never spawn"))
    result=module.execute("vimeo",Policy(enabled=True,candidate="vimeo"))
    assert result["status"] == "BLOCKED" and result["retry"] is False
    assert (tmp_path/"controlled/vimeo.attempt.json").exists()
    with pytest.raises(FileExistsError): module.execute("vimeo",Policy(enabled=True,candidate="vimeo"))


def test_explicit_blocked_continuation_keeps_old_attempt(tmp_path):
    module=load_harness()
    session=tmp_path/"span";session.mkdir()
    (session/"result.json").write_text(json.dumps({"status":"BLOCKED"}))
    marker=tmp_path/"span.attempt.json";marker.write_text("original")
    name,archive=module.execution_attempt(tmp_path,"span","2026-10-04")
    assert name=="span-2026-10-04" and archive==tmp_path/"history/span-blocked-before-2026-10-04"
    assert marker.read_text()=="original"
    for status in ("FAILED","SUCCEEDED"):
        (session/"result.json").write_text(json.dumps({"status":status}))
        with pytest.raises(ValueError): module.execution_attempt(tmp_path,"span","2026-10-04")
    (session/"result.json").write_text(json.dumps({"status":"BLOCKED","job_id":"already-submitted"}))
    with pytest.raises(ValueError): module.execution_attempt(tmp_path,"span","2026-10-04")


def test_ram_precheck_blocks_without_worker_launch():
    module=load_harness()
    policy=Policy(enabled=True,candidate="span")
    with pytest.raises(RuntimeError,match="Blocked by available RAM"):
        module.check_available_ram({"available_ram_bytes":4096*1024**2-1},policy)
    module.check_available_ram({"available_ram_bytes":4096*1024**2},policy)


def test_strict_ort_runtime_uses_cuda_only_without_model(monkeypatch,tmp_path):
    import sys
    from app.video_runtime import TSCUNetOnnxRuntime
    from app.errors import WorkerError
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK","1")
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK_CANDIDATE","gameup")
    monkeypatch.setenv("LOCAL_UPSCALE_DATA_DIR",str(tmp_path))
    class Options:
        def add_session_config_entry(self,*args): pass
    class Session:
        def __init__(self,path,providers,sess_options):
            assert providers == ["CUDAExecutionProvider"]
            assert sess_options.intra_op_num_threads == 2
            self.fallback=True
            self._create_inference_session(providers,None)
        def _create_inference_session(self,providers,provider_options,disabled_optimizers=None):
            assert self.fallback is False  # disabled BEFORE any model/session load
        def disable_fallback(self): self.fallback=False
        def get_providers(self): return ["CUDAExecutionProvider"]
        def get_inputs(self): return [SimpleNamespace(shape=[1,15,64,64],name="rgb")]
        def run(self,*args): pytest.fail("No inference allowed")
    fake=SimpleNamespace(__version__="1.22.0",SessionOptions=Options,ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL=0),
        get_available_providers=lambda:["CUDAExecutionProvider"],InferenceSession=Session)
    monkeypatch.setitem(sys.modules,"onnxruntime",fake)
    runtime=TSCUNetOnnxRuntime(tmp_path/"not-loaded.onnx","cuda",2,5)
    assert runtime.device_type == "cuda" and runtime.session.fallback is False
    monkeypatch.setattr(Session,"get_providers",lambda self:["CUDAExecutionProvider","CPUExecutionProvider"])
    assert TSCUNetOnnxRuntime(tmp_path/"not-loaded.onnx","cuda",2,5).device_type == "cuda"
    monkeypatch.setattr(Session,"get_providers",lambda self:["CPUExecutionProvider"])
    with pytest.raises(WorkerError): TSCUNetOnnxRuntime(tmp_path/"not-loaded.onnx","cuda",2,5)


def test_ort_constructor_failure_has_no_internal_ep_retry(monkeypatch,tmp_path):
    from app.video_benchmark import ort_session
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK","1")
    monkeypatch.setenv("LOCAL_VIDEO_BENCHMARK_CANDIDATE","gameup")
    monkeypatch.setenv("LOCAL_UPSCALE_DATA_DIR",str(tmp_path))
    calls=[]
    class Options:
        def add_session_config_entry(self,*args): pass
    class Session:
        def __init__(self,path,providers,sess_options):
            self.fallback=True
            try: self._create_inference_session(providers,None)
            except RuntimeError:
                if self.fallback: self._create_inference_session(["CPUExecutionProvider"],None)
                raise
        def _create_inference_session(self,providers,*args):
            calls.append(providers)
            raise RuntimeError("CUDA backend failure")
        def disable_fallback(self): self.fallback=False
    fake=SimpleNamespace(__version__="1.22.0",SessionOptions=Options,ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL=0),InferenceSession=Session)
    with pytest.raises(RuntimeError,match="CUDA backend failure"): ort_session(fake,tmp_path/"not-loaded.onnx","cuda")
    assert calls == [["CUDAExecutionProvider"]]
    fake.__version__="1.23.0"
    with pytest.raises(RuntimeError,match="reviewed ORT"): ort_session(fake,tmp_path/"not-loaded.onnx","cuda")
    assert len(calls) == 1


def test_aac_packet_hash_verification_without_media_processing(monkeypatch):
    module=load_harness()
    packets=[{"size":"17","data_hash":"SHA256:aaa"},{"size":"23","data_hash":"SHA256:bbb"}]
    monkeypatch.setattr(module,"probe_capture",lambda *args:{"packets":packets})
    first=module.audio_signature("unused",Path("unused.mp4"))
    packets[1]["data_hash"]="SHA256:ccc"
    assert first != module.audio_signature("unused",Path("unused.mp4"))


def test_windows_job_affinity_ownership_and_cleanup_with_fake_api(monkeypatch):
    from app import benchmark_resources as resources
    calls=[]
    def affinity(handle,allowed,system):
        allowed._obj.value=0xffff; system._obj.value=0xffff; return 1
    def limits(handle,info,value,size):
        calls.append(("limits",value._obj.Basic.Flags,value._obj.Basic.Affinity)); return 1
    def query(handle,info,value,size,unused):
        if info == 1: value._obj.ActiveProcesses=0
        else: value._obj.Count=0
        return 1
    def system_times(idle,kernel,user):
        idle._obj.value=10; kernel._obj.value=20; user._obj.value=30; return 1
    def memory(value): value._obj.AvailablePhysical=8*1024**3; return 1
    fake=SimpleNamespace(CreateJobObjectW=lambda *args:111,GetCurrentProcess=lambda:222,
        GetProcessAffinityMask=affinity,SetInformationJobObject=limits,
        OpenProcess=lambda *args:333,AssignProcessToJobObject=lambda job,process:calls.append(("assign",job,process)) or 1,
        QueryInformationJobObject=query,GetSystemTimes=system_times,GlobalMemoryStatusEx=memory,
        CloseHandle=lambda handle:calls.append(("close",handle)) or 1,
        TerminateJobObject=lambda handle,code:calls.append(("terminate",handle)) or 1)
    monkeypatch.setattr(resources,"windows_api",lambda:fake)
    def process_memory(*args): return 1
    monkeypatch.setattr(resources.c,"WinDLL",lambda *args,**kw:SimpleNamespace(GetProcessMemoryInfo=process_memory))
    owned=resources.OwnedSession(2)
    assert ("limits",0x2010,3) in calls  # two logical CPUs, kill-on-close
    owned.add(12345)
    assert ("assign",111,333) in calls
    assert owned.sample()["available_ram_bytes"] == 8*1024**3
    owned.terminate(); owned.close()
    assert ("terminate",111) in calls and ("close",111) in calls


def test_sampler_can_close_before_start_without_queries():
    module=load_harness()
    sampler=module.Sampler(object(),Policy(enabled=True,candidate="vimeo"))
    sampler.close()
    assert not sampler.samples and sampler.stop.is_set()


@pytest.mark.parametrize("counts,returncode,expected", [
    ([0],0,"CLEAN"), ([1,0],0,"DELAYED_CLEAN"),
    ([1,1,1],0,"UNCLEAN"), ([0],1,"UNKNOWN"),
])
def test_bounded_shutdown_classification(monkeypatch,tmp_path,counts,returncode,expected):
    module=load_harness()
    clock=[0.0]
    monkeypatch.setattr(module.time,"perf_counter",lambda:clock[0])
    monkeypatch.setattr(module.time,"sleep",lambda seconds:clock.__setitem__(0,clock[0]+seconds))
    monkeypatch.setattr(module,"request",lambda *args:{"shutdown_requested":True})
    monkeypatch.setattr(module,"listener_state",lambda:{"open":False,"listeners":[]})
    class Owned:
        def snapshot(self):
            count=counts.pop(0) if len(counts)>1 else counts[0]
            return {"active_processes":count,"processes":[]}
    worker=SimpleNamespace(pid=123,poll=lambda:returncode,returncode=returncode)
    result=module.shutdown_owned(worker,Owned(),"private",tmp_path/"worker.log",grace=.2)
    assert result["classification"] == expected
    assert result["worker_returncode"] == returncode
    assert result["immediately_after_request"] and result["after_grace"]
    assert clock[0] <= .3


def test_encode_frames_have_explicit_bt709_tags():
    from app.video_benchmark import ENCODE_FILTER,DECODE_FILTER
    assert DECODE_FILTER == "scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24"
    assert "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709" in ENCODE_FILTER


def test_shutdown_closed_processes_but_open_port_is_unknown(monkeypatch,tmp_path):
    module=load_harness()
    monkeypatch.setattr(module,"request",lambda *args:{"shutdown_requested":True})
    monkeypatch.setattr(module,"listener_state",lambda:{"open":True,"listeners":["external or ambiguous"]})
    owned=SimpleNamespace(snapshot=lambda:{"active_processes":0,"processes":[]})
    worker=SimpleNamespace(pid=123,poll=lambda:0,returncode=0)
    assert module.shutdown_owned(worker,owned,"private",tmp_path/"missing.log")["classification"]=="UNKNOWN"


def test_process_snapshot_retains_identity_after_exit():
    import threading
    from app import benchmark_resources as resources
    owned=object.__new__(resources.OwnedSession)
    owned.snapshot_lock=threading.RLock()
    owned.process_handles={};owned.process_images={};owned.affinity=3
    active=[123]
    owned.pids=lambda:list(active)
    owned.accounting=lambda:SimpleNamespace(ActiveProcesses=len(active))
    def times(handle,created,exited,kernel,user):
        created._obj.value=116444736000000000+10000000
        exited._obj.value=0 if active else 116444736000000000+20000000
        return 1
    def code(handle,value): value._obj.value=259 if active else 0;return 1
    def name(handle,flags,value,length):
        if not active: return 0
        value.value="worker-child.exe";return 1
    owned.kernel=SimpleNamespace(OpenProcess=lambda *args:456,GetProcessTimes=times,
        GetExitCodeProcess=code,QueryFullProcessImageNameW=name)
    first=owned.snapshot();active.clear();last=owned.snapshot()
    assert first["active_pids"]==[123] and first["processes"][0]["exit_status"]==259
    assert last["active_processes"]==0 and last["processes"][0]["exit_status"]==0
    assert last["processes"][0]["image"]=="worker-child.exe"
    assert last["processes"][0]["start_time"] and last["processes"][0]["exit_time"]


def test_preparation_never_imports_real_ml_libraries():
    import sys
    assert "torch" not in sys.modules and "onnxruntime" not in sys.modules
