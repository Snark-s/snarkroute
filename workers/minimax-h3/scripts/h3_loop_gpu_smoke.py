"""Single opt-in local MiniMax H3 seamless-loop GPU test, no public upload."""
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

base = "http://127.0.0.1:18080"
token_path = Path("/home/serge/h3/runtime/worker-token")
token = token_path.read_text(encoding="utf-8").strip()
def call(method, path, payload=None):
    headers={"Authorization": "Bearer "+token}
    data=None if payload is None else json.dumps(payload).encode("utf-8")
    if data: headers["Content-Type"]="application/json"
    req=Request(base+path,data=data,headers=headers,method=method)
    try:
        with urlopen(req,timeout=50) as reply: return json.load(reply)
    except HTTPError as exc:
        print("HTTP_ERROR",exc.code,exc.read().decode("utf-8","replace")[:1400],flush=True)
        raise

print("READY",str(call("GET","/ready"))[:550],flush=True)
payload={
 "operation":"video.generate.h3","task":"t2va",
 "prompt":"A locked-off static camera views a single luminous blue jellyfish breathing gently in dark calm water, steady soft bioluminescence, smooth continuous motion repeating naturally, no abrupt events, subtle ambient underwater hum.",
 "conditions":[],
 "target":{"short_edge":768,"aspect_ratio":"16:9","duration_seconds":4.25},
 "quality_mode":"preview","num_inference_steps":4,
 "model_variant":"10eros_max_turbo","seamless_loop":True,"loop_views":1,"loop_pad_clips":1,
 "seed":1852037,"num_outputs_per_prompt":1
}
try:
 result=call("POST","/v1/jobs",payload)
except Exception as exc:
 print("SUBMIT_FAILED",repr(exc),flush=True)
 sys.exit(3)
job_id=result.get("id")
print("JOB_ID",job_id,flush=True)
if not job_id: print(result);sys.exit(4)
deadline=time.monotonic()+420
prev_status=""
while time.monotonic()<deadline:
 time.sleep(12)
 try: status=call("GET","/v1/jobs/"+job_id)
 except Exception as exc: print("POLL_ERROR",type(exc).__name__,str(exc)[:300],flush=True);continue
 state=status.get("status","?")
 if state!=prev_status or state in ("succeeded","failed","cancelled"):
  print("STATE",state,"STAGE",status.get("stage"),"PROGRESS",status.get("progress"),flush=True)
 prev_status=state
 if state in ("succeeded","failed","cancelled"):
  safe={"id":job_id,"status":state,"outputs":status.get("outputs"),"error":status.get("error"),"metadata":status.get("metadata")}
  out=Path("/home/serge/h3/outputs/h3-loop-smoke-20261024.json")
  out.write_text(json.dumps(safe,indent=2,default=str),encoding="utf-8")
  print("SUMMARY",json.dumps(safe,default=str)[:4500],flush=True)
  print("SUMMARY_FILE",str(out),flush=True)
  sys.exit(0 if state=="succeeded" else 5)
print("POLL_TIMEOUT",job_id,"CANCELLING",flush=True)
try:
 print("CANCEL_RESULT",str(call("POST","/v1/jobs/"+job_id+"/cancel",{}))[:450],flush=True)
except Exception as exc:
 print("CANCEL_ERROR",str(exc)[:300],flush=True)
sys.exit(6)
