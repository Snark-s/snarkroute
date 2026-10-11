"""Live Local First checks against a keyless acceptance server instance."""
import json, sys, time, urllib.request, urllib.error
BASE = sys.argv[1]
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def run(params, node_type="ai.text"):
    payload = {"routeVersion": "1.0", "route": {"id": "acceptance", "title": "acceptance", "author": {}}, "edges": [],
               "nodes": [{"id": "llm", "type": node_type, "params": {"prompt": "Reply with exactly: OK", "max_tokens": 8, **params}}]}
    req = urllib.request.Request(BASE + "/api/routes/run", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    t = time.monotonic()
    try:
        with op.open(req, timeout=300) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}")
    n = (body.get("nodeResults") or {}).get("llm", {})
    out = n.get("output") or {}
    return {"secs": round(time.monotonic() - t, 1), "status": body.get("status"), "provider": out.get("provider") or n.get("providerId"),
            "model": out.get("model"), "text": str(out.get("text"))[:40], "actualCost": out.get("actualCost"),
            "code": (n.get("errorDetails") or {}).get("code"), "error": str(n.get("error"))[:160] if n.get("error") else None}

if len(sys.argv) > 2 and sys.argv[2] == "auto":
    for i in range(int(sys.argv[3]) if len(sys.argv) > 3 else 3):
        print("AUTO_LOCAL", run({}))
    sys.exit(0)
print("AUTO_LOCAL", run({}))
print("MANUAL_PAID_NO_PERMISSION", run({"providerMode": "openrouter", "model": "openai/gpt-4o"}))
print("BYPASS_ATTEMPT", run({"providerMode": "openrouter", "model": "openai/gpt-4o", "providerModelId": "liquid/lfm-2.5-2.6b:free"}))
print("OLLAMA_CLOUD_PIN", run({"executionProvider": "local_openai", "model": "deepseek-v3.1:671b-cloud", "providerModelId": "deepseek-v3.1:671b-cloud"}))
print("POLZA_NO_PERMISSION", run({"model": "openai/gpt-4o"}, "polza.text"))
