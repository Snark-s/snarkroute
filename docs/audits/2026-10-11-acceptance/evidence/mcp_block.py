"""Show that a running managed_service_status call stalls an unrelated concurrent request."""
import sys, threading, time
sys.path.insert(0, sys.argv[2])
import mcp_call
mcp_call.URL = f"http://127.0.0.1:{sys.argv[1]}/mcp"
mcp_call.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "acceptance-probe", "version": "1"}}, 0)
slow = threading.Thread(target=lambda: print("slow", mcp_call.call("managed_service_status", {"name": "snarkbridge_mcp"}, 1)))
slow.start(); time.sleep(0.2)
print("concurrent bridge_status latency", mcp_call.call("bridge_status", {}, 2)[0])
slow.join()
