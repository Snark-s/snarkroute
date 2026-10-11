import http.client
from pathlib import Path
import sys
import threading
import unittest
from types import SimpleNamespace
from stack_paths import home

sys.path.insert(0, str(home('personacore')))
from app.extension_bridge.http import create_server


class PersonaHealthTests(unittest.TestCase):
    def test_health_identifies_without_exposing_protected_routes(self):
        server = create_server(SimpleNamespace(root=Path('.')), 'fixture-' + 'x'*48, port=0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def request(path, headers=None):
            client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            try:
                client.request('GET', path, headers=headers or {})
                response = client.getresponse()
                return response.status, response.read()
            finally:
                client.close()
        try:
            status, body = request('/health')
            self.assertEqual(status, 200)
            self.assertIn(b'PersonaCore', body)
            self.assertEqual(request('/projects')[0], 401)
            self.assertEqual(request('/health', {'Origin':'https://external.example'})[0], 403)
            self.assertEqual(request('/health', {'Host':'attacker.example'})[0], 403)
        finally:
            server.shutdown()
            server.server_close()
