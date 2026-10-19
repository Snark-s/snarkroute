"""Follow-ups retain intent and cannot turn a failure report into a mutation."""
import ast
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from stack_paths import home
sys.path.insert(0, str(home('mixar_local')))
from conversation_context import resolve_turn, compare_geometry, geometry_report
from reference_image import analyze_payload
import local_tool_agent as agent


TASK = 'Сделай шею тоньше и основание тоже меньше'


class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.logs = Path(self.tmp.name)
        self.record('01', 'scene-a', TASK, result={'ok': True, 'trace': [
            {'tool': 'narrow_mesh_regions', 'args': {'name': 'Cup', 'regions': ['neck', 'base'], 'factor': .9},
             'read_only': False, 'result': {'after_hash': 'changed', 'changed_vertices': 20}}]})

    def record(self, name, session, task, **kwargs):
        (self.logs / (name + '.json')).write_text(json.dumps(dict(session_id=session, task=task, **kwargs)), encoding='utf-8')

    def test_repeat_retains_original_intent_after_restart_and_failed_followup(self):
        self.record('02', 'scene-a', 'Сделай такое изменение', error='old planner failure')
        resolved = resolve_turn('Повтори', 'scene-a', self.logs)
        self.assertEqual(resolved['tool_task'], TASK)
        self.assertEqual(resolved['domain'], 'modeling')
        self.assertFalse(resolved['read_only'])
        self.assertEqual(resolved['context']['target'], 'Cup')
        self.assertIn('narrow_mesh_regions', json.dumps(resolved['context']))

    def test_negative_feedback_is_inspection_with_historical_evidence(self):
        resolved = resolve_turn('Нет, ничего не изменилось', 'scene-a', self.logs)
        self.assertEqual(resolved['domain'], 'inspection')
        self.assertTrue(resolved['read_only'])
        self.assertIn('changed', json.dumps(resolved['context']))

    def test_diagnosis_compares_actual_geometry_with_latest_receipt(self):
        context = resolve_turn('Ничего не изменилось', 'scene-a', self.logs)['context']
        receipt = context['outcome']['evidence'][0]['result']
        receipt['before_hash'] = 'original'
        for measured, status in [('changed', 'matches_last_result'),
                                 ('original', 'matches_before_change'), ('other', 'different_geometry')]:
            trace = [{'tool': 'mesh_shape', 'args': {'name': 'Cup'}, 'read_only': True,
                      'result': {'name': 'Cup', 'geometry_hash': measured}}]
            self.assertEqual(compare_geometry(context, trace)['status'], status)
        self.assertEqual(compare_geometry(context, [])['status'], 'not_measured')

    def test_coordinate_report_uses_measured_facts_and_mentions_overlapping_copy(self):
        scene = {'active_object': 'Cup.001', 'objects': [
            {'name': 'Cup', 'location': [0, 0, 0], 'visible': True},
            {'name': 'Cup.001', 'location': [0, 0, 0], 'visible': True}]}
        report = geometry_report({'target': 'Cup', 'status': 'matches_before_change'}, scene, 'Ничего не изменилось')
        self.assertIn('до последней правки', report)
        self.assertIn('Cup.001', report)
        report = geometry_report({'target': 'Cup', 'status': 'matches_last_result',
                                  'recorded_changed_vertices': 20}, scene, 'Ничего не изменилось')
        self.assertIn('20', report)
        self.assertIn('после операции', report)
        self.assertNotIn('не заметил', report)

    def test_no_cross_session_context_or_ambiguous_python_fallback(self):
        resolved = resolve_turn('Сделай такое изменение', 'other-scene', self.logs)
        self.assertIsNone(resolved['context'])
        self.assertTrue(resolved['read_only'])
        self.assertEqual(resolved['domain'], 'inspection')

    def test_new_explicit_task_replaces_old_intent(self):
        self.record('02', 'scene-a', 'Покрась куб в красный', task_domain='materials')
        resolved = resolve_turn('Сделай такое изменение', 'scene-a', self.logs)
        self.assertEqual(resolved['tool_task'], 'Покрась куб в красный')
        self.assertEqual(resolve_turn('Создай сферу', 'scene-a', self.logs)['context'], None)

    def test_server_resolves_followup_inside_session_lock(self):
        tree = ast.parse((home('mixar_local') / 'server.py').read_text(encoding='utf-8-sig'))
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'process_chat')
        calls = []
        async def tools(c, cid, payload):
            calls.append(payload)
        async def planner(*args):
            self.fail('Follow-up must not enter arbitrary Python planning')
        namespace = dict(asyncio=asyncio, ClientConnection=object, uuid=SimpleNamespace(uuid4=lambda: 'scene-a'), SESSION_TURN_LOCKS={},
                         classify_task_domain=lambda text: 'general', _is_render_to_moodboard=lambda text: False,
                         resolve_turn=resolve_turn, LOG_DIR=self.logs, process_chat_local_tools=tools,
                         _process_chat_locked=planner, analyze_reference_payload=analyze_payload)
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<chat>', 'exec'), namespace)
        asyncio.run(namespace['process_chat'](None, 'turn', {'session_id': 'scene-a', 'message': 'Нет, ничего не изменилось'}))
        self.assertTrue(calls[0]['_read_only'])
        self.assertEqual(calls[0]['_task_context']['task'], TASK)

    def test_readonly_followup_rejects_model_mutation_even_if_requested(self):
        decisions = iter([
            {'action': 'tool', 'tool': 'narrow_mesh_regions', 'args': {'name': 'Cup', 'regions': ['neck']}},
            {'action': 'final', 'success': True, 'answer': 'Inspected'},
            {'passed': True, 'summary': 'Inspection only', 'problems': []}])
        prompts, tools, systems = [], [], []
        async def routed(router, system, prompt, *args):
            prompts.append(prompt)
            systems.append(system)
            return {}, next(decisions), []
        async def inline(fn, *args, **kwargs):
            return fn(*args, **kwargs)
        def call(name, args, sid=''):
            tools.append(name)
            return {'objects': [{'name': 'Cup'}]}
        router = SimpleNamespace(record_task_outcome=lambda *args: None)
        resolved = resolve_turn('Нет, ничего не изменилось', 'scene-a', self.logs)
        with patch.object(agent, '_routed_json', routed), patch.object(agent, 'call_tool', call), patch.object(agent, 'asyncio', SimpleNamespace(to_thread=inline, iscoroutine=asyncio.iscoroutine)):
            result = asyncio.run(agent.run('Нет, ничего не изменилось', router,
                task_context=resolved['context'], tool_task=resolved['tool_task'], read_only=True))
        self.assertEqual(tools, ['scene', 'mesh_shape'])
        self.assertTrue(any('unknown tool' in row.get('error', '') for row in result['trace']))
        self.assertIn(TASK, prompts[0])
        self.assertIn('changed', prompts[-1])
        self.assertIn('Judge ONLY the current read-only diagnosis', systems[-1])
        self.assertFalse(result['ok'], 'A model cannot pass diagnosis without inspecting the original mesh')

    def test_repeat_cannot_decimate_or_switch_to_unrelated_active_copy(self):
        decisions = iter([
            {'action': 'tool', 'tool': 'decimate', 'args': {'name': 'Cup', 'ratio': .1}},
            {'action': 'tool', 'tool': 'narrow_mesh_regions', 'args': {'name': 'Cup.001', 'regions': ['neck']}},
            {'action': 'final', 'success': False, 'answer': 'Select original target'},
            {'passed': False, 'summary': 'No changes made', 'problems': []}])
        tools = []
        async def routed(*args):
            return {}, next(decisions), []
        async def inline(fn, *args, **kwargs):
            return fn(*args, **kwargs)
        def call(name, args, sid=''):
            tools.append(name)
            return {'active_object': 'Cup.001', 'objects': [{'name': 'Cup'}, {'name': 'Cup.001'}]}
        resolution = resolve_turn('Сделай такое изменение', 'scene-a', self.logs)
        with patch.object(agent, '_routed_json', routed), patch.object(agent, 'call_tool', call), patch.object(agent, 'asyncio', SimpleNamespace(to_thread=inline, iscoroutine=asyncio.iscoroutine)):
            result = asyncio.run(agent.run('Сделай такое изменение', SimpleNamespace(),
                task_context=resolution['context'], tool_task=resolution['tool_task']))
        self.assertEqual(tools, ['scene'])
        self.assertIn('original target', result['trace'][2]['error'])

    def test_image_reference_is_not_replaced_by_old_text_intent(self):
        async def unexpected(*args, **kwargs):
            self.fail('An unsupported image must not cause guessed scene edits or model calls')
        with patch.object(agent, '_routed_json', unexpected), patch.object(agent, 'call_tool', unexpected):
            result = asyncio.run(agent.run('Сделай такое изменение', object(),
                task_context={'task': TASK, 'target': 'Cup'}, reference_images=True))
        self.assertFalse(result['ok'])
        self.assertIn('изображени', result['answer'].lower())
        self.assertEqual(result['trace'], [])

    def test_identical_inspections_stop_before_step_limit_with_actual_error(self):
        actions = iter([
            {'action': 'tool', 'tool': 'narrow_mesh_regions', 'args': {'name': 'Cup', 'regions': ['neck']}},
            *[{'action': 'tool', 'tool': 'mesh_shape', 'args': {'name': 'Cup'}} for _ in range(3)],
            {'passed': True, 'summary': 'Do not trust this', 'problems': []}])
        reads = []
        async def routed(*args):
            return {}, next(actions), []
        async def inline(fn, *args, **kwargs):
            return fn(*args, **kwargs)
        def call(name, args, sid=''):
            reads.append(name)
            if name == 'checkpoint':
                return {'path': str(self.logs / '01.json')}
            if name == 'narrow_mesh_regions':
                raise RuntimeError('Switch to Object Mode')
            return {'name': 'Cup', 'geometry_hash': 'same'}
        with patch.object(agent, '_routed_json', routed), patch.object(agent, 'call_tool', call), patch.object(agent, 'asyncio', SimpleNamespace(to_thread=inline, iscoroutine=asyncio.iscoroutine)):
            result = asyncio.run(agent.run(TASK, SimpleNamespace(), max_steps=10))
        self.assertFalse(result['ok'])
        self.assertEqual(reads.count('mesh_shape'), 2)
        self.assertIn('Switch to Object Mode', result['answer'])
        self.assertNotIn('лимит шагов', result['answer'])


if __name__ == '__main__':
    unittest.main()
