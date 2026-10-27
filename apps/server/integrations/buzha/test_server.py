"""Focused tests for the deployed bureau (no provider calls or persistent user data)."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class BureauTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.registry = self.root / 'registry.json'
        self.registry.write_text(json.dumps({'host': '127.0.0.1', 'services': {
            'buzha': {'port': 18796, 'protocol': 'http'}, 'snarkroute': {'port': 14317, 'protocol': 'http'}
        }}), encoding='utf-8')
        self.env = patch.dict(os.environ, {'BUZHA_DATA_DIR': str(self.root / 'data'), 'SNARKROUTE_PORT_REGISTRY': str(self.registry)})
        self.env.start()
        spec = importlib.util.spec_from_file_location('buzha_test', Path(__file__).with_name('server.py'))
        self.app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.app)
        self.app.initialize()
        self.http = self.app.ThreadingHTTPServer(('127.0.0.1', 0), self.app.App)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)
        self.env.stop()
        self.temp.cleanup()

    def request(self, path, data=None, token=True):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Buzha-Token'] = self.app.TOKEN
        req = Request(self.base + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        with urlopen(req, timeout=3) as res:
            return json.load(res)

    def test_health_and_persistence(self):
        self.assertEqual(self.request('/api/health'), {'service': 'buzha', 'ok': True, 'apiVersion': 1, 'state': 'ready', 'automation': False})
        self.request('/api/jobs', {'title': 'Smoke order', 'amount': 100, 'hours': 1.5})
        self.request('/api/tasks', {'title': 'Manual task'})
        self.app.initialize()
        state = self.request('/api/state')
        self.assertEqual(state['jobs'][0]['title'], 'Smoke order')
        self.assertEqual(state['tasks'][0]['title'], 'Manual task')
        self.assertFalse(state['automation'])

    def test_only_registry_controls_ports_and_duplicate_ports_fail(self):
        with patch.dict(os.environ, {'BUZHA_PORT': '9999'}):
            self.assertEqual(self.app.registered_port('buzha'), 18796)
        doc = json.loads(self.registry.read_text())
        doc['services']['buzha']['port'] = 14317
        self.registry.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            self.app.registered_port('buzha')

    def test_model_selection_persists_and_chat_retains_accounting(self):
        self.request('/api/model', {'model': 'openrouter:from-catalog'})
        self.request('/api/message', {'content': 'hello'})
        answer = {'choices': [{'message': {'content': 'answer'}}], 'model': 'from-catalog',
                  'costs': {'providerCost': 0.001, 'baseCost': 0.001, 'currency': 'USD'}, 'provenance': {'runId': 'run-1'}}
        with patch.object(self.app, 'route_request', return_value=answer) as gateway:
            self.request('/api/chat', {})
        self.assertEqual(gateway.call_count, 1)
        self.assertEqual(gateway.call_args.args[0], '/api/system/buzha/chat/completions')
        self.app.initialize()
        state = self.request('/api/state')
        self.assertEqual(state['model'], 'openrouter:from-catalog')
        self.assertEqual(state['messages'][-1]['content'], 'answer')
        self.assertEqual(state['messages'][-1]['call']['costs']['providerCost'], 0.001)
        self.assertEqual(state['messages'][-1]['call']['provenance']['runId'], 'run-1')
        self.assertEqual(state['last_model_call']['costs']['providerCost'], 0.001)

    def test_model_error_is_recorded_without_retry(self):
        self.request('/api/model', {'model': 'openrouter:from-catalog'})
        self.request('/api/message', {'content': 'hello'})
        with patch.object(self.app, 'route_request', side_effect=ValueError('provider failed')) as gateway:
            with self.assertRaises(HTTPError) as error:
                self.request('/api/chat', {})
        self.assertEqual(error.exception.code, 502)
        self.assertEqual(gateway.call_count, 1)
        self.assertEqual(len(self.request('/api/state')['messages']), 1)

    def test_shutdown_requires_session_credential(self):
        with self.assertRaises(HTTPError) as error:
            self.request('/api/system/shutdown', {}, token=False)
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(self.request('/api/system/shutdown', {}), {'ok': True})
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())


if __name__ == '__main__':
    unittest.main()
