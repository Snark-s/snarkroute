import ast
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
from stack_paths import home
ROOT=home('mixar_source')/'src/scripts/mixar'
spec=importlib.util.spec_from_file_location('mixar.config.local_mode',ROOT/'config/local_mode.py')
policy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class LocalPolicyTests(unittest.TestCase):
    def test_c_provider_billing_never_classified_as_mixar_credit(self):
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1'}):
            for vendor in ('polza','openrouter'):
                self.assertFalse(policy.is_mixar_credit_error(402,{'error':{'providerId':vendor,'code':'provider_insufficient_balance'}},'https://api.mixar.app'))
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'0'}):
            self.assertFalse(policy.is_mixar_credit_error(402,{'error':{'providerId':'polza'}},'https://api.mixar.app'))
            self.assertFalse(policy.is_mixar_credit_error(402,{},'http://127.0.0.1:18880'))
            self.assertTrue(policy.is_mixar_credit_error(402,{'code':'mixar_credits_exhausted'},'https://api.mixar.app'))

    def test_c_actual_http_mapper_does_not_open_banner_for_upstream_402(self):
        tree=ast.parse((ROOT/'modules/common/api/client.py').read_text())
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='HTTPClient')
        fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_map_exception')
        class Error(Exception):
            def __init__(self, **kwargs): self.details=kwargs
        namespace={'requests':types.SimpleNamespace(Response=object),'HTTPClientError':Error}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'<mapper>','exec'),namespace)
        response=types.SimpleNamespace(status_code=402,text='HTTP 402',json=lambda:{'error':{'providerId':'openrouter','code':'provider_insufficient_balance'}})
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1'}),patch.dict(sys.modules,{'mixar.config.local_mode':policy}):
            mapped=namespace['_map_exception'](types.SimpleNamespace(_base_url='http://127.0.0.1:18880'),response)
            self.assertIsInstance(mapped,Error)
            self.assertEqual(mapped.details['status_code'],402)

    def test_local_api_cloud_block_and_opt_in_telemetry(self):
        endpoints=types.SimpleNamespace(url=lambda service:'http://127.0.0.1:19999')
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1','SNARK_MIXAR_TELEMETRY':'0'}),patch.dict(sys.modules,{'route_endpoints':endpoints}):
            policy.enforce_api_url('http://127.0.0.1:19999/api/v1/job-queue/jobs')
            for url in ('https://api.mixar.app/api/v1/images/generate','http://127.0.0.1:8080/v1/chat/completions','http://127.0.0.1:11434/api/generate'):
                with self.assertRaisesRegex(RuntimeError,'LOCAL_CLOUD_DISABLED'): policy.enforce_api_url(url)
            self.assertFalse(policy.telemetry_enabled())
            with patch.dict(os.environ,{'SNARK_MIXAR_TELEMETRY':'1'}):
                policy.enforce_api_url('https://api.mixar.app/api/v1/telemetry/events')
                with self.assertRaises(RuntimeError): policy.enforce_api_url('https://api.mixar.app/api/v1/images/generate')

    def test_llm_relay_denied_before_network(self):
        tree=ast.parse((ROOT/'modules/local_models/core/relay.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='handle_llm_request')
        namespace={'Callable':object,'_error':lambda code,msg:{'error':{'code':code,'message':msg}}}
        fn.returns=None
        for arg in fn.args.args: arg.annotation=None
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'<relay>','exec'),namespace)
        outputs=[]
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1'}),patch.dict(sys.modules,{'mixar.config.local_mode':policy}):
            namespace['handle_llm_request']({'url':'http://127.0.0.1:8080/v1/chat/completions'},outputs.append)
        self.assertEqual(outputs[0]['error']['code'],'snarkroute_required')

    def test_direct_media_inference_ports_denied_before_network(self):
        registry=Path(__file__).resolve().parents[2]/'service-endpoints.json'
        import json
        services=json.loads(registry.read_text(encoding='utf-8'))['services']
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1','SNARKROUTE_PORT_REGISTRY':str(registry)}):
            for name in ('h3_worker','local_upscale','yue2'):
                with self.subTest(service=name), self.assertRaisesRegex(RuntimeError,'LOCAL_CLOUD_DISABLED'):
                    policy.enforce_transport_url(f"http://127.0.0.1:{services[name]['port']}/generate")

    def test_unprotected_vendor_connector_cannot_start_in_local_mode(self):
        tree=ast.parse((ROOT/'modules/connector/core/sidecar.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='start_sidecar')
        namespace={'DEFAULT_SIDECAR_PORT':19998, '_server':None,
                   'ThreadingHTTPServer':lambda *_: (_ for _ in ()).throw(AssertionError('Unprotected listener started')),
                   '_Handler':object}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'<connector>','exec'),namespace)
        with patch.dict(os.environ,{'SNARK_MIXAR_LOCAL':'1'}),patch.dict(sys.modules,{'mixar.config.local_mode':policy}):
            with self.assertRaisesRegex(RuntimeError,'LOCAL_CLOUD_DISABLED'):
                namespace['start_sidecar']()

if __name__=='__main__': unittest.main()
