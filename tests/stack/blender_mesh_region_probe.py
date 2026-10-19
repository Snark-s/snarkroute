"""Run only in a separate Mixar --background --factory-startup process."""
import json
import asyncio
import contextlib
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import uuid

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stack_paths import home
sys.path.insert(0, str(home('mixar_local')))
from mesh_region_tools import build_script, postcondition
from plan_contract import result_payload
from test_mesh_region_tools import trophy

points = trophy()
faces = []
for ring in range(128):
    for i in range(32):
        j = (i + 1) % 32
        faces.append((ring * 32 + i, ring * 32 + j,
                      (ring + 1) * 32 + j, (ring + 1) * 32 + i))
mesh = bpy.data.meshes.new('RegionProbeMesh')
mesh.from_pydata(points.tolist(), [], faces)
obj = bpy.data.objects.new('RegionProbe', mesh)
bpy.context.collection.objects.link(obj)
sentinel = bpy.data.objects.new('SharedMeshSentinel', mesh)
bpy.context.collection.objects.link(sentinel)
bpy.context.view_layer.objects.active = obj
obj.location = (2, 3, 4)
names_before = set(bpy.data.objects.keys())
polygons_before = len(mesh.polygons)


def fixed_tool(name, args):
    namespace = {}
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(build_script(name, args), namespace)
    # Match the production bridge, which returns stdout rather than Python locals.
    receipt = result_payload({'success': True, 'output': output.getvalue()})
    assert isinstance(receipt, dict), 'Native bridge requires a printed receipt'
    return receipt


args = {'name': obj.name, 'regions': ['neck', 'base'], 'factor': 0.9}
before = fixed_tool('mesh_shape', {'name': obj.name})
# A precisely named target must work with no selection and preserve UI selection.
for target in bpy.context.selected_objects:
    target.select_set(False)
bpy.context.view_layer.objects.active = None
receipt = fixed_tool('narrow_mesh_regions', args)
assert bpy.context.view_layer.objects.active is None
assert not bpy.context.selected_objects
after = fixed_tool('mesh_shape', {'name': obj.name})
ok, note = postcondition(args, receipt, after)
assert ok, note
assert set(bpy.data.objects.keys()) == names_before
assert obj.data is not sentinel.data
assert len(obj.data.polygons) == polygons_before
readback = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
obj.data.vertices.foreach_get('co', readback)
readback = readback.reshape((-1, 3))
sentinel_points = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
mesh.vertices.foreach_get('co', sentinel_points)
assert np.array_equal(sentinel_points.reshape((-1, 3)), points)
assert np.array_equal(readback[:, 2], points[:, 2])
assert np.array_equal(readback[points[:, 2] >= 0.65], points[points[:, 2] >= 0.65])
assert before['geometry_hash'] != after['geometry_hash']
# Editing any mesh in Edit Mode must still fail before touching coordinates.
sentinel.select_set(True)
bpy.context.view_layer.objects.active = sentinel
bpy.ops.object.mode_set(mode='EDIT')
try:
    fixed_tool('narrow_mesh_regions', args)
except ValueError as error:
    assert 'Object Mode' in str(error), error
else:
    raise AssertionError('A different object in Edit Mode must block the mutation')
bpy.ops.object.mode_set(mode='OBJECT')
sentinel.select_set(False)
bpy.context.view_layer.objects.active = None
assert fixed_tool('mesh_shape', {'name': obj.name})['geometry_hash'] == after['geometry_hash']
print('MESH_REGION_PROBE_PASS ' + json.dumps({
    'vertices': len(points), 'polygons': polygons_before,
    'changed_vertices': receipt['changed_vertices'],
    'height_preserved': True, 'upper_bowl_preserved': True,
    'shared_mesh_preserved': True, 'fresh_readback_verified': True,
}))
if '--model-check' in sys.argv:
    import local_tool_agent as agent
    from snarkroute_client import SnarkRouteTextClient

    artifacts = Path(sys.argv[sys.argv.index('--artifacts-dir') + 1])
    artifacts.mkdir(parents=True, exist_ok=True)
    client = object.__new__(SnarkRouteTextClient)
    client.base_url = 'http://127.0.0.1:4317'
    route = {'modelId': 'qwen3:8b', 'storedModelId': 'qwen3:8b',
             'provider': 'local_openai', 'providerModelId': 'qwen3:8b', 'explicitChoice': False}

    class LocalRouter:
        def generate(self, system, prompt, role='planner', quality='high', latency='normal',
                     cost='low', max_tokens=1600, temperature=0.03, *args, **kwargs):
            print('MODEL_PROBE_CALL ' + role, flush=True)
            text, run = client._run_candidate(system, prompt, route, max_tokens, temperature, 'region-tool-probe')
            return {'text': text, 'route': route, 'latency': 0}

        def record_task_outcome(self, *args):
            pass

        def record_protocol_failure(self, *args):
            pass

    mutations = []

    def object_info(target):
        result = {'name': target.name, 'type': target.type,
                  'location': list(target.location), 'scale': list(target.scale),
                  'selected': target == obj, 'dimensions': list(target.dimensions)}
        if target.type == 'MESH':
            result['mesh'] = {'vertices': len(target.data.vertices), 'polygons': len(target.data.polygons)}
        return result

    def isolated_call_tool(name, args, session_id=''):
        print('MODEL_PROBE_TOOL ' + name + ' ' + json.dumps(args, ensure_ascii=True), flush=True)
        if name == 'scene':
            return {'scene': bpy.context.scene.name, 'active': None,
                    'objects': [object_info(target) for target in bpy.context.scene.objects]}
        if name == 'object':
            return object_info(bpy.data.objects[args['name']])
        if name == 'checkpoint':
            checkpoint = artifacts / ('mesh-region-checkpoint-' + uuid.uuid4().hex[:8] + '.blend')
            bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint), copy=True)
            return {'path': str(checkpoint)}
        if name in ('mesh_shape', 'narrow_mesh_regions'):
            if name == 'narrow_mesh_regions':
                mutations.append(dict(args))
            return fixed_tool(name, args)
        raise AssertionError('Unexpected tool during isolated mesh test: ' + name)

    async def inline_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    # Keep bpy work on the headless process's main thread. There is no UI scene connection.
    agent.call_tool = isolated_call_tool
    agent.asyncio = SimpleNamespace(to_thread=inline_thread, iscoroutine=asyncio.iscoroutine)
    task = '\u0421\u0434\u0435\u043b\u0430\u0439 \u0448\u0435\u044e \u0442\u043e\u043d\u044c\u0448\u0435 \u0438 \u043e\u0441\u043d\u043e\u0432\u0430\u043d\u0438\u0435 \u0442\u043e\u0436\u0435 \u043c\u0435\u043d\u044c\u0448\u0435'
    result = asyncio.run(agent.run(task, LocalRouter(), max_steps=5))
    (artifacts / 'mesh-region-agent-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    assert result['ok'], json.dumps(result['verification'], ensure_ascii=True)
    assert len(mutations) == 1 and set(mutations[0]['regions']) == {'neck', 'base'}, mutations
    assert set(bpy.data.objects.keys()) == names_before
    final = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get('co', final)
    final = final.reshape((-1, 3))
    assert np.array_equal(final[:, 2], points[:, 2])
    assert np.array_equal(final[points[:, 2] >= 0.65], points[points[:, 2] >= 0.65])
    # Exercise real follow-up resolution, including a simulated sidecar restart.
    from conversation_context import resolve_turn
    history = artifacts / ('conversation-' + uuid.uuid4().hex[:8])
    history.mkdir()
    def save_turn(number, message, outcome):
        (history / (str(number) + '.json')).write_text(json.dumps({
            'session_id': 'isolated-probe', 'task': message,
            'task_domain': outcome['domain'], 'result': outcome}), encoding='utf-8')
    save_turn(1, task, result)
    repeat = '\u0421\u0434\u0435\u043b\u0430\u0439 \u0442\u0430\u043a\u043e\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0435'
    resolution = resolve_turn(repeat, 'isolated-probe', history)
    repeated = asyncio.run(agent.run(repeat, LocalRouter(), max_steps=5,
        task_context=resolution['context'], tool_task=resolution['tool_task'],
        read_only=resolution['read_only']))
    assert repeated['ok'], json.dumps(repeated['verification'], ensure_ascii=True)
    assert len(mutations) == 2 and all(m['name'] == obj.name for m in mutations), mutations
    save_turn(2, repeat, repeated)
    report = '\u041d\u0435\u0442, \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u043e\u0441\u044c'
    resolution = resolve_turn(report, 'isolated-probe', history)
    before_diagnosis = fixed_tool('mesh_shape', {'name': obj.name})['geometry_hash']
    diagnosed = asyncio.run(agent.run(report, LocalRouter(), max_steps=5,
        task_context=resolution['context'], tool_task=resolution['tool_task'],
        read_only=resolution['read_only']))
    assert len(mutations) == 2, mutations
    assert fixed_tool('mesh_shape', {'name': obj.name})['geometry_hash'] == before_diagnosis
    assert set(bpy.data.objects.keys()) == names_before
    assert not any(not row.get('read_only', True) and 'result' in row for row in diagnosed['trace'])
    (artifacts / 'mesh-conversation-agent-result.json').write_text(json.dumps({
        'repeat': repeated, 'diagnosis': diagnosed}, ensure_ascii=False, indent=2), encoding='utf-8')
    assert diagnosed['ok'], json.dumps(diagnosed, ensure_ascii=True)
    print('MESH_CONVERSATION_PROBE_PASS ' + json.dumps({
        'repeat_kept_intent': True, 'report_read_only': True, 'no_duplicate_created': True,
        'diagnosis': diagnosed['answer']}, ensure_ascii=True), flush=True)
    print('MESH_REGION_AGENT_PROBE_PASS ' + json.dumps({'model': 'qwen3:8b', 'ok': result['ok'],
          'mutations': mutations, 'checkpoint_verified': True, 'user_scene_changed': False}), flush=True)

# Reference-image profile: a nested bowl moves the taper below it; a visible
# overlapping duplicate is refused instead of silently hiding the change.
bowl_points = points[points[:, 2] >= 0.7] * np.asarray([0.5, 0.5, 1.0], dtype=np.float32)
bowl_mesh = bpy.data.meshes.new('ProbeBowlMesh')
bowl_mesh.from_pydata(bowl_points.tolist(), [], [])
bowl = bpy.data.objects.new('ProbeBowl', bowl_mesh)
bpy.context.collection.objects.link(bowl)
bowl.location = obj.location
bpy.context.view_layer.update()
reference_args = {'name': obj.name, 'reference_sha256': 'probe',
                  'profile': [[0.0, 0.8], [0.3, 0.85], [0.9, 1.0]], 'preserve_from': 0.9,
                  'front_depth_from': 0.35}
shape_before = fixed_tool('mesh_shape', {'name': obj.name})
reference_receipt = fixed_tool('apply_reference_profile', reference_args)
shape_after = fixed_tool('mesh_shape', {'name': obj.name})
ok, note = postcondition(reference_args, reference_receipt, shape_after, 'apply_reference_profile')
assert ok, note
assert [n['name'] for n in reference_receipt['nested_objects']] == ['ProbeBowl'], reference_receipt
assert reference_receipt['deform_limit'] < 0.7, reference_receipt
assert reference_receipt['front_depth_preserved'] is True, reference_receipt
assert shape_before['geometry_hash'] == reference_receipt['before_hash']
bowl_after = np.empty(len(bowl_mesh.vertices) * 3, dtype=np.float32)
bowl_mesh.vertices.foreach_get('co', bowl_after)
assert np.array_equal(bowl_after.reshape((-1, 3)), bowl_points)
twin = obj.copy()
twin.data = obj.data.copy()
bpy.context.collection.objects.link(twin)
try:
    fixed_tool('apply_reference_profile', reference_args)
except ValueError as error:
    assert 'overlaps the target' in str(error), error
else:
    raise AssertionError('A visible overlapping duplicate must block the reference edit')
assert fixed_tool('mesh_shape', {'name': obj.name})['geometry_hash'] == shape_after['geometry_hash']
bpy.data.objects.remove(twin, do_unlink=True)
bpy.data.objects.remove(bowl, do_unlink=True)
print('REFERENCE_PROFILE_PROBE_PASS ' + json.dumps({
    'deform_limit': reference_receipt['deform_limit'], 'nested_preserved': True,
    'overlapping_duplicate_refused': True, 'changed_vertices': reference_receipt['changed_vertices']}))
