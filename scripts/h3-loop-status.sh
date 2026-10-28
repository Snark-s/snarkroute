#!/usr/bin/env bash
set -euo pipefail
/home/serge/h3/runtime/snarkroute-h3/.venv/bin/python - <<'PY'
from pathlib import Path
from urllib.request import Request,urlopen
import json
t=Path('/home/serge/h3/runtime/worker-token').read_text().strip()
url='http://127.0.0.1:18080/v1/jobs/b62ce7b4-a1fa-49c9-aeda-7f442239219d'
with urlopen(Request(url,headers={'Authorization':'Bearer '+t}),timeout=15) as x:
 j=json.load(x)
print(json.dumps({'id':j.get('id'),'status':j.get('status'),'stage':j.get('stage'),'progress':j.get('progress'),'error':j.get('error'),'outputs':j.get('outputs')},default=str))
PY
exit 0
