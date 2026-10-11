"""Read-only verification guard through Mixar's real ScriptExecutor on the factory scene; nothing is saved."""
import asyncio
import json
from pathlib import Path
import sys
import bpy

sys.path.insert(0, str(Path(__file__).parent))
from stack_paths import home
sys.path.insert(0, str(home('mixar_local')))
from plan_contract import verification_passed
from verification_guard import SCENE_FINGERPRINT_SCRIPT, run_readonly_verification, scene_fingerprint
from mixar.modules.space_mixie_chat.core.executor import get_executor

executor = get_executor()


async def run(script, timeout):
    return executor.execute(script, push_undo=False, session_id='verify-guard-probe').to_dict()


fingerprint = scene_fingerprint(asyncio.run(run(SCENE_FINGERPRINT_SCRIPT, 45)))
assert fingerprint, 'scene fingerprint must work inside the real executor'
cube = bpy.data.objects['Cube']
original = tuple(cube.location)

honest = 'import bpy\nimport json\nprint("__RESULT__"+json.dumps({"passed": bpy.data.objects["Cube"].location.x == 0}))'
kept = asyncio.run(run_readonly_verification(run, honest, 30))
assert verification_passed(kept), kept

# A verification that edits the scene to make itself pass must fail, whatever it reports.
tampering = ('import bpy\nimport json\nbpy.data.objects["Cube"].location.x = 2\n'
             'print("__RESULT__"+json.dumps({"passed": bpy.data.objects["Cube"].location.x == 2}))')
caught = asyncio.run(run_readonly_verification(run, tampering, 30))
assert not verification_passed(caught) and 'changed the scene' in caught.get('error', ''), caught

cube.location = original
assert scene_fingerprint(asyncio.run(run(SCENE_FINGERPRINT_SCRIPT, 45))) == fingerprint
print('VERIFY_GUARD_REAL_EXECUTOR_PASS ' + json.dumps({'fingerprint': fingerprint[:12], 'honest': 'kept', 'tampering': caught['error']}))
