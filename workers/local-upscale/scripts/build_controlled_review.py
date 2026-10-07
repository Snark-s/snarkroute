"""Build human review for available controlled outputs. Never submits a neural job."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from datetime import date
from dataclasses import asdict
from pathlib import Path

import numpy as np
from PIL import Image,ImageDraw,ImageFont
import run_video_bakeoff as harness
from app.benchmark_resources import OwnedSession,cap_current_process
from app.video_benchmark import AttemptLock,Policy,DECODE_FILTER,ENCODE_FILTER,normalization_command,ffmpeg_base,encode_profile
from app.tiling import tile_positions
from app.video_pipeline import ffmpeg_executable

FRAMES=[0,31,62,92,123]
ROIS={"eyes-lashes-brows":(540,205,240,100),"nose-lips-jaw":(550,295,225,210),
    "hairline":(525,45,280,155),"hair-strands":(740,430,170,245),
    "earring-left":(493,320,80,90),"pendant":(605,690,110,78),
    "blouse-edge":(900,640,195,115),"background-stand":(12,500,110,240)}
FONT=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",18)
SPAN_ROIS={**ROIS,"nose-lips":(550,295,225,125),"jaw-skin-edge":(520,410,265,110)}
del SPAN_ROIS["nose-lips-jaw"]


def span_review_session(root):
    previous=json.loads((root/"span/result.json").read_text(encoding="utf-8"))
    if previous.get("status")!="SUCCEEDED": raise ValueError("SPAN native execution must succeed before comparison")
    for path in (root/"span/native.mp4",root/"normalized/original.mp4",root/"normalized/vimeo.mp4"):
        if not path.is_file(): raise FileNotFoundError(path)
    folder=root/"comparison-span"
    if folder.exists(): raise FileExistsError("SPAN review exists; no automatic retry")
    return folder,"review-span"


def review_session(root, continuation):
    if not continuation:
        return root/"comparison", "review"
    if date.fromisoformat(continuation).isoformat() != continuation:
        raise ValueError("Continuation must be an ISO date")
    previous=json.loads((root/"comparison/verification.json").read_text(encoding="utf-8"))
    if previous.get("status") != "FAILED":
        raise ValueError("Continuation requires a recorded failed review")
    folder=root/f"comparison-{continuation}"
    if folder.exists():
        raise FileExistsError("Continuation already exists; automatic retry disabled")
    return folder, f"review-{continuation}"


def review_policy(env):
    policy=Policy.from_env({"LOCAL_VIDEO_BENCHMARK":"1","LOCAL_VIDEO_BENCHMARK_CANDIDATE":"vimeo",
        "LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT":env.get("LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT","180")})
    if policy.process_cpu_limit>200:
        raise ValueError("Review process CPU guard cannot exceed two CPUs (200%)")
    return policy


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--continuation",help="Explicitly approved continuation date; keeps prior review and attempt")
    parser.add_argument("--span-comparison",action="store_true",help="Approved SPAN-only postprocessing; reuse existing baseline/Vimeo")
    args=parser.parse_args()
    cap_current_process(2)
    root=harness.EVAL/"controlled"; common=root/"normalized"
    if args.span_comparison and args.continuation: parser.error("Choose SPAN comparison or historical continuation")
    folder,attempt_name=span_review_session(root) if args.span_comparison else review_session(root,args.continuation)
    rois=SPAN_ROIS if args.span_comparison else ROIS
    synthetic=json.loads((root/"synthetic/verification.json").read_text())
    assert synthetic["status"]=="SUCCEEDED" and synthetic["encode_filter"]==ENCODE_FILTER
    source=Path(harness.plan("vimeo",Policy(enabled=True,candidate="vimeo"))["source"])
    assert harness.file_sha(source)==harness.SOURCE_SHA
    prior_vimeo=json.loads((root/"vimeo/native-verification.json").read_text(encoding="utf-8"))
    assert harness.file_sha(root/"vimeo/native.mp4")==prior_vimeo["nativeSha256"]
    ffmpeg=ffmpeg_executable(); ffprobe=shutil.which("ffprobe")
    native={"original":source,"vimeo":root/"vimeo/native.mp4"}
    labels={"original":"Original normalized","vimeo":"VimeoScale Unet 2x","span":"PurePhoto SPAN 4x","gameup":"GameUp TSCUNet 2x"}
    for name in (("span",) if args.span_comparison else ("span","gameup")):
        if (root/name/"native.mp4").exists():
            candidate=json.loads((root/name/"result.json").read_text())
            if candidate["status"]=="SUCCEEDED": native[name]=root/name/"native.mp4"
    if args.span_comparison: labels={name:labels[name] for name in ("original","vimeo","span")}
    policy=review_policy(os.environ)
    owned=OwnedSession(2); sampler=harness.Sampler(owned,policy)
    result=dict(status="FAILED",neural_runs_this_phase=0,available=list(native),winner=None,
        assumption="SDR BT.709 limited source; test assumption, not recovered source fact")
    result["continuation"]=args.continuation
    result["policy"]=asdict(policy)
    result["previous_verification"]=str(root/"comparison/verification.json") if args.continuation else None
    result["precheck_gpu"]=harness.query_gpu()
    sampler.policy.check_gpu(result["precheck_gpu"])
    harness.port_free()
    result["source_sha256"]=harness.file_sha(source)
    result["native_vimeo_sha256"]=harness.file_sha(native["vimeo"])
    if args.span_comparison:
        result["native_span_sha256"]=harness.file_sha(native["span"])
        prior_review=json.loads((root/"comparison-2026-10-04/verification.json").read_text(encoding="utf-8"))
        for name in ("original","vimeo"):
            assert harness.file_sha(common/f"{name}.mp4")==prior_review["normalization"][name]["sha256"]
    started_run=time.perf_counter()
    def run(command,timeout=300):
        sampler.check()
        current=owned.sample()
        if current["available_ram_bytes"] < sampler.policy.min_available_ram_mib*1024**2:
            raise RuntimeError("Available RAM below safety threshold")
        proc=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            owned.add(proc.pid); owned.snapshot()
            started=time.perf_counter()
            while True:
                sampler.check()
                remaining=timeout-(time.perf_counter()-started)
                if remaining<=0: raise TimeoutError("Owned review subprocess timed out")
                try:
                    output,error=proc.communicate(timeout=min(.25,remaining))
                    break
                except subprocess.TimeoutExpired: continue
            sampler.check()
            if proc.returncode: raise RuntimeError(error.decode(errors="replace")[-4000:])
            return output
        finally:
            if proc.poll() is None: proc.kill(); proc.wait(timeout=5)
    def extract(path,filters,width,height):
        raw=run(ffmpeg_base(ffmpeg,2)+["-threads:v","2","-i",str(path),"-map","0:v:0","-vf",filters,
            "-vsync","0","-threads:v","2","-pix_fmt","rgb24","-f","rawvideo","pipe:1"])
        assert len(raw)%(width*height*3)==0
        return np.frombuffer(raw,dtype=np.uint8).reshape(-1,height,width,3)
    with AttemptLock(root,attempt_name) as attempt:
        folder.mkdir(exist_ok=True);common.mkdir(exist_ok=True)
        try:
            sampler.thread.start()
            result["normalization"]={}
            source_audio=harness.audio_signature(ffprobe,source,owned)
            for name,path in native.items():
                output=common/f"{name}.mp4"
                started=time.perf_counter()
                command=normalization_command(ffmpeg,path,source,output,2)
                reuse=bool((args.continuation and name=="original" or args.span_comparison and name in {"original","vimeo"}) and output.exists())
                if not reuse:
                    if (args.continuation or args.span_comparison) and output.exists():
                        raise FileExistsError(f"Existing output preserved: {output}")
                    run(command)
                metadata=harness.verify_output(ffprobe,output,2560,1440,owned)
                audio=harness.audio_signature(ffprobe,output,owned)
                assert audio==source_audio
                result["normalization"][name]=dict(path=str(output),metadata=metadata,audio=audio,
                    seconds=time.perf_counter()-started,command=command,sha256=harness.file_sha(output),reused=reuse)
                if name!="original" and not reuse: shutil.copyfile(output,root/name/"normalized.mp4")
                if name=="span": harness.write_json(common/"span-verification.json",dict(status="SUCCEEDED",**result["normalization"][name],source_audio_identity=True,color_assumption=result["assumption"]))
            # Four rows, five columns, including explicit missing-candidate placeholders.
            sheet=Image.new("RGB",(420*5,285*len(labels)),(24,27,32)); draw=ImageDraw.Draw(sheet)
            normalized_frames={}
            for row,name in enumerate(labels):
                draw.text((10,row*285+8),labels[name]+" | NORMALIZED",font=FONT,fill="white")
                if name in native:
                    frames=extract(common/f"{name}.mp4",DECODE_FILTER+",select='"+"+".join(f"eq(n,{i})" for i in FRAMES)+"',scale=400:225",400,225)
                    assert len(frames)==5
                    normalized_frames[name]=frames
                    for col,(number,frame) in enumerate(zip(FRAMES,frames)):
                        sheet.paste(Image.fromarray(frame),(col*420+10,row*285+32))
                        draw.text((col*420+10,row*285+258),f"frame {number}",font=FONT,fill="white")
                else:
                    draw.text((15,row*285+100),"NOT RUN: previous precheck BLOCKED; no neural output",font=FONT,fill="#ffba77")
            sheet.save(folder/"contact-sheet-normalized.jpg",quality=95)
            select="select='"+"+".join(f"eq(n,{i})" for i in FRAMES)+"'"
            native_frames={}
            for name,path in native.items():
                scale=1 if name=="original" else (4 if name=="span" else 2)
                native_frames[name]=(scale,extract(path,DECODE_FILTER+","+select,1344*scale,768*scale))
            cropdir=folder/"native-crops"; cropdir.mkdir(exist_ok=True)
            crop_index={}
            for region,(x,y,w,h) in rois.items():
                sampler.check()
                maxscale=max(value[0] for value in native_frames.values())
                cellw=w*maxscale+20; cellh=h*maxscale+60
                crop_sheet=Image.new("RGB",(cellw*5,cellh*len(native)),(24,27,32)); d=ImageDraw.Draw(crop_sheet)
                crop_index[region]=dict(source_roi=[x,y,w,h],fixed_coordinates=True,native_pixel_display="1:1; no resampling",files=[])
                for row,(name,(scale,frames)) in enumerate(native_frames.items()):
                    for col,(number,frame) in enumerate(zip(FRAMES,frames)):
                        crop=Image.fromarray(frame).crop((x*scale,y*scale,(x+w)*scale,(y+h)*scale))
                        filename=f"{region}-{name}-frame-{number}.png"; crop.save(cropdir/filename)
                        crop_index[region]["files"].append(filename)
                        crop_sheet.paste(crop,(col*cellw+10,row*cellh+50))
                        d.text((col*cellw+8,row*cellh+5),f"{name} NATIVE {scale}x f{number}",font=FONT,fill="white")
                        d.text((col*cellw+8,row*cellh+27),f"{crop.width}x{crop.height} px, 1:1",font=FONT,fill="white")
                crop_sheet.save(cropdir/f"{region}-sheet.png")
            harness.write_json(cropdir/"index.json",crop_index)
            if args.span_comparison:
                seamdir=folder/"tile-seams";seamdir.mkdir()
                xs=tile_positions(1344,256,32);ys=tile_positions(768,256,32)
                bands={axis:[[positions[i],positions[i-1]+256] for i in range(1,len(positions))] for axis,positions in (("x",xs),("y",ys))}
                harness.write_json(seamdir/"geometry.json",dict(tile_size=256,tile_overlap=32,tile_starts_x=xs,tile_starts_y=ys,source_overlap_bands=bands,scale=4,
                    meaning="Actual blend bands; overlays mark inspection locations, not detected seams. Final edge overlaps can exceed 32 pixels."))
                for number,frame in zip(FRAMES,native_frames["span"][1]):
                    sampler.check()
                    image=Image.fromarray(frame);overlay=image.resize((1344,768),Image.Resampling.LANCZOS);d=ImageDraw.Draw(overlay)
                    for axis,intervals in bands.items():
                        for start,end in intervals:
                            center=(start+end)//2
                            box=(center-32,160,center+32,520) if axis=="x" else (450,center-32,950,center+32)
                            image.crop(tuple(value*4 for value in box)).save(seamdir/f"{axis}-blend-{start}-{end}-span-native4x-frame-{number}.png")
                            rect=(start,0,end,767) if axis=="x" else (0,start,1343,end)
                            d.rectangle(rect,outline="#ff5050",width=2)
                    overlay.save(seamdir/f"overlay-navigation-resized-frame-{number}.jpg",quality=94)
            # Low-resolution consecutive-frame differences: diagnostics, no quality ranking.
            temporal={"method":"Mean absolute RGB difference of adjacent 336x192 frames; includes motion, codec and model changes; no motion compensation; not a quality score","series":{}}
            for name in native:
                frames=extract(common/f"{name}.mp4",DECODE_FILTER+",scale=336:189,pad=336:192:0:1",336,192)
                assert len(frames)==124
                values=np.abs(np.diff(frames.astype(np.float32),axis=0)).mean(axis=(1,2,3)).tolist()
                temporal["series"][name]=dict(adjacent_frame_mad=values)
                if name not in {"vimeo","gameup"}: continue
                job=json.loads((root/name/"result.json").read_text())["worker_job"]
                boundaries=job["output"]["benchmark"]["chunk_boundaries"]
                harness.write_json(folder/f"{name}-chunk-boundaries.json",boundaries)
                boundary_dir=folder/f"{name}-boundaries";boundary_dir.mkdir(exist_ok=True)
                temporal["series"][name]["boundary_pairs"]=[b["output_first"] for b in boundaries[1:]]
                if args.span_comparison and name=="vimeo":
                    for strip in (root/"comparison-2026-10-04/vimeo-boundaries").glob("*.jpg"): shutil.copyfile(strip,boundary_dir/strip.name)
                    continue
                # Every chunk transition and the two clip context edges, at native-pipeline normalized display.
                for boundary in [0,*[b["output_first"] for b in boundaries[1:]],123]:
                    numbers=list(range(max(0,boundary-2),min(124,boundary+3)))
                    small=extract(common/f"{name}.mp4",DECODE_FILTER+",select='"+"+".join(f"eq(n,{i})" for i in numbers)+"',scale=448:252",448,252)
                    strip=Image.new("RGB",(448*len(numbers),290),(24,27,32));d=ImageDraw.Draw(strip)
                    for i,(number,frame) in enumerate(zip(numbers,small)):
                        strip.paste(Image.fromarray(frame),(448*i,35));d.text((448*i+8,6),f"{name} normalized f{number} | edge {boundary}",font=FONT,fill="white")
                    strip.save(boundary_dir/f"boundary-{boundary:03d}.jpg",quality=94)
            harness.write_json(folder/"temporal-diagnostics.json",temporal)
            if args.span_comparison:
                command=ffmpeg_base(ffmpeg,2)
                for name in labels: command += ["-threads:v","2","-i",str(common/f"{name}.mp4")]
                command += ["-threads","2","-i",str(source)]
                chains=";".join(f"[{i}:v]{DECODE_FILTER},scale=1280:720:flags=lanczos:in_range=full:out_range=full,format=rgb24,setsar=1[p{i}]" for i in range(3))
                chains+=";[p0][p1][p2]hstack=inputs=3,"+ENCODE_FILTER+"[v]"
                command += ["-filter_complex",chains,"-map","[v]","-map","3:a:0","-c:a","copy"]+encode_profile(2)+[str(folder/"full-speed-comparison.mp4")]
                started=time.perf_counter();run(command)
                result["full_speed"]=dict(command=command,seconds=time.perf_counter()-started,panel_order=list(labels),panel_size=[1280,720],
                    metadata=harness.verify_output(ffprobe,folder/"full-speed-comparison.mp4",3840,720,owned),audio=harness.audio_signature(ffprobe,folder/"full-speed-comparison.mp4",owned))
                assert result["full_speed"]["audio"]==source_audio
            sampler.check()
            result["status"]="SUCCEEDED"
        except Exception as exc: result["error"]=str(exc)
        finally:
            sampler.close();harness.write_json(folder/"resource-samples.json",sampler.samples)
            if owned.accounting().ActiveProcesses:
                owned.terminate();time.sleep(.2)
            result["final_cleanup_snapshot"]=owned.snapshot()
            if result["final_cleanup_snapshot"]["active_processes"]:
                result["status"]="FAILED";attempt.claimed=False
            owned.close()
            result["total_wall_seconds"]=time.perf_counter()-started_run
            harness.write_json(folder/"verification.json",result)
    if result["status"]=="SUCCEEDED":
        videos="".join(f'<section><h2>{labels[name]}</h2><video id="{name}" controls preload="metadata" src="../normalized/{name}.mp4"></video></section>' if name in native else f'<section><h2>{labels[name]}</h2><p class="blocked">Not run: previous GPU precheck was BLOCKED. No neural output.</p></section>' for name in labels)
        boundary_links="".join(f'<a href="vimeo-boundaries/boundary-{i:03d}.jpg">{i}</a> ' for i in [0,*temporal["series"]["vimeo"]["boundary_pairs"],123])
        html='''<!doctype html><html lang="en"><meta charset="utf-8"><title>Controlled video upscale review</title><style>body{background:#151920;color:#eee;font:17px system-ui;max-width:1500px;margin:auto;padding:28px}h1{margin-bottom:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}video{width:100%}section{background:#232a34;padding:16px;border-radius:12px}button,select,input{font:inherit;margin:8px;padding:8px}.blocked{color:#ffba77}img{max-width:100%}a{color:#9dd5ff}p{line-height:1.6}</style><h1>Local video upscale · human review</h1><p><b>Normal speed first.</b> Compare identity before sharpness. There is no ground truth and no automatic winner. Only Original and Vimeo are available. SDR BT.709 limited is a test assumption.</p><button onclick="playAll()">Play synchronized</button><button onclick="vs.forEach(v=>v.pause())">Pause all</button><button onclick="vs.forEach(v=>v.currentTime=0)">Restart</button><label>Speed <select onchange="vs.forEach(v=>v.playbackRate=Number(this.value))"><option value="1">1x · normal first</option><option value="0.5">0.5x</option><option value="0.25">0.25x</option></select></label><label>Frame <input type="range" min="0" max="123" value="0" oninput="vs.forEach(v=>{v.pause();v.currentTime=this.value/24});document.getElementById('frame').textContent=this.value"><output id="frame">0</output></label><label><input type="checkbox" onchange="vs[0].muted=!this.checked" checked> Original audio (other videos muted)</label><div class="grid">'''+videos+'''</div><p>All available comparison videos: 2560×1440, content 2520×1440 + 20 px left/right, SAR 1, 24 fps. AAC copied from the same original. Vimeo native output remains unchanged; only normalized encode has complete BT.709 tags.</p><h2>Normalized contact sheet</h2><a href="contact-sheet-normalized.jpg"><img src="contact-sheet-normalized.jpg"></a><h2>Native pixel crops · 1:1</h2><p>Fixed source coordinates are scaled to each native output. Crops are not resized. The right earring is obscured; only the visible left earring is reviewed.</p>'''+"".join(f'<p><a href="native-crops/{r}-sheet.png">{r}</a></p>' for r in ROIS)+'''<h2>Vimeo chunk/context edges</h2><p>Strip links cover every chunk transition ±2 frames and clip edges. SPAN has no temporal-model chunk meaning; GameUp was blocked.</p>'''+boundary_links+'''<h2>Review checklist</h2><p>Identity: eyes, brows, nose, lips, jaw, hairline, visible ear/earring, pendant. Temporal: flicker, crawling, shimmer, edge wobble, texture boiling, eye mutation, hair/jewelry/background instability. Detail: useful edges versus halos, ringing, invented lashes/pores/hair, plastic skin, sharpening and smearing. A sharper face that changes the person is a negative.</p><p>Licenses: Vimeo and SPAN CC-BY-SA-4.0; GameUp CC-BY-NC-SA-4.0 (noncommercial restriction).</p><script>const vs=[...document.querySelectorAll('video')];vs.slice(1).forEach(v=>v.muted=true);async function playAll(){const t=vs[0].currentTime;vs.forEach(v=>v.currentTime=t);await Promise.all(vs.map(v=>v.play()));}setInterval(()=>{if(!vs[0].paused)vs.slice(1).forEach(v=>{if(Math.abs(v.currentTime-vs[0].currentTime)>.08)v.currentTime=vs[0].currentTime;});},250);</script></html>'''
        if args.span_comparison:
            html=html.replace("Only Original and Vimeo are available.","Original, Vimeo and SPAN are available. SPAN is framewise; check temporal stability before judging detail.")
            html=html.replace("native-crops/nose-lips-jaw-sheet.png\">nose-lips-jaw", "native-crops/nose-lips-sheet.png\">nose-lips")
            html=html.replace("<h2>Vimeo chunk/context edges</h2>",'<p><a href="native-crops/jaw-skin-edge-sheet.png">jaw-skin-edge</a></p><h2>Vimeo chunk/context edges</h2>')
            triple='<h2>Normal-speed triple comparison</h2><p>Left Original; middle Vimeo; right SPAN. Panels 1280x720; use full-size players and native crops for detail.</p><video controls preload="metadata" src="full-speed-comparison.mp4"></video>'
            seam='<h2>SPAN tile blend bands</h2><p>Red outlines mark actual input overlap bands, not detected artifacts. Navigation overlays are resized; seam PNG crops are native 4x at 1:1.</p><a href="tile-seams/geometry.json">Tile geometry</a>'
            seam+=''.join(f'<p>Frame {n}: <a href="tile-seams/overlay-navigation-resized-frame-{n}.jpg">overlay</a></p>' for n in FRAMES)
            seam+=''.join(f'<p><a href="tile-seams/{p.name}">{p.name}</a></p>' for p in sorted((folder/"tile-seams").glob('*.png')))
            html=html.replace('<h2>Normalized contact sheet</h2>',triple+'<h2>Normalized contact sheet</h2>')
            html=html.replace('<h2>Review checklist</h2>',seam+'<h2>Review checklist</h2>')
        (folder/"index.html").write_text(html,encoding="utf-8")
    print({k:result.get(k) for k in ("status","error","available")})
    return 0 if result["status"]=="SUCCEEDED" else 1


if __name__=="__main__":raise SystemExit(main())
