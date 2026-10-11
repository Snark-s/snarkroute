"""Real sidecar client -> SnarkRoute -> local inference; small bounded prompt."""
import json
from pathlib import Path
import sys
from stack_paths import ROOT, home

sys.path.insert(0, str(home('mixar_local')))
import snarkroute_client
output = ROOT/'.tmp/audit-20261011/live-mixar-route'
output.mkdir(parents=True, exist_ok=True)
snarkroute_client.STATE_PATH = output/'model_performance.json'
client = snarkroute_client.SnarkRouteTextClient()
catalog, candidates = client.select('Reply with OK only.', role='planner')
selected = candidates[0]
assert selected['provider'] == 'local_openai', 'Live probe requires an available local model'
result = client.generate('Reply with OK only.', 'OK', max_tokens=16, temperature=0, max_attempts=1)
text = result['text']
assert 'OK' in text
proof = {'test':'A-live-Mixar-client', 'provider':selected['provider'], 'text':text,
         'gateway':client.base_url, 'paidPermission':False, 'costUsd':result['cost_usd'], 'attempted':result['attempted']}
assert result['cost_usd'] == 0 and result['attempted'] == 1
(output/'result.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(proof))
