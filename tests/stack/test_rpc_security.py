"""G/H: real HTTP transport, credentials confined to a temporary fixture."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from stack_paths import home
sys.path.insert(0, str(home('mixar_startup')))
from snark_rpc_security import protected_handler, token_path


class Legacy(BaseHTTPRequestHandler):
    executions = 0

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.json(200, {'ok': True, 'service': 'blender-test'})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not isinstance(payload, dict) or not isinstance(payload.get('args', {}), dict):
            return self.json(400, {'ok': False})
        Legacy.executions += 1
        self.json(200, {'ok': True, 'result': {'safe_read': payload.get('action')}})


class RpcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=str(Path(__file__).parents[1]))
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': self.temp.name})
        self.env.start()
        token_path().parent.mkdir(parents=True)
        token_path().write_text('fixture-token-' + 'x' * 40, encoding='ascii')
        Legacy.executions = 0
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), protected_handler(Legacy))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.env.stop()
        self.temp.cleanup()

    def request(self, headers=None, body=b'{"action":"scene","args":{}}', method='POST', path='/rpc'):
        client = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            client.request(method, path, body=body, headers={
                'Content-Type': 'application/json',
                'X-Snark-Bridge-Token': 'fixture-token-' + 'x' * 40,
                **(headers or {}),
            })
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            client.close()

    def test_g_web_origin_denied_even_with_valid_auth(self):
        status, headers, _ = self.request({'Origin': 'https://external.example'})
        self.assertEqual(status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(Legacy.executions, 0)

    def test_dns_rebinding_host_denied(self):
        self.assertEqual(self.request({'Host': 'attacker.example'})[0], 403)
        self.assertEqual(Legacy.executions, 0)

    def test_h_authorized_agent_safe_read(self):
        status, _, raw = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)['result']['safe_read'], 'scene')
        self.assertEqual(Legacy.executions, 1)

    def test_missing_token_fails_closed(self):
        token_path().unlink()
        self.assertEqual(self.request()[0], 403)
        self.assertEqual(Legacy.executions, 0)

    def test_payload_limit_and_type(self):
        self.assertEqual(self.request({'Content-Length': '1048577'})[0], 413)
        self.assertEqual(self.request({'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request({'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(Legacy.executions, 0)

    def test_browser_fetch_metadata_and_options_denied(self):
        self.assertEqual(self.request({'Sec-Fetch-Site': 'same-origin'})[0], 403)
        self.assertEqual(self.request(method='OPTIONS')[0], 403)
        self.assertEqual(self.request(headers={'Origin': 'https://evil.example'}, method='GET', path='/health')[0], 403)


if __name__ == '__main__':
    unittest.main()
