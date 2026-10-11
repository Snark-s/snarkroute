"""Transport security regression against a test SnarkBridge instance."""
import json, sys, urllib.request, urllib.error
PORT = int(sys.argv[1])
base = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode()
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def code(headers, data=body, path="/mcp", method="POST"):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, headers={**base, **headers}, method=method)
    try:
        with op.open(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

print("valid", code({}))
print("wrong_host", code({"Host": "evil.example"}))
print("wrong_origin", code({"Origin": "https://evil.example"}))
print("oversized", code({}, data=b"{" + b" " * 1_100_000 + b"}"))
print("health_with_origin", code({"Origin": "https://evil.example"}, data=None, path="/health", method="GET"))
