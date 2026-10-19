"""Exercise the real planner recovery path without a model or Blender execution."""
import ast
import asyncio
import contextlib
import io
import json
import re
import time
import unittest
from types import SimpleNamespace

from stack_paths import home
from test_plan_contract import validate_blender_code
from plan_contract import result_payload


class PlannerRecoveryTests(unittest.TestCase):
    def planner(self, replies):
        tree = ast.parse((home('mixar_local') / 'server.py').read_text(encoding='utf-8-sig'))
        names = {'_flatten_messages', '_chat_sync', 'chat_llm', 'extract_tag',
                 'clean_code', 'parse_plan', 'build_plan', 'repair_failed_plan'}
        functions = [node for node in tree.body
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        calls = []

        class Router:
            def generate(self, **kwargs):
                calls.append(kwargs)
                reply = replies[len(calls) - 1]
                if isinstance(reply, Exception):
                    raise reply
                if kwargs.get('validate_output'):
                    kwargs['validate_output'](reply)
                return {'text': reply, 'route': {}, 'latency': 0}

        async def inline_thread(function, *args, **kwargs):
            return function(*args, **kwargs)

        namespace = dict(ast=ast, asyncio=SimpleNamespace(to_thread=inline_thread), json=json, re=re, time=time,
                         ROUTER=Router(), ROUTING_TRACE=[], CFG={}, SYSTEM_AGENT='',
                         validate_blender_code=validate_blender_code,
                         result_payload=result_payload,
                         compact=lambda value, limit: json.dumps(value, ensure_ascii=False),
                         _is_render_to_moodboard=lambda task: False)
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<planner>', 'exec'), namespace)
        return namespace, calls

    def plan(self, script=None, verify=None):
        return json.dumps(dict(summary='Change frame', mutates=True,
            script=script or 'bpy.context.scene.frame_current=2\n__RESULT__={"frame":2}',
            verify=verify or '__RESULT__={"passed":bpy.context.scene.frame_current==2}'))

    def test_missing_receipt_reaches_format_repair(self):
        namespace, calls = self.planner([self.plan(script='bpy.context.scene.frame_current=2'), self.plan()])
        plan, _ = asyncio.run(namespace['build_plan']('change frame', {}, 'modeling'))
        self.assertIn('__RESULT__', plan['script'])
        self.assertEqual([call['role'] for call in calls], ['planner:modeling', 'planner_repair_format:modeling'])
        self.assertIn('missing __RESULT__ receipt', calls[1]['prompt'])

    def test_second_bad_plan_reaches_fresh_third_attempt(self):
        invalid = self.plan(script='bpy.context.scene.frame_current=2')
        namespace, calls = self.planner([invalid, invalid, self.plan()])
        plan, _ = asyncio.run(namespace['build_plan']('change frame', {}, 'modeling'))
        self.assertIn('__RESULT__', plan['script'])
        self.assertEqual(calls[-1]['role'], 'planner_contract_recovery:modeling')

    def test_three_bad_plans_remain_rejected(self):
        # Both missing receipts and fabricated verification must remain invalid.
        for invalid in [self.plan(script='bpy.context.scene.frame_current=2'),
                        self.plan(verify='__RESULT__={"passed":True}')]:
            with self.subTest(invalid=invalid):
                namespace, calls = self.planner([invalid] * 3)
                with self.assertRaisesRegex(ValueError, 'after 3 attempts; no scene changes'):
                    asyncio.run(namespace['build_plan']('change frame', {}, 'modeling'))
                self.assertEqual(len(calls), 3)

    def test_provider_failure_does_not_retry_or_change_models(self):
        namespace, calls = self.planner([RuntimeError('provider offline')])
        with self.assertRaisesRegex(RuntimeError, 'provider offline'):
            asyncio.run(namespace['build_plan']('change frame', {}, 'modeling'))
        self.assertEqual(len(calls), 1)

    def test_inspection_receipt_is_decoded_before_model_sees_object_names(self):
        namespace, calls = self.planner([self.plan()])
        scene = {'objects': [{'name': 'Кубок m'}]}
        evidence = {'success': True, 'output': '__RESULT__' + json.dumps(scene)}
        asyncio.run(namespace['build_plan']('change frame', evidence, 'modeling'))
        self.assertIn('Кубок m', calls[0]['prompt'])
        self.assertNotIn('\\u041a', calls[0]['prompt'])

    def test_execution_repair_also_checks_its_plan(self):
        namespace, calls = self.planner([self.plan(script='bpy.context.scene.frame_current=2'), self.plan()])
        plan, _ = asyncio.run(namespace['repair_failed_plan']('change frame', {}, {}, {}, 1, 'modeling'))
        self.assertIn('__RESULT__', plan['script'])
        self.assertEqual([call['role'] for call in calls], ['repair:modeling', 'repair_format:modeling'])

    def test_scene_digest_reports_local_shape_without_changing_mesh(self):
        tree = ast.parse((home('mixar_local') / 'server.py').read_text(encoding='utf-8-sig'))
        assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'INSPECT_SCRIPT' for t in n.targets))
        vertices = [SimpleNamespace(co=(-2, 0, 0)), SimpleNamespace(co=(2, 0, 0)),
                    SimpleNamespace(co=(-0.5, 0, 1)), SimpleNamespace(co=(0.5, 0, 1)),
                    SimpleNamespace(co=(-1, 0, 2)), SimpleNamespace(co=(1, 0, 2))]
        mesh = SimpleNamespace(vertices=vertices, edges=[], polygons=[], uv_layers=[])
        obj = SimpleNamespace(name='Кубок m', type='MESH', data=mesh, location=(0, 0, 0),
                              scale=(1, 1, 1), dimensions=(4, 0, 2), material_slots=[], modifiers=[],
                              bound_box=[(x, 0, z) for x in (-2, 2) for z in (0, 2)])
        bpy = SimpleNamespace(context=SimpleNamespace(scene=SimpleNamespace(name='Scene', objects=[obj]),
                              view_layer=SimpleNamespace(objects=SimpleNamespace(active=obj))))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(ast.literal_eval(assignment.value), {'bpy': bpy, 'json': json})
        evidence = result_payload({'output': output.getvalue()})
        shape = evidence['objects'][0]['mesh']
        self.assertEqual(shape['local_bounds'], [[-2, 0, 0], [2, 0, 2]])
        self.assertEqual(shape['z_profile']['sampled_vertices'], 6)
        radii = [band['radius_max'] for band in shape['z_profile']['bands'] if band['samples']]
        self.assertEqual(radii, [2, 0.5, 1])
        self.assertEqual([v.co for v in vertices], [(-2, 0, 0), (2, 0, 0), (-0.5, 0, 1),
                                                    (0.5, 0, 1), (-1, 0, 2), (1, 0, 2)])


if __name__ == '__main__':
    unittest.main()
