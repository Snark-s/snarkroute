from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from app.errors import WorkerError
from app.video_production import PROFILE, model_labels, delivery_geometry, production_encoder_command, verify_output_metadata
from app.video_production import source_color, source_fps, ffprobe_streams, file_sha


def test_profile_and_scoped_labels():
    assert PROFILE == dict(model="openmodeldb/vimeoscale-unet-x2", scale=2, context=3,
        chunk_size=3, overlap_frames=1, device="cuda", audio_handling="copy",
        output_codec="libx264", output_container="mp4", preset="medium", crf=18, gop=48)
    assert model_labels(PROFILE["model"])["group"] == "Production"
    assert "H3 Max / CUDA / 2× tested" in model_labels(PROFILE["model"])["verification"]
    assert model_labels("framewise/4x-purephoto-span")["group"] == "Experimental"
    assert model_labels("openmodeldb/gameup-v2-tscunet-small-x2")["verification"] == "Unverified"


@pytest.mark.parametrize("width,height,target", [(2688,1536,[2560,1440]), (1080,1920,[2560,1440]), (3840,2160,[1920,1080])])
def test_delivery_preserves_aspect_and_pads(width, height, target):
    g = delivery_geometry(width, height, target)
    assert g["width"] == target[0] and g["height"] == target[1]
    assert abs(g["content_width"] / g["content_height"] - width / height) < .003
    assert g["content_width"] <= target[0] and g["content_height"] <= target[1]
    assert g["pad_left"] >= 0 and g["pad_top"] >= 0
    assert delivery_geometry(2688,1536,[2560,1440])["pad_left"] == 20


def test_native_and_delivery_are_distinct():
    assert delivery_geometry(2688,1536,None)["width"] == 2688
    cmd = production_encoder_command("ffmpeg", Path("output.mp4"), Path("source.mp4"),
        2688,1536,29.97,True,"copy",None,18,"medium",48)
    assert "2688x1536" in cmd
    assert cmd[cmd.index("-r")+1] == "29.97000000"
    assert "1:a?" in cmd and "copy" in cmd and "-shortest" not in cmd
    assert "-g" in cmd and "setsar=1" in cmd[cmd.index("-vf")+1]


def test_color_output_verification_fails_closed():
    stream = dict(width=2688,height=1536,color_primaries="bt709",color_transfer="bt709",
        color_space="bt709",color_range="tv",sample_aspect_ratio="1:1",codec_name="h264",pix_fmt="yuv420p")
    verify_output_metadata(stream,2688,1536)
    verify_output_metadata(dict(stream,nb_frames="124",avg_frame_rate="24/1"),2688,1536,124,24)
    with pytest.raises(WorkerError): verify_output_metadata(dict(stream,nb_frames="123",avg_frame_rate="24/1"),2688,1536,124,24)
    with pytest.raises(WorkerError): verify_output_metadata(dict(stream,nb_frames="124",avg_frame_rate="30/1"),2688,1536,124,24)
    for key in ("color_primaries","color_transfer","color_space","color_range"):
        with pytest.raises(WorkerError): verify_output_metadata(dict(stream,**{key:"unknown"}),2688,1536)


def test_missing_color_is_an_assumption_and_hdr_is_rejected():
    color = source_color({})
    assert color["interpretation"] == "BT.709 SDR assumed"
    assert color["source_metadata"]["color_primaries"] is None
    with pytest.raises(WorkerError): source_color(dict(color_transfer="smpte2084"))


def test_fractional_fps_is_preserved_and_vfr_is_explicitly_rejected():
    assert source_fps(dict(avg_frame_rate="24000/1001",r_frame_rate="24000/1001")) == 24000/1001
    with pytest.raises(WorkerError): source_fps(dict(avg_frame_rate="24/1",r_frame_rate="30/1"))


@pytest.mark.asyncio
async def test_default_device_is_cuda_and_explicit_cpu_is_rejected(monkeypatch,tmp_path):
    from app.config import Settings
    from app.video_service import VideoUpscaleService
    monkeypatch.setenv("LOCAL_VIDEO_PRODUCTION","1")
    settings = Settings("test","mock",tmp_path,tmp_path,30,1000000,100000)
    service = VideoUpscaleService(settings)
    asset = service.store_asset(b"fake","source.mp4","video/mp4")
    with pytest.raises(WorkerError,match="CPU fallback"):
        await service.create_job(dict(input_asset=asset["id"],device="cpu"))
    async def fake_run(job): pass
    monkeypatch.setattr(service,"_run",fake_run)
    job = await service.create_job(dict(input_asset=asset["id"]))
    assert job.device == "cuda" and job.chunk_size == 3 and job.overlap_frames == 1
    with pytest.raises(WorkerError,match="exactly one"):
        await service.create_job(dict(input_asset=asset["id"]))
    await service.tasks[job.id]


def test_resource_precheck_and_active_lock_do_not_start_worker(monkeypatch,tmp_path):
    from scripts import run_video_production as harness
    monkeypatch.setattr(harness,"WORKER",tmp_path)
    monkeypatch.setattr(harness,"port_free",lambda: None)
    monkeypatch.setattr(harness,"stale_workers",lambda: [])
    monkeypatch.setattr(harness,"query_gpu",lambda: dict(name="mock",used_mib=15000,free_mib=500))
    def forbidden(*args,**kwargs): raise AssertionError("No worker may start during a blocked precheck")
    monkeypatch.setattr(harness.subprocess,"Popen",forbidden)
    result = harness.run(tmp_path/"source.mp4",tmp_path/"session",PROFILE,"video/mp4")
    assert result["status"] == "BLOCKED" and "GPU" in result["error"]
    lock = tmp_path/"data/video-production/active.lock"
    lock.write_text("manual review required")
    result = harness.run(tmp_path/"source.mp4",tmp_path/"session2",PROFILE,"video/mp4")
    assert result["status"] == "BLOCKED" and lock.exists()


@pytest.mark.parametrize("delivery", [None,[128,96]])
def test_synthetic_encode_mux_smoke_with_mock_runtime(monkeypatch,tmp_path,delivery):
    # Real FFmpeg/ffprobe, six synthetic frames; no model or CUDA inference.
    import numpy as np
    from app.video_pipeline import ffmpeg_executable, process_video
    from app.registry import ModelRegistry
    from app.video_registry import VideoModelRegistry
    from scripts.run_video_bakeoff import audio_signature
    import shutil
    ffprobe = shutil.which("ffprobe")
    if not ffprobe: pytest.skip("ffprobe is required for synthetic media verification")
    source,output = tmp_path/"source.mp4",tmp_path/"output.mp4"
    exe = ffmpeg_executable()
    subprocess.run([exe,"-y","-v","error","-f","lavfi","-i","testsrc2=size=64x32:rate=6",
        "-f","lavfi","-i","sine=frequency=440:sample_rate=32000","-t","1","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",str(source)],check=True,timeout=20)
    registry = ModelRegistry.load()
    model = VideoModelRegistry.load(registry).get(PROFILE["model"])
    model.weights_path(tmp_path).write_bytes(b"synthetic mock checkpoint, never loaded")
    class MockCUDA:
        device_type = "cuda"  # contract only; this test does not use a GPU
        def infer(self,frames): return [np.repeat(np.repeat(frames[1],2,axis=0),2,axis=1)]
    monkeypatch.setenv("LOCAL_VIDEO_PRODUCTION","1")
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_FFPROBE_PATH",ffprobe)
    monkeypatch.delenv("LOCAL_VIDEO_BENCHMARK",raising=False)
    result = process_video(source,output,model,tmp_path,registry,None,SimpleNamespace(create=lambda *args: MockCUDA()),
        "cuda",3,1,18,"copy",256,32,100000,lambda *args: None,lambda: False,delivery=delivery)
    assert result["frame_count"] == 6 and result["fps"] == 6
    assert result["audio_preserved"] is True
    assert result["provenance"]["native_resolution"] == [128,64]
    assert result["provenance"]["delivery_resolution"] == (delivery or [128,64])
    assert result["provenance"]["source_sha256"] == file_sha(source)
    assert result["provenance"]["output_sha256"] == file_sha(output)
    assert result["provenance"]["color_handling"]["interpretation"] == "BT.709 SDR assumed"
    assert audio_signature(ffprobe,source) == audio_signature(ffprobe,output)
    assert ffprobe_streams(output)[0]["sample_aspect_ratio"] == "1:1"
