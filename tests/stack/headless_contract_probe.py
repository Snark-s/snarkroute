"""Factory-scene E/F + portable policy startup probe, no saved files or inference."""
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import sys
import shutil
import runpy
import bpy

sys.path.insert(0,str(Path(__file__).parent))
from stack_paths import home
sys.path.insert(0,str(home('mixar_local')))
from plan_contract import validate_blender_code,verification_passed
import route_endpoints
from importlib.util import spec_from_file_location,module_from_spec
policy_spec=spec_from_file_location('audit_policy',home('mixar_source')/'src/scripts/mixar/config/local_mode.py')
policy=module_from_spec(policy_spec)
policy_spec.loader.exec_module(policy)
before={obj.name:tuple(obj.location) for obj in bpy.context.scene.objects}
rejected=False
try:
    validate_blender_code('import os\nbpy.context.scene.clear()\n__RESULT__={}', 'script')
except ValueError:
    rejected=True
assert rejected and before=={obj.name:tuple(obj.location) for obj in bpy.context.scene.objects}
cube=bpy.data.objects['Cube']
code='bpy.data.objects["Cube"].location.x=1\n__RESULT__={"object":"Cube"}'
verify='__RESULT__={"passed":bpy.data.objects["Cube"].location.x==2,"actual":bpy.data.objects["Cube"].location.x}'
validate_blender_code(code,'script')
validate_blender_code(verify,'verify')
namespace={'bpy':bpy}
exec(compile(code,'<probe>','exec'),namespace)
exec(compile(verify,'<verify>','exec'),namespace)
assert not verification_passed({'success':True,'return_value':namespace['__RESULT__']})
for name,location in before.items(): bpy.data.objects[name].location=location
assert before=={obj.name:tuple(obj.location) for obj in bpy.context.scene.objects}
assert policy.is_local_mode() and not policy.telemetry_enabled()
assert not policy.is_mixar_credit_error(402,{'error':{'providerId':'polza'}},'https://api.mixar.app')
assert route_endpoints.load_registry()['host']=='127.0.0.1'
startup=home('mixar_startup')
theme=json.loads((startup/'snark_orange_theme.json').read_text())
assert theme['enabled'] is True
icon=startup/'snark_jabberwock_icon.png'
assert icon.is_file() and icon.stat().st_size>0
files=[startup/'snark_orange_theme.py',startup/'snark_orange_theme.json',icon]
files.extend(startup.parent.parent.glob('config/userpref.blend'))
hashes_before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
isolated=Path(os.environ['MIXAR_AUDIT_REPORT']).parent/'theme-copy'
isolated.mkdir(parents=True,exist_ok=True)
for name in ('snark_orange_theme.py','snark_orange_theme.json'):
    shutil.copyfile(startup/name,isolated/name)
theme_module=runpy.run_path(str(isolated/'snark_orange_theme.py'))
theme_module['_apply']()
snapshot={key:list(getattr(bpy.context.preferences.themes[0].view_3d,key)) for key in ('object_selected','object_active')}
expected=theme_module['_hex']('#F3A24F',snapshot['object_selected'])
assert all(abs(a-b)<0.00001 for a,b in zip(snapshot['object_selected'],expected))
hashes_after={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
assert hashes_before==hashes_after
report={'ok':True,'E':'invalid code rejected before scene mutation','F':'executed target x=1 vs requested x=2 failed verification',
        'C':'provider 402 has no Mixar subscription classification','factorySceneRestored':True,
        'sceneFile':bpy.data.filepath,'background':bpy.app.background,'registry':str(route_endpoints.registry_path()),
        'J':'real bpy theme applied from persistent startup copy; Jabberwock artwork available; GUI rendering/DPI pending',
        'theme':snapshot,'startupHashesUnchanged':True,'startupHashes':hashes_after,
        'blenderVersion':list(bpy.app.version)}
print('SNARK_AUDIT_REPORT '+json.dumps(report,ensure_ascii=False))
Path(os.environ['MIXAR_AUDIT_REPORT']).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
