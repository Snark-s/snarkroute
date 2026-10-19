"""An attached before->after image is measured by the host and applied by a bounded tool."""
import ast
import asyncio
import base64
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

from stack_paths import home
sys.path.insert(0, str(home('mixar_local')))
from reference_image import analyze_before_after, analyze_payload, compact, extract_images
from mesh_region_tools import deform_profile, postcondition, shape_profile, validate_profile
from conversation_context import resolve_turn
import local_tool_agent as agent
from test_mesh_region_tools import trophy

BACKGROUND = (180, 215, 245)


def silhouette(draw, cx, top, height, half_width):
    for y in range(height):
        t = 1 - y / height
        draw.line([(cx - half_width(t), top + y), (cx + half_width(t), top + y)], fill=(120, 120, 120))


def before_after_png(arrow='right', single=False):
    image = Image.new('RGB', (760, 520), BACKGROUND)
    draw = ImageDraw.Draw(image)
    original = lambda t: 130 if t < 0.2 else 70 if t < 0.5 else 120
    narrowed = lambda t: original(t) * (0.8 if t < 0.2 else 0.85 if t < 0.5 else 1.0)
    silhouette(draw, 200, 40, 430, original)
    if not single:
        silhouette(draw, 570, 40, 430, narrowed)
        draw.line([(330, 280), (430, 280)], fill=(230, 20, 20), width=7)
        tip = 430 if arrow == 'right' else 330
        back = tip - 30 if arrow == 'right' else tip + 30
        draw.polygon([(tip, 280), (back, 255), (back, 305)], fill=(230, 20, 20))
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def content(data, mime='image/png'):
    return [{'type': 'text', 'text': 'Сделай такое изменение'},
            {'type': 'image_url', 'image_url': {'url': 'data:%s;base64,%s' % (mime, base64.b64encode(data).decode())}}]


def reference():
    return analyze_before_after(before_after_png())


class ReferenceImageTests(unittest.TestCase):
    def test_before_after_pair_yields_bounded_profile_that_preserves_top(self):
        result = reference()
        self.assertEqual(result['status'], 'ok', result.get('reason'))
        self.assertEqual((result['direction'], result['direction_source']), ('left_to_right', 'arrow'))
        summary = result['summary']
        self.assertAlmostEqual(summary['base_scale'], 0.8, delta=0.03)
        self.assertAlmostEqual(summary['neck_scale'], 0.85, delta=0.03)
        self.assertLessEqual(summary['preserve_from_t'], 0.6)
        scales = [s for _, s in result['profile']]
        self.assertEqual(scales, sorted(scales))
        self.assertTrue(all(s == 1.0 for t, s in result['profile'] if t >= result['preserve_from_t']))
        validate_profile(result['profile'], result['preserve_from_t'])
        self.assertIn('основание', result['text'])

    def test_arrow_direction_decides_which_silhouette_is_after(self):
        result = analyze_before_after(before_after_png(arrow='left'))
        # Read right-to-left, the "after" shape is wider at the bottom: not a narrowing.
        self.assertEqual(result['status'], 'unsupported')
        self.assertIn('не сужается', result['reason'])

    def test_unusable_images_report_a_concrete_reason(self):
        single = analyze_payload(content(before_after_png(single=True)))
        self.assertEqual(single['status'], 'unsupported')
        self.assertIn('силуэтов: 1', single['reason'])
        broken = analyze_payload([{'type': 'image_url', 'image_url': {'url': 'https://example.com/x.png'}}])
        self.assertIn('data URL', broken['reason'])
        self.assertIsNone(analyze_payload([{'type': 'text', 'text': 'no image'}]))
        self.assertEqual(extract_images(None), [])

    def test_payload_analysis_keeps_exact_bytes_for_follow_ups(self):
        data = before_after_png()
        with tempfile.TemporaryDirectory() as tmp:
            result = analyze_payload(content(data), Path(tmp))
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(Path(result['path']).read_bytes(), data)
        self.assertLess(len(json.dumps(compact(result))), 6000)


class ReferenceProfileTests(unittest.TestCase):
    PROFILE = [[0.0, 0.8], [0.2, 0.8], [0.45, 0.9], [0.6, 1.0], [1.0, 1.0]]

    def test_profile_narrows_lower_part_and_keeps_height_and_top(self):
        before = trophy()
        after, receipt = deform_profile(before, self.PROFILE, 0.6)
        self.assertTrue(np.array_equal(after[:, 2], before[:, 2]))
        top = before[:, 2] >= 0.6
        self.assertTrue(np.array_equal(after[top], before[top]))
        base = before[:, 2] < 0.1
        ratio = np.linalg.norm(after[base, :2], axis=1).mean() / np.linalg.norm(before[base, :2], axis=1).mean()
        self.assertAlmostEqual(ratio, 0.8, delta=0.01)
        self.assertTrue(receipt['preserved_upper'] and receipt['preserved_z'])
        self.assertEqual(shape_profile(after)['geometry_hash'], receipt['after_hash'])
        for band in receipt['bands']:
            self.assertGreaterEqual(band['measured_scale'], band['requested_min'] - 0.005)
            self.assertLessEqual(band['measured_scale'], band['requested_max'] + 0.005)

    def test_nested_object_moves_the_taper_below_it_or_refuses(self):
        before = trophy()
        after, receipt = deform_profile(before, self.PROFILE, 0.6, protect_from=0.5)
        self.assertEqual(receipt['deform_limit'], 0.5)
        keep = before[:, 2] >= 0.5
        self.assertTrue(np.array_equal(after[keep], before[keep]))
        with self.assertRaisesRegex(ValueError, 'nested object'):
            deform_profile(before, self.PROFILE, 0.6, protect_from=0.1)

    def test_invalid_profiles_fail_before_any_change(self):
        for profile in ([[0, 0.5], [1, 1]], [[0.5, 0.9], [0.4, 1]], [[0, 1], [1, 1]],
                        [[0, True], [1, 1]], [[0, float('nan')], [1, 1]], 'narrow'):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                deform_profile(trophy(), profile, 0.6)

    def test_front_depth_above_neck_is_kept_while_width_follows_profile(self):
        before = trophy()
        after, receipt = deform_profile(before, self.PROFILE, 0.6, front_depth_from=0.3)
        self.assertTrue(receipt['front_depth_preserved'])
        head = (before[:, 2] >= 0.33) & (before[:, 2] < 0.6)
        # Fully kept beyond 30% of the front depth (0.9 here); closer to the axis it blends.
        front, back = head & (before[:, 1] < -0.28), head & (before[:, 1] > 0.1)
        self.assertTrue(front.any())
        self.assertTrue(np.array_equal(after[front, 1], before[front, 1]))
        near = head & (before[:, 1] < -0.1) & (before[:, 1] > -0.25) & (before[:, 2] < 0.5)
        self.assertTrue(np.all(np.abs(after[near, 1]) > np.abs(before[near, 1]) * 0.9))
        self.assertTrue(np.all(np.abs(after[back, 1]) < np.abs(before[back, 1])))
        moved = head & (np.abs(before[:, 0]) > 1e-3)
        expected = np.interp(before[moved, 2], [p[0] for p in self.PROFILE], [p[1] for p in self.PROFILE])
        np.testing.assert_allclose(after[moved, 0] / before[moved, 0], expected, atol=1e-5)
        neck_base = before[:, 2] < 0.2
        self.assertAlmostEqual(np.abs(after[neck_base, 1]).max() / np.abs(before[neck_base, 1]).max(), 0.8, delta=0.01)
        receipt.update(name='Cup', reference_sha256='abc')
        args = {'name': 'Cup', 'reference_sha256': 'abc', 'front_depth_from': 0.3}
        self.assertTrue(postcondition(args, receipt, dict(shape_profile(after), name='Cup'), 'apply_reference_profile')[0])
        radial = deform_profile(before, self.PROFILE, 0.6)[1]
        self.assertFalse(postcondition(args, dict(radial, name='Cup', reference_sha256='abc'),
                                       dict(shape_profile(deform_profile(before, self.PROFILE, 0.6)[0]), name='Cup'),
                                       'apply_reference_profile')[0])

    def test_postcondition_binds_receipt_to_reference_and_fresh_readback(self):
        after, receipt = deform_profile(trophy(), self.PROFILE, 0.6)
        receipt.update(name='Cup', reference_sha256='abc')
        args = {'name': 'Cup', 'reference_sha256': 'abc'}
        check = dict(shape_profile(after), name='Cup')
        self.assertTrue(postcondition(args, receipt, check, 'apply_reference_profile')[0])
        self.assertFalse(postcondition(dict(args, reference_sha256='other'), receipt, check, 'apply_reference_profile')[0])
        tampered = json.loads(json.dumps(receipt))
        next(b for b in tampered['bands'] if b['unchanged'])['measured_scale'] = 0.97
        self.assertFalse(postcondition(args, tampered, check, 'apply_reference_profile')[0])


class ReferenceAgentTests(unittest.TestCase):
    def setUp(self):
        self.reference = reference()
        self.calls = []
        self.before = trophy()
        self.after, self.receipt = deform_profile(self.before, self.reference['profile'], self.reference['preserve_from_t'],
                                                  front_depth_from=self.reference['summary']['neck_t'])
        self.state = self.before
        self.scene = {'objects': [{'name': 'Cup', 'type': 'MESH', 'visible': True},
                                  {'name': 'Cup.001', 'type': 'MESH', 'visible': False},
                                  {'name': 'Bowl', 'type': 'MESH', 'visible': True}]}

    def call(self, name, args, sid=''):
        self.calls.append((name, dict(args)))
        if name == 'scene':
            return self.scene
        if name == 'checkpoint':
            return {'path': __file__}
        if name == 'apply_reference_profile':
            self.state = self.after
            return dict(self.receipt, name=args['name'], reference_sha256=args['reference_sha256'])
        if name == 'mesh_shape':
            return dict(shape_profile(self.state), name=args['name'])
        raise AssertionError(name)

    def run_agent(self, decisions, **kwargs):
        decisions = iter(decisions)
        async def routed(router, system, prompt, *args):
            self.prompt = prompt
            return {}, next(decisions), []
        async def inline(fn, *args, **kw):
            return fn(*args, **kw)
        router = SimpleNamespace(record_task_outcome=lambda *args: None)
        with patch.object(agent, '_routed_json', routed), patch.object(agent, 'call_tool', self.call), \
                patch.object(agent, 'asyncio', SimpleNamespace(to_thread=inline, iscoroutine=asyncio.iscoroutine)):
            return asyncio.run(agent.run('Сделай такое изменение', router, reference=self.reference,
                                         reference_images=True, **kwargs))

    def test_model_names_the_object_and_host_binds_the_measured_profile(self):
        result = self.run_agent([
            {'action': 'tool', 'tool': 'mesh_shape', 'args': {'name': 'Cup'}},
            {'action': 'tool', 'tool': 'apply_reference_profile', 'args': {'name': 'Cup'}}],
            task_context={'task': 'Сделай шею тоньше', 'target': 'Cup'})
        self.assertTrue(result['ok'], result['verification'])
        applied = next(args for name, args in self.calls if name == 'apply_reference_profile')
        self.assertEqual(applied['profile'], self.reference['profile'])
        self.assertEqual(applied['reference_sha256'], self.reference['sha256'])
        self.assertEqual(applied['front_depth_from'], self.reference['summary']['neck_t'])
        self.assertIn('профиль лица не изменился', result['answer'])
        self.assertEqual(result['verification']['basis'], 'reference_profile_geometry')
        self.assertIn('основание сужено', result['answer'])
        self.assertIn('REFERENCE IMAGE ANALYSIS', self.prompt)
        self.assertEqual([n for n, _ in self.calls].count('checkpoint'), 1)

    def test_model_cannot_supply_profile_hidden_copy_or_other_tools(self):
        result = self.run_agent([
            {'action': 'tool', 'tool': 'apply_reference_profile', 'args': {'name': 'Cup', 'profile': [[0, 0.7], [1, 1]]}},
            {'action': 'tool', 'tool': 'apply_reference_profile', 'args': {'name': 'Cup.001'}},
            {'action': 'tool', 'tool': 'decimate', 'args': {'name': 'Cup', 'ratio': 0.1}},
            {'action': 'final', 'success': True, 'answer': 'done'},
            {'passed': True, 'summary': 'trust me', 'problems': []}])
        self.assertFalse(result['ok'])
        errors = [row.get('error', '') for row in result['trace']]
        self.assertTrue(any('unexpected arguments: profile' in e for e in errors))
        self.assertTrue(any('visible mesh' in e for e in errors))
        self.assertTrue(any(e == 'unknown tool' for e in errors))
        self.assertNotIn('apply_reference_profile', [n for n, _ in self.calls])

    def receipts(self, after_hash=None):
        return {'task': 'Сделай такое изменение', 'target': 'Cup', 'reference_receipts': [
            {'target': 'Cup', 'reference_sha256': self.reference['sha256'],
             'before_hash': self.receipt['before_hash'], 'after_hash': after_hash or self.receipt['after_hash']}]}

    def test_same_reference_is_not_applied_twice(self):
        self.state = self.after
        result = self.run_agent([], task_context=self.receipts())
        self.assertTrue(result['ok'])
        self.assertIn('Повторно не применял', result['answer'])
        self.assertEqual([n for n, _ in self.calls], ['scene', 'mesh_shape'])

    def test_hand_edited_result_is_not_narrowed_again(self):
        self.state = self.after.copy()
        self.state[0, 0] += 0.01
        result = self.run_agent([], task_context=self.receipts())
        self.assertFalse(result['ok'])
        self.assertIn('Undo', result['answer'])
        self.assertEqual([n for n, _ in self.calls], ['scene', 'mesh_shape'])

    def test_reference_is_applied_again_after_user_undo(self):
        context = self.receipts(after_hash='earlier-result')
        result = self.run_agent([{'action': 'tool', 'tool': 'apply_reference_profile', 'args': {'name': 'Cup'}}],
                                task_context=context)
        self.assertTrue(result['ok'], result['verification'])
        self.assertIn('apply_reference_profile', [n for n, _ in self.calls])

    def test_unusable_reference_answers_with_reason_and_touches_nothing(self):
        async def unexpected(*args, **kwargs):
            self.fail('no scene or model access for an unusable image')
        bad = {'status': 'unsupported', 'reason': 'на изображении найдено силуэтов: 1'}
        with patch.object(agent, '_routed_json', unexpected), patch.object(agent, 'call_tool', unexpected):
            result = asyncio.run(agent.run('Сделай такое изменение', object(), reference=bad, reference_images=True))
        self.assertFalse(result['ok'])
        self.assertIn('силуэтов: 1', result['answer'])


class ReferenceConversationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.logs = Path(self.tmp.name)
        self.reference = compact(reference())

    def record(self, name, task, **kwargs):
        (self.logs / (name + '.json')).write_text(json.dumps(dict(session_id='s', task=task, **kwargs)), encoding='utf-8')

    def image_turn(self):
        self.record('02', 'Сделай такое изменение', reference=self.reference, result={'ok': True, 'trace': [
            {'tool': 'apply_reference_profile', 'args': {'name': 'Cup'}, 'read_only': False,
             'result': {'name': 'Cup', 'reference_sha256': self.reference['sha256'],
                        'before_hash': 'b', 'after_hash': 'a', 'changed_vertices': 9}}]})

    def test_followups_keep_reference_target_and_receipt(self):
        self.record('01', 'Сделай шею тоньше и основание тоже меньше', result={'trace': []})
        self.image_turn()
        repeat = resolve_turn('Повтори', 's', self.logs)
        self.assertFalse(repeat['read_only'])
        self.assertEqual(repeat['context']['target'], 'Cup')
        self.assertEqual(repeat['context']['reference']['sha256'], self.reference['sha256'])
        self.assertEqual(repeat['context']['reference_receipts'][-1]['after_hash'], 'a')
        report = resolve_turn('Нет, ничего не изменилось', 's', self.logs)
        self.assertTrue(report['read_only'])
        self.assertIn('"after_hash": "a"', json.dumps(report['context']))

    def test_report_after_noop_repeat_still_compares_with_the_real_edit(self):
        from conversation_context import compare_geometry, geometry_report
        self.record('01', 'Сделай шею тоньше', result={'trace': []})
        self.image_turn()
        self.record('03', 'Сделай такое изменение', reference=self.reference, result={'ok': True, 'trace': [
            {'tool': 'mesh_shape', 'args': {'name': 'Cup'}, 'read_only': True, 'result': {'geometry_hash': 'a'}}]})
        context = resolve_turn('Нет, ничего не изменилось', 's', self.logs)['context']
        trace = [{'tool': 'mesh_shape', 'result': {'name': 'Cup', 'geometry_hash': 'a'}}]
        comparison = compare_geometry(context, trace)
        self.assertEqual(comparison['status'], 'matches_last_result')
        self.assertIn('изменено вершин: 9', geometry_report(comparison, {'objects': []}, 'Нет, ничего не изменилось'))

    def test_image_turn_inherits_target_when_it_changed_nothing(self):
        self.record('01', 'Сделай шею тоньше', result={'trace': [
            {'tool': 'narrow_mesh_regions', 'args': {'name': 'Cup'}, 'read_only': False}]})
        self.record('02', 'Сделай такое изменение', reference=self.reference, result={'trace': []})
        context = resolve_turn('Повтори', 's', self.logs)['context']
        self.assertEqual((context['task'], context['target']), ('Сделай такое изменение', 'Cup'))

    def test_server_turns_attached_image_into_modeling_even_without_history(self):
        tree = ast.parse((home('mixar_local') / 'server.py').read_text(encoding='utf-8-sig'))
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'process_chat')
        calls = []
        async def tools(c, cid, payload):
            calls.append(payload)
        namespace = dict(asyncio=asyncio, ClientConnection=object, uuid=SimpleNamespace(uuid4=lambda: 's'),
                         SESSION_TURN_LOCKS={}, classify_task_domain=lambda text: 'general',
                         _is_render_to_moodboard=lambda text: False, resolve_turn=resolve_turn, LOG_DIR=self.logs,
                         process_chat_local_tools=tools, analyze_reference_payload=analyze_payload)
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<chat>', 'exec'), namespace)
        message = {'session_id': 's', 'message': 'Сделай такое изменение', 'content': content(before_after_png())}
        asyncio.run(namespace['process_chat'](None, 'turn', message))
        self.assertEqual(calls[0]['_resolved_domain'], 'modeling')
        self.assertFalse(calls[0]['_read_only'])
        self.assertEqual(calls[0]['_reference']['status'], 'ok')
        self.assertTrue(Path(calls[0]['_reference']['path']).is_file())
        # Without the image, a repeat recalls the measured reference from the log.
        self.image_turn()
        asyncio.run(namespace['process_chat'](None, 'turn', {'session_id': 's', 'message': 'Повтори'}))
        self.assertTrue(calls[1]['_reference']['reused_from_history'])
        self.assertEqual(calls[1]['_resolved_domain'], 'modeling')


if __name__ == '__main__':
    unittest.main()
