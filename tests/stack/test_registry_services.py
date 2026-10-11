import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

root = Path(__file__).parents[1]
from stack_paths import home
sys.path.insert(0, str(home('snarkbridge')))
from snark_services import load_registry, project_path, service_url
import bridge_services


class Foreign(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true,"service":"wrong-service","apiVersion":1}')


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=str(root))
        self.path = Path(self.temp.name) / 'service-endpoints.json'
        self.record = {'schemaVersion': 1, 'host': '127.0.0.1', 'services': {
            'snarkroute': {'port': 49000, 'protocol': 'http', 'healthPath': '/health',
                          'identity': {'field': 'service', 'value': 'snarkroute-server'}, 'apiVersion': 1}},
            'paths': {'snarkroute': 'portable/SnarkRoute', 'mixar_local': 'portable/MixarLocal'}}
        self.save()
        self.env = patch.dict(os.environ, {'SNARKROUTE_PORT_REGISTRY': str(self.path),
                                          'SNARKROUTE_HOME': '', 'MIXAR_LOCAL_HOME': ''})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.record), encoding='utf-8')

    def test_k_registry_relative_paths_follow_moved_install(self):
        expected = Path(self.temp.name) / 'portable' / 'SnarkRoute'
        self.assertEqual(project_path('snarkroute'), expected.resolve())
        self.assertEqual(service_url('snarkroute'), 'http://127.0.0.1:49000')
        relocated = Path(self.temp.name) / 'relocated'
        relocated.mkdir()
        new = relocated / self.path.name
        new.write_bytes(self.path.read_bytes())
        with patch.dict(os.environ, {'SNARKROUTE_PORT_REGISTRY': str(new)}):
            self.assertEqual(project_path('snarkroute'), (relocated / 'portable/SnarkRoute').resolve())

    def test_duplicate_port_and_missing_explicit_registry_fail(self):
        self.record['services']['foreign'] = {'port': 49000, 'protocol': 'http'}
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'conflicting'):
            load_registry()
        with patch.dict(os.environ, {'SNARKROUTE_PORT_REGISTRY': str(self.path) + '.missing'}):
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                service_url('snarkroute')

    def test_d_foreign_http_service_is_not_online_and_not_overlaunched(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Foreign)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.record['services']['snarkroute']['port'] = server.server_port
            self.save()
            self.assertFalse(bridge_services.service_status('snarkroute')[0]['online'])
            with patch.object(bridge_services.subprocess, 'Popen') as launch:
                with self.assertRaisesRegex(RuntimeError, 'occupied'):
                    bridge_services.start_service('snarkroute')
                launch.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__': unittest.main()
