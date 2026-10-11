"""Full offline recovery into new roots, with no installs or credential transfers."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import zipfile

root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('bundle')
parser.add_argument('--target', required=True, help='New empty directory for this isolated restore test')
args=parser.parse_args()
bundle=Path(args.bundle).resolve()
target=Path(args.target).resolve()
assert not target.exists(), 'Restore probe requires a new, empty target'
with zipfile.ZipFile(bundle) as archive:
    manifest=json.loads(archive.read('manifest.json'))
override={
    'SNARK_PROCESS_ROOT':target/'Process', 'SNARK_APPS_ROOT':target/'Apps',
    'SNARKROUTE_ROOT':target/'Process/SnarkRoute', 'PERSONA_HOME':target/'PersonaCore',
    'SNARKBRIDGE_ROOT':target/'SnarkBridge', 'SNARK_AI_ROOT':target/'AI',
    'SNARK_MIXAR_PROFILE':target/'Profile/Mixar/Mixar/5.2',
    'SNARK_MIXAR_INSTALL':target/'Apps/Jabberwock Mixar Runtime',
    'SNARK_MIXAR_SOURCE':target/'Apps/Jabberwock Mixar Source',
    'SNARK_MIXAR_BACKEND':target/'Apps/Jabberwock Mixar Local',
    'SNARK_JABBER_BLENDER':target/'Apps/Jabberwock Blender',
    'SNARK_ARCENGINE':target/'AI/ArcEngine','SNARK_HOLLYWOOD':target/'Apps/Hollywood_2.0',
    'SNARK_FREETOKEN':target/'AI/FreeToken Desktop','SNARK_BONSAI':target/'AI/Bonsai-demo',
    'SNARK_AE_PANEL':target/'Profile/Adobe/CEP/extensions/com.snarkroute.aftereffects',
    'SNARK_REGISTRY_PATH':target/'LocalAppData/SnarkRoute/service-registry.json',
    'LOCALAPPDATA':target/'LocalAppData','APPDATA':target/'Profile',
}
os.environ.update({name:str(path.resolve()) for name,path in override.items()})
os.environ['SNARKROUTE_PORT_REGISTRY'] = str(override['SNARKROUTE_ROOT']/'service-endpoints.json')
spec=importlib.util.spec_from_file_location('audit_snarkdeploy',root/'deploy/snarkdeploy/snarkdeploy.py')
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
for component in manifest['components']:
    path=Path(deploy.expand(component['path'],manifest['variables'])).resolve()
    assert path.is_relative_to(target.resolve()), 'External restore target: '+str(path)
state=deploy.verify_bundle(bundle,quiet=True)
assert deploy.restore(SimpleNamespace(bundle=str(bundle),dry_run=False))==0
registry_path=override['SNARKROUTE_ROOT']/'service-endpoints.json'
registry=json.loads(registry_path.read_text(encoding='utf-8'))
for name,path in registry['paths'].items():
    assert Path(path).resolve().is_relative_to(target.resolve()), (name,path)
pointer=override['LOCALAPPDATA']/'SnarkDream/service-endpoints.path'
assert Path(pointer.read_text()).resolve()==registry_path.resolve()
assert not (override['LOCALAPPDATA']/'SnarkDream/mixar_bridge_rpc.dpapi').exists()
assert not (override['PERSONA_HOME']/'config/secrets.extension-token').exists()
proof={'test':'L-full-offline-restore','archive':str(bundle),'archiveSha256':deploy.sha256_file(bundle),
    'target':str(target.resolve()),'componentsRestored':sum(bool(c.get('present')) for c in state['components']),
    'registryPathsConfinedToNewRoots':True,'pointerRelocated':True,'credentialsTransferred':False,
    'sourceCommits':{c['id']:c.get('commit') for c in state['components'] if c.get('mode')=='git'},
    'factoryLaunch':'pending','fullDependencyInstall':'not performed'}
(target/'restore-result.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(proof,ensure_ascii=False))
