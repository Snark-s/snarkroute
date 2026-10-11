"""Read-only RPC with the owner's existing credential in an isolated factory scene."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home
sys.path.insert(0, str(home('mixar_startup')))
sys.path.insert(0, str(home('mixar_local')))
import route_endpoints
import local_tool_agent

assert bpy.data.filepath == '', 'This probe requires --factory-startup'
assert route_endpoints.bridge_token_headers(), 'Existing owner credential required'
spec = importlib.util.spec_from_file_location('audit_owner_bridge', home('mixar_startup') / 'jabberwock_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.run_on_main_thread = None
before = [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
completed = queue.Queue()


def denied(headers):
    connection = http.client.HTTPConnection('127.0.0.1', route_endpoints.port('mixar_bridge'), timeout=10)
    try:
        connection.request('POST', '/rpc', json.dumps({'action':'scene','args':{}}), headers={
            'Content-Type':'application/json', **route_endpoints.bridge_token_headers(), **headers})
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


def client():
    try:
        assert denied({'Origin':'https://external.example'}) == 403
        assert denied({'Host':'attacker.example'}) == 403
        result = local_tool_agent._post({'action':'scene','args':{}}, timeout=10)
        assert isinstance(result['objects'], list) and len(result['objects']) == len(before)
        completed.put(None)
    except BaseException as error:
        completed.put(error)


threading.Thread(target=client, daemon=True).start()
deadline = time.monotonic() + 20
while completed.empty() and time.monotonic() < deadline:
    bridge._drain_main()
    time.sleep(0.01)
assert not completed.empty(), 'Authorized RPC timed out'
error = completed.get_nowait()
if error:
    raise error
assert before == [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
bridge.bpy.app.driver_namespace[bridge.KEY]['server'].shutdown()
bridge.bpy.app.driver_namespace[bridge.KEY]['server'].server_close()
print('BLENDER_OWNER_DPAPI_RPC_G_H_PASS REAL_LOCAL_TOOL_CLIENT SCENE_UNCHANGED')
