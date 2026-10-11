import importlib.util
import sys
import unittest
from unittest.mock import patch
from stack_paths import home

sys.path.insert(0, str(home('mixar_local')))
import route_endpoints


class BridgeSecretClientTests(unittest.TestCase):
    def test_encrypted_secret_is_read_by_the_real_client(self):
        with patch('snark_local_secret.read_bridge_token', return_value='encrypted-fixture-' + 'x' * 48):
            self.assertEqual(route_endpoints.bridge_token_headers(), {
                'X-Snark-Bridge-Token': 'encrypted-fixture-' + 'x' * 48})

    def test_missing_secret_fails_before_network(self):
        with patch('snark_local_secret.read_bridge_token', return_value=''):
            with self.assertRaisesRegex(RuntimeError, 'credential'):
                route_endpoints.bridge_token_headers()
