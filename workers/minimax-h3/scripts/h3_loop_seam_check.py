"""Download successful H3 Loop result and report video/audio seam metrics."""
import json
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import numpy as np

job_id = sys.argv[1] if len(sys.argv) > 1 else "b62ce7b4-a1fa-49c9-aeda-7f442239219d"
auth=Path("/home/serge/h3/runtime/worker-token").read_text().strip()
url=f"http://127.0.0.1:18080/v1/jobs/{job_id}/content"
outfile=Path("/home/serge/h3/outputs/H3-Loop-smoke-20261024.mp4")
req=Request(url,headers={"Authorization":"Bearer "+auth})
try:
    with urlopen(req,timeout=60) as resp:
        outfile.write_bytes(resp.read())
except HTTPError as e:
    print("DOWNLOAD_ERROR",e.code,e.read().decode("utf-8","replace")[:1000],flush=True)
    sys.exit(2)
probe=subprocess.run(["ffprobe","-v","error","-show_entries","stream=codec_type,r_frame_rate,nb_frames,channels,sample_rate,duration","-of","json",str(outfile)],capture_output=True,text=True,check=True)
info=json.loads(probe.stdout)
decoded=subprocess.run(["ffmpeg","-v","error","-i",str(outfile),"-vf","scale=256:144,format=gray","-f","rawvideo","-pix_fmt","gray","-"],capture_output=True,check=True).stdout
frames=np.frombuffer(decoded,dtype=np.uint8).reshape((-1,144,256)).astype(np.float32)
dif=np.mean(abs(np.diff(frames,axis=0)),axis=(1,2))
seam=float(np.mean(abs(frames[-1]-frames[0])))
interior=float(np.median(dif))
ratio=seam/max(interior,1e-6)
audio_raw=subprocess.run(["ffmpeg","-v","error","-i",str(outfile),"-vn","-ac","1","-ar","16000","-f","s16le","-"],capture_output=True,check=True).stdout
audio=np.frombuffer(audio_raw,dtype=np.int16).astype(np.float32)/32768.
n=min(len(audio)//4,1600)
rms=lambda x:float(np.sqrt(np.mean(x*x))) if len(x) else None
analysis={"path":str(outfile),"file_bytes":outfile.stat().st_size,"streams":info.get("streams"),
"frames_decoded":len(frames),"median_adjacent_frame_difference":round(interior,3),
"last_to_first_frame_difference":round(seam,3),"seam_to_typical_motion_ratio":round(ratio,3),
"audio_start_rms_0_1s":rms(audio[:n]),"audio_end_rms_0_1s":rms(audio[-n:]),
"note":"Ratio alone does not prove a perceptually invisible loop; inspect playback."}
report=Path("/home/serge/h3/outputs/H3-Loop-seam-analysis-20261024.json")
report.write_text(json.dumps(analysis,indent=2),encoding="utf-8")
print(json.dumps(analysis),flush=True)
