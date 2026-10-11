import importlib,json,os,sys
from pathlib import Path
import bpy

registry=json.loads(Path(os.environ['SNARKROUTE_PORT_REGISTRY']).read_text(encoding='utf-8'))
startup=Path(registry['paths']['mixar_startup'])
sys.path.insert(0,str(startup)); import snark_local_runtime
from mixar.config.local_mode import is_local_mode,enforce_api_url,is_mixar_credit_error
from mixar.modules.common.api.client import HTTPClient
runtime=(Path(os.environ['SNARKROUTE_PORT_REGISTRY']).parent/registry['paths']['mixar_runtime']).resolve()
assert runtime in Path(importlib.import_module(HTTPClient.__module__).__file__).resolve().parents
assert is_local_mode() and not is_mixar_credit_error(402,{'origin':'provider','providerId':'polza'},'https://api.mixar.app')
try: HTTPClient(base_url='https://api.mixar.app')._build_url('api/v1/images/generate')
except Exception as error: assert 'LOCAL_CLOUD_DISABLED' in str(error)
else: raise AssertionError('Portable REST client bypassed policy')
assert bpy.data.filepath==''
import requests,websocket
for service in ('ollama_inference','bonsai_inference','h3_worker','local_upscale','yue2'):
    try: requests.Session().send(requests.Request('POST',snark_local_runtime.endpoints.url(service)+'/v1/chat/completions').prepare())
    except requests.exceptions.ConnectionError as error: assert 'LOCAL_CLOUD_DISABLED' in str(error)
    else: raise AssertionError('Mixar attempted direct local inference')
try: requests.Session().send(requests.Request('POST','https://api.mixar.app/api/v1/auth/refresh').prepare())
except requests.exceptions.ConnectionError as error: assert 'LOCAL_CLOUD_DISABLED' in str(error)
else: raise AssertionError('Vendor refresh transport escaped local mode')
try: websocket.WebSocket().connect('wss://api.mixar.app/api/agent/ws/probe')
except websocket.WebSocketException as error: assert 'LOCAL_CLOUD_DISABLED' in str(error)
else: raise AssertionError('Vendor agent socket escaped local mode')
from mixar.modules.connector.core.sidecar import start_sidecar
try: start_sidecar()
except RuntimeError as error: assert 'LOCAL_CLOUD_DISABLED' in str(error)
else: raise AssertionError('Unprotected vendor connector escaped local mode')
from mixar.modules.auth.core import auth
auth._win_get_password=lambda *_: (_ for _ in ()).throw(AssertionError('Vendor credential read'))
assert auth.get_access_token()=='' and auth.get_refresh_token()=='' and auth.refresh_access_token() is False
print('MIXAR_PORTABLE_POLICY_PASS ACTUAL_HTTPCLIENT FACTORY_SCENE NO_NETWORK')
