"""Production video profile and pure geometry/encoding helpers; no model imports."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

from app.errors import WorkerError
from app.video_benchmark import DECODE_FILTER, ENCODE_FILTER, ffmpeg_base

PROFILE = dict(model="openmodeldb/vimeoscale-unet-x2", scale=2, context=3,
    chunk_size=3, overlap_frames=1, device="cuda", audio_handling="copy",
    output_codec="libx264", output_container="mp4", preset="medium", crf=18, gop=48)


def model_labels(model_id):
    vimeo = model_id == PROFILE["model"]
    span = model_id == "framewise/4x-purephoto-span"
    return dict(group="Production" if vimeo else "Experimental", production_default=vimeo,
        verification="Verified · H3 Max / CUDA / 2× tested" if vimeo else "Tested · manual" if span else "Unverified",
        description="Temporal 2× upscale optimized for preserving motion and appearance. Best for clean generated/video sources where conservative enlargement is preferred over aggressive detail invention." if vimeo else "Experimental / Manual")


def delivery_geometry(width, height, target):
    if target is None:
        return dict(width=width,height=height,content_width=width,content_height=height,pad_left=0,pad_top=0)
    if not isinstance(target,list) or len(target) != 2 or any(type(n) is not int or n < 2 or n > 8192 or n % 2 for n in target):
        raise WorkerError("invalid_parameters","Delivery canvas must contain two even dimensions between 2 and 8192.")
    factor = min(target[0]/width,target[1]/height)
    cw,ch = max(2,int(width*factor)//2*2),max(2,int(height*factor)//2*2)
    return dict(width=target[0],height=target[1],content_width=cw,content_height=ch,
        pad_left=(target[0]-cw)//2,pad_top=(target[1]-ch)//2)


def production_encoder_command(exe,path,source,width,height,fps,has_audio,audio,delivery,crf,preset,gop):
    geometry = delivery_geometry(width,height,delivery)
    command = ffmpeg_base(exe,2) + ["-threads:v","2","-f","rawvideo","-pix_fmt","rgb24",
        "-s",f"{width}x{height}","-r",f"{fps:.8f}","-i","pipe:0","-threads","2","-i",str(source),"-map","0:v:0"]
    if has_audio and audio != "drop":
        command += ["-map","1:a?","-c:a","copy" if audio == "copy" else "aac"]
    filters = ""
    if delivery:
        filters = (f"scale={geometry['content_width']}:{geometry['content_height']}:flags=lanczos:in_range=full:out_range=full,"
            f"pad={geometry['width']}:{geometry['height']}:{geometry['pad_left']}:{geometry['pad_top']}:color=black,")
    return command + ["-vf",filters+ENCODE_FILTER,"-c:v","libx264","-preset",preset,"-crf",str(crf),
        "-threads:v","2","-pix_fmt","yuv420p","-g",str(gop),"-keyint_min",str(gop),"-sc_threshold","0",
        "-color_range","tv","-colorspace","bt709","-color_trc","bt709","-color_primaries","bt709",str(path)]


def ffprobe_streams(path):
    exe = os.getenv("LOCAL_VIDEO_UPSCALE_FFPROBE_PATH") or os.getenv("LOCAL_VIDEO_BENCHMARK_FFPROBE") or shutil.which("ffprobe")
    if not exe:
        raise WorkerError("runtime_failed","ffprobe is required to verify color and output metadata. Configure LOCAL_VIDEO_UPSCALE_FFPROBE_PATH.")
    result = subprocess.run([exe,"-v","error","-threads","2","-show_streams","-of","json",str(path)],
        capture_output=True,text=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise WorkerError("decode_failed","ffprobe metadata verification failed.",details={"diagnostics":result.stderr[-2000:]})
    return json.loads(result.stdout)["streams"]


def source_color(stream):
    # The reviewed SDR path must not silently reinterpret HDR or a different matrix.
    metadata = {k:stream.get(k) for k in ("color_primaries","color_transfer","color_space","color_range")}
    for key in ("color_primaries","color_transfer","color_space"):
        if metadata[key] not in {None,"unknown","unspecified","bt709"}:
            raise WorkerError("unsupported_color",f"The current SDR BT.709 profile does not support source {key}={metadata[key]}.")
    if stream.get("sample_aspect_ratio") not in {None,"N/A","1:1"}:
        raise WorkerError("invalid_input","The current video profile requires square source pixels (SAR=1).")
    assumed = any(metadata[k] in {None,"unknown","unspecified"} for k in ("color_primaries","color_transfer","color_space"))
    full = metadata["color_range"] == "pc"
    return dict(source_metadata=metadata,interpretation="BT.709 SDR assumed" if assumed else "BT.709 SDR tagged",
        range_interpretation="full tagged" if full else "limited tagged" if metadata["color_range"] == "tv" else "limited assumed",
        decode_filter=DECODE_FILTER.replace("in_range=tv","in_range=full") if full else DECODE_FILTER,
        output_metadata=dict(color_primaries="bt709",color_transfer="bt709",color_space="bt709",color_range="tv"))


def source_fps(stream):
    try:
        average = float(Fraction(stream.get("avg_frame_rate","0/1")))
        nominal = float(Fraction(stream.get("r_frame_rate",stream.get("avg_frame_rate","0/1"))))
    except (ValueError,ZeroDivisionError):
        raise WorkerError("invalid_input","Source frame rate is unavailable.")
    if not 0 < average <= 240:
        raise WorkerError("invalid_input","Source frame rate must be between 0 and 240 fps.")
    if abs(average-nominal) > .0001:
        raise WorkerError("unsupported_timing","This conservative profile requires CFR video; source average and nominal frame rates differ.")
    return average


def verify_output_metadata(stream,width,height,frames=None,fps=None):
    expected = dict(width=width,height=height,color_primaries="bt709",color_transfer="bt709",color_space="bt709",
        color_range="tv",sample_aspect_ratio="1:1",codec_name="h264",pix_fmt="yuv420p")
    for key,value in expected.items():
        if stream.get(key) != value:
            raise WorkerError("output_verification_failed",f"Output {key}={stream.get(key)!r}; expected {value!r}.")
    if frames is not None:
        if stream.get("nb_frames") != str(frames):
            raise WorkerError("output_verification_failed","Output frame count does not match the decoded source.")
        expected["nb_frames"] = str(frames)
    if fps is not None:
        try: actual = float(Fraction(stream.get("avg_frame_rate","0/1")))
        except (ValueError,ZeroDivisionError): actual = 0
        if abs(actual-fps) > .0001:
            raise WorkerError("output_verification_failed","Output FPS differs from the source.")
        expected["avg_frame_rate"] = stream["avg_frame_rate"]
    return expected


def file_sha(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle,"sha256").hexdigest()
