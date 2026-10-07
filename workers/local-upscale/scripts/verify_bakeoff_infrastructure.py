"""Real synthetic identity round trip and empty fresh-worker shutdown. No neural job."""
from __future__ import annotations
import hashlib
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

import run_video_bakeoff as harness
from app.benchmark_resources import OwnedSession, cap_current_process
from app.video_benchmark import (AttemptLock, Policy, DECODE_FILTER, ENCODE_FILTER,
    decoder_command, encoder_command, mux_command, ffmpeg_base, worker_launch)
from app.video_pipeline import ffmpeg_executable


def main():
    root=harness.EVAL/"controlled"
    folder=root/"synthetic"
    folder.mkdir(parents=True,exist_ok=True)
    result=dict(status="FAILED",neural_jobs=0,model_loads=0,decode_filter=DECODE_FILTER,encode_filter=ENCODE_FILTER)
    cap_current_process(2)
    owned=OwnedSession(2); worker=None
    token=secrets.token_urlsafe(32)
    ffmpeg=ffmpeg_executable(); ffprobe=shutil.which("ffprobe")
    def run(command,raw=None):
        proc=subprocess.Popen(command,stdin=subprocess.PIPE if raw is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            owned.add(proc.pid)
            owned.snapshot()
            out,err=proc.communicate(raw,timeout=60)
            if proc.returncode: raise RuntimeError(err.decode(errors="replace")[-4000:])
            return out
        finally:
            if proc.poll() is None: proc.kill(); proc.wait(timeout=5)
    with AttemptLock(root,"synthetic"):
        try:
            harness.port_free()
            fixture=folder/"source.mp4"
            run(ffmpeg_base(ffmpeg,2)+["-f","lavfi","-i","testsrc2=size=168x96:rate=24:duration=0.5",
                "-f","lavfi","-i","sine=frequency=1000:sample_rate=32000:duration=0.5",
                "-c:v","libx264","-threads:v","2","-pix_fmt","yuv420p","-c:a","aac","-ac","2",str(fixture)])
            raw=run(decoder_command(ffmpeg,fixture,2))
            assert len(raw)==168*96*3*12
            result["identity_rgb_sha256"]=hashlib.sha256(raw).hexdigest()
            # Reproduce old tags using the identical RGB bytes and old filter.
            old_filter=ENCODE_FILTER.split(",setparams=")[0]
            for name,filter_value in [("old",old_filter),("fixed",ENCODE_FILTER)]:
                video=folder/f"{name}-video.mp4"; native=folder/f"{name}-native.mp4"
                command=encoder_command(ffmpeg,video,fixture,168,96,24,2,video_only=True)
                command[command.index("-vf")+1]=filter_value
                run(command,raw)
                run(mux_command(ffmpeg,video,fixture,native,2))
                streams=harness.probe_capture([ffprobe,"-v","error","-show_streams","-of","json",str(native)],owned)["streams"]
                result[name+"_video_metadata"]={k:streams[0].get(k) for k in
                    ("width","height","nb_frames","avg_frame_rate","color_range","color_space","color_transfer","color_primaries")}
                # A direct YUV decode ignores display tags: prove encode pixels unchanged.
                yuv=run(ffmpeg_base(ffmpeg,2)+["-threads:v","2","-i",str(native),"-map","0:v:0",
                    "-threads:v","2","-f","rawvideo","-pix_fmt","yuv420p","pipe:1"])
                result[name+"_decoded_yuv_sha256"]=hashlib.sha256(yuv).hexdigest()
            result["fixed_metadata"]=harness.verify_output(ffprobe,folder/"fixed-native.mp4",168,96,owned,frames=12)
            result["audio"]={name:harness.audio_signature(ffprobe,path,owned) for name,path in
                [("source",fixture),("output",folder/"fixed-native.mp4")]}
            assert result["audio"]["source"]==result["audio"]["output"]
            assert result["old_decoded_yuv_sha256"]==result["fixed_decoded_yuv_sha256"]
            result["actual_encode_pixels_unchanged"]=True
            result["source_rgb_conversion_unchanged"]=True
            # Hash the actual shared source RGB sequence without storing it or loading a model.
            source=harness.plan("vimeo",Policy(enabled=True,candidate="vimeo"))["source"]
            assert harness.file_sha(source)==harness.SOURCE_SHA
            proc=subprocess.Popen(decoder_command(ffmpeg,source,2),stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW)
            owned.add(proc.pid)
            digest=hashlib.sha256(); byte_count=0
            while data:=proc.stdout.read(1024*1024): digest.update(data); byte_count+=len(data)
            proc.wait(timeout=10)
            assert proc.returncode==0 and byte_count==1344*768*3*124
            result["MAX_I1_shared_input_rgb_sha256"]=digest.hexdigest()
            result["MAX_I1_shared_input_rgb_bytes"]=byte_count
            command,env=worker_launch(harness.WORKER,folder,"vimeo",token,Policy(enabled=True,candidate="vimeo"))
            env["LOCAL_VIDEO_UPSCALE_FFMPEG_PATH"]=ffmpeg
            with (folder/"worker.log").open("wb") as log:
                worker=subprocess.Popen(command,cwd=harness.WORKER,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
                owned.add(worker.pid)
                deadline=time.perf_counter()+30
                while True:
                    owned.snapshot()
                    if worker.poll() is not None: raise RuntimeError("Synthetic worker exited during startup")
                    try:
                        if harness.request("/ready",token)["ok"]: break
                    except OSError: pass
                    if time.perf_counter()>deadline: raise TimeoutError("Synthetic worker readiness")
                    time.sleep(.2)
                result["shutdown"]=harness.shutdown_owned(worker,owned,token,folder/"worker.log")
            assert result["shutdown"]["classification"] in {"CLEAN","DELAYED_CLEAN"}
            harness.port_free()
            result["status"]="SUCCEEDED"
        except Exception as exc:
            result["error"]=str(exc)
        finally:
            if owned.accounting().ActiveProcesses:
                result["forced_cleanup"]=True
                owned.terminate()
                deadline=time.perf_counter()+10
                while owned.accounting().ActiveProcesses and time.perf_counter()<deadline: time.sleep(.1)
            result["final_cleanup_snapshot"]=owned.snapshot()
            result["final_port_state"]=harness.listener_state()
            if result["final_cleanup_snapshot"]["active_processes"] or result["final_port_state"]["open"]:
                result["status"]="FAILED"
            owned.close()
            harness.write_json(folder/"verification.json",result)
    print({k:result.get(k) for k in ("status","error","actual_encode_pixels_unchanged","source_rgb_conversion_unchanged")})
    return 0 if result["status"]=="SUCCEEDED" else 1


if __name__ == "__main__": raise SystemExit(main())
