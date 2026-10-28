#!/usr/bin/env bash
set -euo pipefail
/home/serge/h3/runtime/snarkroute-h3/.venv/bin/python - <<'PY'
from pathlib import Path
from urllib.request import Request,urlopen
import json
token=Path('/home/serge/h3/runtime/worker-token').read_text().strip()
req=Request('http://127.0.0.1:18080/v1/jobs/d1ccf575-7216-427e-99dc-c66cfa073068/cancel',data=b'{}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
with urlopen(req,timeout=30) as r:
 d=json.load(r)
print(json.dumps({'id':d.get('id'),'status':d.get('status'),'stage':d.get('stage'),'error':d.get('error')}))
PY
exit 0
