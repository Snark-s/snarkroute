"""A ready listener and an old successful poll must not imply a working cloud tunnel."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home

bridge_root = home('snarkbridge')
sys.path.insert(0, str(bridge_root))
spec = importlib.util.spec_from_file_location('audited_bridge_services', bridge_root / 'bridge_services.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class TunnelFreshnessTests(unittest.TestCase):
    now = 1_791_723_000

    def status(self, poll):
        report = {'result': 'ok', 'healthz': {'ok': True}, 'readyz': {'ok': True},
                  'control_plane_poll': {'ok': True, 'value': poll}}
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(report), stderr='')
        with patch.object(bridge, 'service', return_value={'port': 8080}), \
             patch.object(bridge.subprocess, 'run', return_value=result), \
             patch.object(bridge.time, 'time', return_value=self.now):
            return bridge.service_status('snarkbridge_tunnel')[0]

    def test_recent_control_plane_exchange_is_ready(self):
        self.assertTrue(self.status(self.now - 30)['online'])

    def test_fourteen_hour_old_exchange_is_not_ready(self):
        self.assertFalse(self.status(self.now - 14 * 3600)['online'])

    def test_missing_invalid_or_future_exchange_is_not_ready(self):
        for poll in (None, False, 'not-a-timestamp', 0, self.now + 600):
            with self.subTest(poll=poll):
                self.assertFalse(self.status(poll)['online'])


if __name__ == '__main__':
    unittest.main()
