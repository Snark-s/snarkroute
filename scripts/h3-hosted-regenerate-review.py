"""Offline review assets/measurements for the single completed hosted experiment."""
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps/server/data/h3-hosted-regenerate-eval/2026-09-30"
SOURCE = ROOT / "apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4"
TARGET = OUT / "output.mp4"
WIDTH, HEIGHT = 448, 256
font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 18)
small_font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 13)


def ffmpeg_bytes(path, args):
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", "2", "-i", str(path),
         "-threads", "2", *args, "-"], check=True, capture_output=True, timeout=60
    ).stdout


def frames(path):
    raw = ffmpeg_bytes(path, ["-an", "-vf", f"scale={WIDTH}:{HEIGHT}:flags=lanczos",
                              "-pix_fmt", "rgb24", "-f", "rawvideo"])
    return np.frombuffer(raw, np.uint8).reshape(-1, HEIGHT, WIDTH, 3)


def audio(path):
    raw = ffmpeg_bytes(path, ["-vn", "-ac", "2", "-ar", "32000", "-f", "f32le"])
    return np.frombuffer(raw, np.float32).reshape(-1, 2)


def packet_audio_hash(path):
    return ffmpeg_bytes(path, ["-map", "0:a:0", "-c:a", "copy", "-f", "hash", "-hash", "sha256"]).decode().strip().split("=")[-1]


source_frames, target_frames = frames(SOURCE), frames(TARGET)
if len(source_frames) != 124 or len(target_frames) != 124:
    raise ValueError("Unexpected frame count; review must not silently align different timelines")
indices = [0, 31, 62, 92, 123]
sheet = Image.new("RGB", (5 * WIDTH + 160, 2 * HEIGHT + 76), "#101820")
draw = ImageDraw.Draw(sheet)
draw.text((12, 82), "Original Max", font=font, fill="white")
draw.text((12, HEIGHT + 124), "Regenerated 2K", font=font, fill="white")
for column, frame in enumerate(indices):
    x = 160 + column * WIDTH
    draw.text((x + 8, 10), f"{[0,25,50,75,100][column]}% / frame {frame} / {frame/24:.3f}s", font=font, fill="white")
    sheet.paste(Image.fromarray(source_frames[frame]), (x, 40))
    sheet.paste(Image.fromarray(target_frames[frame]), (x, HEIGHT + 64))
sheet.save(OUT / "contact-sheet.jpg", quality=94)
Image.fromarray(target_frames[31]).save(OUT / "thumbnail.jpg", quality=94)
strip = Image.new("RGB", (5 * WIDTH, HEIGHT + 30), "#101820")
strip_draw = ImageDraw.Draw(strip)
for column, frame in enumerate(indices):
    strip.paste(Image.fromarray(target_frames[frame]), (column * WIDTH, 30))
    strip_draw.text((column * WIDTH + 8, 7), f"frame {frame}", font=small_font, fill="white")
strip.save(OUT / "review-strip.jpg", quality=94)

# Every frame is included in order. These are auxiliary atlases, not evidence that
# continuous playback or listening occurred; that is recorded separately.
atlases = []
for start in range(0, 124, 16):
    atlas = Image.new("RGB", (4 * WIDTH, 4 * (2 * HEIGHT + 40)), "#101820")
    atlas_draw = ImageDraw.Draw(atlas)
    for offset, frame in enumerate(range(start, min(start + 16, 124))):
        x = (offset % 4) * WIDTH
        y = (offset // 4) * (2 * HEIGHT + 40)
        atlas_draw.text((x + 5, y + 5), f"frame {frame:03d} / {frame/24:.3f}s; original / 2K", font=small_font, fill="white")
        atlas.paste(Image.fromarray(source_frames[frame]), (x, y + 24))
        atlas.paste(Image.fromarray(target_frames[frame]), (x, y + 24 + HEIGHT))
    name = f"temporal-review-{start//16+1:02d}.jpg"
    atlas.save(OUT / name, quality=94)
    atlases.append(name)

# Central portrait ROI, same normalized field of view, retained at native pixel
# scale. This makes the source/output crop-size difference explicit.
crops = []
for label, path in [("original", SOURCE), ("regenerated", TARGET)]:
    raw = ffmpeg_bytes(path, ["-an", "-vf", "select=eq(n\\,62),crop=iw*0.40:ih*0.65:iw*0.30:ih*0.12", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png"])
    name = f"face-crop-{label}-frame62.png"
    (OUT / name).write_bytes(raw)
    crops.append(name)

src_audio, dst_audio = audio(SOURCE), audio(TARGET)
samples = min(len(src_audio), len(dst_audio))
a, b = src_audio[:samples].astype(np.float64), dst_audio[:samples].astype(np.float64)
correlations = [float(np.corrcoef(a[:, channel], b[:, channel])[0, 1]) for channel in range(2)]
noise = b - a
snr_db = float(10 * np.log10(np.mean(a * a) / max(np.mean(noise * noise), 1e-20)))
packet_hashes = {"original": packet_audio_hash(SOURCE), "regenerated": packet_audio_hash(TARGET)}
window = 640  # 20 ms waveform RMS windows
window_count = samples // window
src_rms = np.sqrt(np.mean(a[:window_count*window].reshape(window_count, window, 2) ** 2, axis=(1, 2)))
dst_rms = np.sqrt(np.mean(b[:window_count*window].reshape(window_count, window, 2) ** 2, axis=(1, 2)))
envelope_correlation = float(np.corrcoef(src_rms, dst_rms)[0, 1])
def envelope_peaks(values):
    return [round((i + 0.5) * 0.020, 3) for i in range(1, len(values) - 1)
            if values[i] > float(values.max()) * 0.20 and values[i] > values[i-1] and values[i] >= values[i+1]]

waveform = Image.new("RGB", (1400, 420), "#101820")
wave_draw = ImageDraw.Draw(waveform)
maximum_rms = max(float(src_rms.max()), float(dst_rms.max()), 1e-9)
for index, (label, values, color) in enumerate([("Original Max", src_rms, "#68c7ff"), ("Regenerated 2K", dst_rms, "#ffd078")]):
    top = 45 + index * 185
    wave_draw.text((20, top - 32), f"{label}: 20 ms RMS audio envelope", font=font, fill=color)
    points = [(20 + i*1350/max(len(values)-1, 1), top + 130 - float(v)/maximum_rms*125) for i, v in enumerate(values)]
    wave_draw.line(points, fill=color, width=2)
waveform.save(OUT / "audio-waveform.jpg", quality=94)

gray_source = source_frames.astype(np.float32).mean(axis=3)
gray_target = target_frames.astype(np.float32).mean(axis=3)
motion_source = np.mean(np.abs(np.diff(gray_source, axis=0)), axis=(1,2))
motion_target = np.mean(np.abs(np.diff(gray_target, axis=0)), axis=(1,2))
comparison = np.mean(np.abs(source_frames.astype(np.float32) - target_frames.astype(np.float32)), axis=(1,2,3))
measurements = {
    "method": "All 124 frame pairs decoded at 448x256 with 2 ffmpeg threads; normalized geometry for comparison, no model inference",
    "frameCounts": {"original": len(source_frames), "regenerated": len(target_frames)},
    "sampleFrames": indices,
    "audio": {
        "decodedSamplesPerChannel": {"original": len(src_audio), "regenerated": len(dst_audio)},
        "comparisonSampleRate": 32000,
        "encodedPacketSha256": packet_hashes,
        "encodedPacketIdentical": packet_hashes["original"] == packet_hashes["regenerated"],
        "decodedBitIdenticalOverCommonLength": bool(np.array_equal(src_audio[:samples], dst_audio[:samples])),
        "channelCorrelation": correlations,
        "rmsEnvelopeCorrelation20ms": envelope_correlation,
        "dominantTransientWindowCentersSeconds": {"original": envelope_peaks(src_rms), "regenerated": envelope_peaks(dst_rms)},
        "differenceSnrDb": snr_db,
        "durationDifferenceFromStreamsSeconds": -0.017,
        "interpretation": "Measurements alone do not prove room-tone/cue/sync preservation or regeneration; listening/visual sync review still required"
    },
    "visualSupportingMetrics": {
        "normalizedMeanAbsolutePixelDifference": float(comparison.mean()),
        "framePairDifferences": comparison.tolist(),
        "successiveFrameDifferencesOriginal": motion_source.tolist(),
        "successiveFrameDifferencesRegenerated": motion_target.tolist(),
        "successiveFrameDifferenceCorrelation": float(np.corrcoef(motion_source, motion_target)[0,1]),
        "notPerceptualQualityScore": True
    },
    "artifacts": {"contactSheet": "contact-sheet.jpg", "reviewStrip": "review-strip.jpg", "temporalAtlases": atlases, "nativePixelCrops": crops, "audioWaveform": "audio-waveform.jpg"}
}
(OUT / "review-measurements.json").write_text(json.dumps(measurements, indent=2), encoding="utf-8")

source_url = "../../h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4"
target_url = "output.mp4"
html = """<!doctype html><html lang="en"><meta charset="utf-8"><title>MAX-I1 / Hosted H3 Regenerate 2K</title>
<style>body{background:#101820;color:#edf2f6;font:16px system-ui;margin:24px}h1{font-size:24px}.videos{display:grid;grid-template-columns:1fr 1fr;gap:20px}video{width:100%;background:#000}button{padding:10px 18px;margin:12px 10px 12px 0}img{max-width:100%;height:auto}section{margin:24px 0}a{color:#79caff}.native img{max-width:none}.native{overflow:auto;border:1px solid #456;padding:12px}</style>
<h1>MAX-I1 → Hosted MiniMax H3 Regeneration</h1><p>One paid submission. Original 1344×768 / regenerated 2560×1440. Both 124 frames at 24 fps.</p>
<p>Use synchronized playback for the entire clip. Listen to each audio separately. Contact stills do not establish temporal quality.</p>
<button id="play">Play both from start</button><button id="pause">Pause both</button><button id="originalAudio">Original audio</button><button id="newAudio">Regenerated audio</button>
<div class="videos"><div><h2>Original Max</h2><video id="original" controls preload="metadata" src="__SOURCE__"></video></div><div><h2>Regenerated 2K</h2><video id="target" controls preload="metadata" muted src="__TARGET__"></video></div></div>
<section><h2>0 / 25 / 50 / 75 / 100%</h2><img src="contact-sheet.jpg"></section>
<section><h2>100% native pixel crops, frame 62</h2><p>Same normalized central ROI; different native resolutions. Scroll to inspect at native size.</p><div class="native"><img src="face-crop-original-frame62.png"><img src="face-crop-regenerated-frame62.png"></div></section>
<section><h2>Audio timing</h2><img src="audio-waveform.jpg"></section><p><a href="run.json">Run and provenance</a> · <a href="review-measurements.json">Supporting measurements</a></p>
<script>const a=document.querySelector('#original'),b=document.querySelector('#target');document.querySelector('#play').onclick=async()=>{a.currentTime=0;b.currentTime=0;await Promise.all([a.play(),b.play()])};document.querySelector('#pause').onclick=()=>{a.pause();b.pause()};document.querySelector('#originalAudio').onclick=()=>{a.muted=false;b.muted=true};document.querySelector('#newAudio').onclick=()=>{a.muted=true;b.muted=false};</script></html>"""
# All media are relative local files; the user can open the comparison locally
# without an active API server, upload or external hosting.
html = html.replace("__SOURCE__", source_url).replace("__TARGET__", target_url)
(OUT / "comparison.html").write_text(html, encoding="utf-8")
print(json.dumps({"frameCounts": measurements["frameCounts"], "audio": measurements["audio"], "artifactsCreated": 8 + len(atlases)}, indent=2))
