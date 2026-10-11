"""G/H against real factory-startup Blender; never uses the user's live scene."""
import importlib.util
import http.client
import json
import os
from pathlib import Path
import queue
import socket
import sys
import tempfile
import threading
import time
import types
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home
root = Path(__file__).parent
startup = home('mixar_startup')
with tempfile.TemporaryDirectory(dir=str(root)) as temporary:
    os.environ['LOCALAPPDATA'] = temporary
    token = 'fixture-only-' + 'x' * 48
    token_path = Path(temporary) / 'SnarkDream' / 'mixar_bridge_rpc.token'
    token_path.parent.mkdir()
    token_path.write_text(token, encoding='ascii')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    # Only discovery is injected; the production HTTP and Blender dispatch are real.
    helper = types.ModuleType('snark_local_runtime')
    helper.endpoints = types.SimpleNamespace(port=lambda name: port)
    sys.modules['snark_local_runtime'] = helper
    sys.path.insert(0, str(startup))
    spec = importlib.util.spec_from_file_location('audit_blender_bridge', startup / 'jabberwock_bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.run_on_main_thread = None
    before = [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
    completed = queue.Queue()

    def rpc(headers):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            connection.request('POST', '/rpc', json.dumps({'action': 'scene', 'args': {}}), headers={
                'Content-Type': 'application/json', 'X-Snark-Bridge-Token': token, **headers})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def client():
        try:
            assert rpc({'Origin': 'https://external.example'})[0] == 403
            assert rpc({'Host': 'attacker.example'})[0] == 403
            status, result = rpc({})
            assert status == 200 and result['ok'] and isinstance(result['result']['objects'], list)
            assert rpc({'Content-Type': 'text/plain'})[0] == 415
            completed.put(None)
        except BaseException as error:
            completed.put(error)

    worker = threading.Thread(target=client, daemon=True)
    worker.start()
    deadline = time.monotonic() + 20
    while completed.empty() and time.monotonic() < deadline:
        bridge._drain_main()  # Real bpy operations execute on Blender's main thread.
        time.sleep(0.01)
    if completed.empty():
        raise RuntimeError('RPC integration timed out')
    error = completed.get_nowait()
    if error:
        raise error
    after = [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
    assert before == after, 'Factory scene mutated by a read-only RPC'
    bridge.bpy.app.driver_namespace[bridge.KEY]['server'].shutdown()
    bridge.bpy.app.driver_namespace[bridge.KEY]['server'].server_close()
    print('BLENDER_REAL_RPC_G_H_PASS SCENE_UNCHANGED')
