"""Focused runtime tests exercising actual local child processes."""
from __future__ import annotations
import importlib
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import time
import types
import unittest


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='snarkbridge-runtime-')
        self.root = Path(self.temp.name)
        self.client = 'alice'
        self.audit_events = []
        self.approvals = {}
        self.cfg = {'clients': {
            'alice': {'scopes': ['process:read', 'process:execute', 'job:execute'],
                      'allowed_executables': ['python'], 'allowed_workflows': ['hello', 'long', 'echo', 'fail', 'secret']},
            'bob': {'scopes': ['process:read', 'process:execute', 'job:execute'],
                    'allowed_executables': ['python'], 'allowed_workflows': ['hello']}},
            'executables': {'python': {'path': sys.executable, 'operation_class': 'sensitive',
                                     'max_seconds': 10, 'max_output_bytes': 65536}},
            'trusted_workflows': {}}
        for name, code in {
            'hello': "import sys;print('runtime-ok');print('runtime-error',file=sys.stderr)",
            'long': "import time;print('started',flush=True);time.sleep(30)",
            'echo': "import sys;print(sys.stdin.readline().strip(),flush=True)",
            'fail': "import sys;sys.exit(7)",
            'secret': "print('api_key=very-secret-value')",
        }.items():
            self.cfg['trusted_workflows'][name] = {
                'executable': 'python', 'args': ['-u', '-c', code],
                'cwd_root': 'workspace', 'cwd': '.', 'env': {},
                'timeout_seconds': 4, 'retry_safe': name != 'fail'}
        sec = types.ModuleType('bridge_security')
        sec.config = lambda: self.cfg
        sec.current_client = lambda: self.client
        sec.client_profile = lambda: self.cfg['clients'][self.client]
        def authorize(scope):
            if scope not in sec.client_profile()['scopes']:
                raise PermissionError('scope denied')
            return self.client
        sec.authorize = authorize
        def resolve_path(root, path='.', permission='read'):
            if root != 'workspace' or permission != 'execute':
                raise PermissionError('root denied')
            result = (self.root / path).resolve()
            if not result.is_relative_to(self.root):
                raise PermissionError('path escape')
            return result
        sec.resolve_path = resolve_path
        def audit(op, details):
            self.audit_events.append((op, details))
            return str(len(self.audit_events))
        sec.audit = audit
        sec.state_dir = lambda: self.root / '.state'
        def redact(value):
            if isinstance(value, str):
                return value.replace('very-secret-value', '[REDACTED]')
            if isinstance(value, dict):
                return {k: redact(v) for k, v in value.items()}
            if isinstance(value, list):
                return [redact(v) for v in value]
            return value
        sec.redact = redact
        def consume(approval_id, operation, payload):
            expected = self.approvals.pop(approval_id, None)
            if expected != (self.client, operation, payload):
                raise PermissionError('invalid approval')
        sec.consume_approval = consume
        self.old_sec = sys.modules.get('bridge_security')
        sys.modules['bridge_security'] = sec
        sys.modules.pop('bridge_runtime', None)
        self.rt = importlib.import_module('bridge_runtime')

    def tearDown(self):
        self.client = 'alice'
        for item in self.rt.process_list():
            if item['status'] in ('starting', 'running', 'running_orphaned'):
                self.rt.process_stop(item['id'])
        self.rt._shutdown_for_tests()
        sys.modules.pop('bridge_runtime', None)
        if self.old_sec is None:
            sys.modules.pop('bridge_security', None)
        else:
            sys.modules['bridge_security'] = self.old_sec
        self.temp.cleanup()

    def wait(self, ident, limit=5):
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            result = self.rt.job_status(ident)
            if result['status'] not in ('starting', 'running'):
                return result
            time.sleep(.03)
        self.fail('process did not finish')

    def test_real_job_output_stderr_and_exit(self):
        item = self.rt.job_submit('hello', idempotency_key='same')
        self.assertEqual(self.wait(item['id'])['exit_code'], 0)
        result = self.rt.job_result(item['id'])
        self.assertIn('runtime-ok', result['stdout'])
        self.assertIn('runtime-error', result['stderr'])
        self.assertEqual(self.rt.job_submit('hello', idempotency_key='same')['id'], item['id'])
        with self.assertRaises(ValueError):
            self.rt.job_submit('long', idempotency_key='same')
        failed = self.rt.job_submit('fail')
        self.assertEqual(self.wait(failed['id'])['exit_code'], 7)
        self.assertEqual(self.rt.job_status(failed['id'])['status'], 'failed')

    def test_stdin_owned_stop_and_timeout(self):
        echo = self.rt.job_submit('echo')
        self.rt.process_input(echo['id'], 'interactive-ok\n')
        self.wait(echo['id'])
        self.assertIn('interactive-ok', self.rt.job_result(echo['id'])['stdout'])
        long = self.rt.job_submit('long')
        self.assertEqual(self.rt.process_status(long['id'])['status'], 'running')
        self.rt.process_stop(long['id'])
        self.assertEqual(self.wait(long['id'])['status'], 'cancelled')
        timeout = self.rt.job_submit('long', timeout_seconds=.15)
        self.assertEqual(self.wait(timeout['id'])['status'], 'timed_out')

    def test_identity_and_environment_do_not_expand_permissions(self):
        item = self.rt.job_submit('hello')
        self.wait(item['id'])
        self.client = 'bob'
        self.assertEqual(self.rt.job_list(), [])
        with self.assertRaises(PermissionError):
            self.rt.job_result(item['id'])
        self.client = 'alice'
        with self.assertRaises(PermissionError):
            self.rt.process_start('python', ['-c', 'print(1)'], 'workspace')
        with self.assertRaises(PermissionError):
            self.rt.process_start('python', ['-c', 'print(1)'], 'workspace', env={'PYTHONPATH': str(self.root)})
        self.cfg['executables']['python']['operation_class'] = 'safe'
        with self.assertRaises(PermissionError):
            self.rt.process_start('python', ['-c', 'print(1)'], 'workspace')
        self.cfg['executables']['python']['allowed_args'] = [['-c', 'print(1)']]
        item = self.rt.process_start('python', ['-c', 'print(1)'], 'workspace')
        self.wait(item['id'])
        self.assertEqual(self.rt.process_output(item['id'])['stdout'].strip(), '1')

    def test_one_use_sensitive_approval_and_persisted_redaction(self):
        payload = {'executable': 'python', 'args': ['-c', 'print(123)'], 'cwd_root': 'workspace',
                   'cwd': '.', 'env': {}, 'timeout_seconds': None}
        self.approvals['once'] = ('alice', 'process_start', payload)
        item = self.rt.process_start('python', payload['args'], 'workspace', approval_id='once', idempotency_key='approved-retry')
        self.wait(item['id'])
        self.assertEqual(self.rt.process_start('python', payload['args'], 'workspace',
            idempotency_key='approved-retry')['id'], item['id'])
        with self.assertRaises(PermissionError):
            self.rt.process_start('python', payload['args'], 'workspace', approval_id='once')
        secret = self.rt.job_submit('secret')
        self.wait(secret['id'])
        self.assertNotIn('very-secret-value', self.rt.job_result(secret['id'])['stdout'])
        records = list((self.root / '.state' / 'runtime').glob('*.json'))
        self.assertTrue(records)
        self.assertNotIn('very-secret-value', ''.join(p.read_text() for p in records))

    def test_output_is_bounded_and_restart_never_replays(self):
        self.cfg['executables']['python']['max_output_bytes'] = 128
        self.cfg['trusted_workflows']['hello']['args'] = ['-c', "print('x'*5000)"]
        item = self.rt.job_submit('hello')
        self.wait(item['id'])
        result = self.rt.job_result(item['id'])
        self.assertLessEqual(len(result['stdout'].encode()), 128)
        self.assertTrue(result['output_truncated'])
        saved = dict(self.rt._records[item['id']])
        saved.update(status='running', pid=99999999, pid_created=1)
        self.rt._write_record(saved)
        self.rt._records.clear()
        self.rt._loaded_dir = None
        state = self.rt.job_status(item['id'])
        self.assertEqual(state['status'], 'unknown')
        self.assertEqual(self.rt.job_status(item['id'])['status'], 'unknown')

    def test_nonreading_stdin_cannot_block_timeout(self):
        item = self.rt.job_submit('long', timeout_seconds=.4)
        started = time.monotonic()
        for _ in range(16):
            try:
                self.rt.process_input(item['id'], 'x' * 4096)
            except ValueError:
                break
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(self.wait(item['id'])['status'], 'timed_out')

    def test_owned_descendant_tree_stop(self):
        code = "import subprocess,sys,time;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);print(p.pid,flush=True);time.sleep(30)"
        self.cfg['trusted_workflows']['long']['args'] = ['-u', '-c', code]
        item = self.rt.job_submit('long')
        deadline = time.monotonic() + 3
        output = ''
        while time.monotonic() < deadline:
            output = self.rt.process_output(item['id'])['stdout'].strip()
            if output:
                break
            time.sleep(.03)
        self.assertTrue(output, 'child PID not returned')
        child_pid = int(output)
        self.assertIsNotNone(self.rt._pid_created(child_pid))
        stopped = self.rt.process_stop(item['id'])
        self.wait(item['id'])
        self.assertTrue(stopped['tree_stop_complete'])
        self.assertIsNone(self.rt._pid_created(child_pid))

    def test_resume_only_retry_safe_and_idempotent(self):
        item = self.rt.job_submit('hello')
        self.wait(item['id'])
        record = self.rt._records[item['id']]
        record['status'] = 'unknown'
        self.rt._write_record(record)
        resumed = self.rt.job_resume(item['id'])
        self.assertNotEqual(resumed['id'], item['id'])
        self.wait(resumed['id'])
        self.assertEqual(self.rt.job_resume(item['id'])['id'], resumed['id'])
        failed = self.rt.job_submit('fail')
        self.wait(failed['id'])
        with self.assertRaises(PermissionError):
            self.rt.job_resume(failed['id'])

    def test_actual_runtime_crash_recovers_without_replay(self):
        """Kill a separate runtime host, then read its durable state in this host."""
        module_dir = str(Path(self.rt.__file__).parent)
        harness = self.root / 'crash_harness.py'
        harness.write_text("""import sys,types,json,time
from pathlib import Path
sys.path.insert(0, MODULE_DIR)
root=Path(ROOT)
cfg=json.loads(CONFIG)
sec=types.ModuleType('bridge_security')
sec.config=lambda:cfg
sec.current_client=lambda:'alice'
sec.client_profile=lambda:cfg['clients']['alice']
sec.authorize=lambda scope:'alice'
sec.resolve_path=lambda root_name,path='.',permission='read':root/path
sec.state_dir=lambda:root/'.state'
sec.redact=lambda value:value
sec.audit=lambda op,details:'crash-test-log'
sys.modules['bridge_security']=sec
import bridge_runtime as runtime
item=runtime.job_submit('long',idempotency_key='crash-job')
print(item['id'],flush=True)
time.sleep(30)
""".replace('MODULE_DIR', repr(module_dir)).replace('ROOT', repr(str(self.root)))
    .replace('CONFIG', repr(json.dumps(self.cfg))), encoding='utf-8')
        host = subprocess.Popen([sys.executable, str(harness)], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        try:
            ident = host.stdout.readline().strip()
            self.assertEqual(len(ident), 32, host.stderr.read() if host.poll() is not None else ident)
            host.kill()
            host.wait(timeout=5)
            # Closing the crashed Windows host's Job Object kills its children.
            deadline = time.monotonic() + 3
            source = self.root / '.state' / 'runtime' / (ident + '.json')
            stored = json.loads(source.read_text())
            while time.monotonic() < deadline and self.rt._same_process(stored):
                time.sleep(.03)
            recovered = self.rt.job_status(ident)
            self.assertEqual(recovered['status'], 'unknown')
            duplicate = self.rt.job_submit('long', idempotency_key='crash-job')
            self.assertEqual(duplicate['id'], ident)
            self.assertEqual(duplicate['status'], 'unknown')
            self.assertNotIn(ident, self.rt._live)
        finally:
            if host.poll() is None:
                host.kill()
                host.wait(timeout=5)
            host.stdout.close()
            host.stderr.close()

    def test_all_mcp_schemas_registered(self):
        from mcp.server.fastmcp import FastMCP
        mcp = FastMCP('runtime-test')
        self.rt.register(mcp)
        import asyncio
        names = {t.name for t in asyncio.run(mcp.list_tools())}
        self.assertEqual(names, {'process_start', 'process_status', 'process_output', 'process_input',
            'process_stop', 'process_list', 'job_submit', 'job_status', 'job_result', 'job_cancel',
            'job_resume', 'job_list'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
