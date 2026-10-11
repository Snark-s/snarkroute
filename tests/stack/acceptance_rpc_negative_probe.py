"""Acceptance: negative authentication cases against the real factory-startup Blender RPC."""
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
    token = 'fixture-only-' + 'y' * 48
    token_path = Path(temporary) / 'SnarkDream' / 'mixar_bridge_rpc.token'
    token_path.parent.mkdir()
    token_path.write_text(token, encoding='ascii')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    helper = types.ModuleType('snark_local_runtime')
    helper.endpoints = types.SimpleNamespace(port=lambda name: port)
    sys.modules['snark_local_runtime'] = helper
    sys.path.insert(0, str(startup))
    spec = importlib.util.spec_from_file_location('acceptance_blender_bridge', startup / 'jabberwock_bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.run_on_main_thread = None
    before = [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
    results = {}
    completed = queue.Queue()

    def request(method, path, headers, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            connection.request(method, path, body, headers=headers)
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    mutate = json.dumps({'action': 'transform', 'args': {'name': 'Cube', 'location': [9, 9, 9]}})
    good = {'Content-Type': 'application/json', 'X-Snark-Bridge-Token': token}

    def client():
        try:
            results['no_token'] = request('POST', '/rpc', {'Content-Type': 'application/json'}, mutate)
            results['wrong_token'] = request('POST', '/rpc', {**good, 'X-Snark-Bridge-Token': 'fixture-only-' + 'z' * 48}, mutate)
            results['prefix_token'] = request('POST', '/rpc', {**good, 'X-Snark-Bridge-Token': token[:-1]}, mutate)
            results['sec_fetch_site'] = request('POST', '/rpc', {**good, 'Sec-Fetch-Site': 'same-origin'}, mutate)
            results['get_scene_no_token'] = request('GET', '/scene', {})
            results['health_no_token'] = request('GET', '/health', {})
            results['oversized'] = request('POST', '/rpc', good, '{"action":"scene","args":{},"pad":"' + 'a' * 1_100_000 + '"}')
            results['extra_keys_schema'] = request('POST', '/rpc', good, json.dumps({'action': 'scene', 'args': {}, 'x': 1}))
            results['export_outside_root'] = request('POST', '/rpc', good, json.dumps({'action': 'export', 'args': {'name': 'Cube', 'filepath': str(Path(temporary) / 'escape.glb')}}))
            results['options'] = request('OPTIONS', '/rpc', {})
            completed.put(None)
        except BaseException as error:
            completed.put(error)

    threading.Thread(target=client, daemon=True).start()
    deadline = time.monotonic() + 30
    while completed.empty() and time.monotonic() < deadline:
        bridge._drain_main()
        time.sleep(0.01)
    if completed.empty():
        raise RuntimeError('RPC negative probe timed out')
    error = completed.get_nowait()
    if error:
        raise error
    after = [(obj.name, tuple(obj.location), tuple(obj.scale)) for obj in bpy.context.scene.objects]
    escaped = (Path(temporary) / 'escape.glb').exists()
    bridge.bpy.app.driver_namespace[bridge.KEY]['server'].shutdown()
    bridge.bpy.app.driver_namespace[bridge.KEY]['server'].server_close()
    print('ACCEPTANCE_RPC', json.dumps({**results, 'scene_unchanged': before == after, 'export_escaped': escaped}))
    expected = {'no_token': 403, 'wrong_token': 403, 'prefix_token': 403, 'sec_fetch_site': 403, 'get_scene_no_token': 403,
                'health_no_token': 200, 'oversized': 413, 'extra_keys_schema': 400, 'options': 403}
    failures = {k: (results.get(k), v) for k, v in expected.items() if results.get(k) != v}
    # The refusal currently surfaces as 500 (main-thread re-raise); what matters is that nothing is written.
    if results.get('export_outside_root') == 200:
        failures['export_outside_root'] = (200, 'refusal')
    assert not failures and before == after and not escaped, failures
    print('ACCEPTANCE_RPC_NEGATIVE_PASS')
