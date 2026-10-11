"""Read-only probe: call SnarkBridge MCP tools over loopback and time them."""
import json, sys, time, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8767
URL = f"http://127.0.0.1:{PORT}/mcp"
HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
       "MCP-Protocol-Version": "2025-06-18"}


def rpc(method, params, rid):
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, headers=HDR, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    t = time.monotonic()
    with opener.open(req, timeout=60) as r:
        raw = r.read().decode()
    dt = time.monotonic() - t
    for line in raw.splitlines():
        if line.startswith("data:"):
            raw = line[5:]
    return dt, json.loads(raw)


def call(tool, args, rid):
    dt, res = rpc("tools/call", {"name": tool, "arguments": args}, rid)
    content = res.get("result", {}).get("structuredContent") or res.get("result", {}).get("content") or res
    return round(dt, 2), content


if __name__ == "__main__":
    rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "acceptance-probe", "version": "1"}}, 0)
    print("bridge_status", call("bridge_status", {}, 1))
    for i in range(3):
        print("mcp_status", call("managed_service_status", {"name": "snarkbridge_mcp"}, 10 + i))
    print("all_status", call("managed_service_status", {"name": "all"}, 20))
    # direct health from an independent process for comparison
    t = time.monotonic()
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f"http://127.0.0.1:{PORT}/health", timeout=5) as r:
        print("external_health", round(time.monotonic() - t, 3), r.read().decode())
