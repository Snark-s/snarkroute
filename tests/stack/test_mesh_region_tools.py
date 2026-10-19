"""The local model chooses bounded operations; host code owns mesh changes."""
import sys
import unittest
from pathlib import Path

import numpy as np

from stack_paths import home
sys.path.insert(0, str(home('mixar_local')))
from mesh_region_tools import deform_regions, shape_profile, execute_tool, TOOL_SPECS
from local_tool_agent import _postcondition, _validate_args, _task_tools
from task_domain import classify


def trophy():
    points = []
    for z in np.linspace(0, 1, 129):
        radius = 0.8 if z < 0.23 else 0.2 if z < 0.56 else 0.9
        for angle in np.linspace(0, 2 * np.pi, 32, endpoint=False):
            points.append((radius * np.cos(angle), radius * np.sin(angle), z))
    return np.asarray(points, dtype=np.float32)


class MeshRegionTests(unittest.TestCase):
    def test_request_uses_structured_modeling_path(self):
        self.assertEqual(classify('Сделай шею тоньше и основание тоже меньше'), 'modeling')
        self.assertEqual(classify('Make the neck thinner and the base smaller'), 'modeling')

    def test_part_narrowing_cannot_choose_deletion_or_whole_object_scaling(self):
        tools = _task_tools('Сделай шею тоньше и основание тоже меньше')
        self.assertIn('narrow_mesh_regions', tools)
        self.assertNotIn('delete', tools)
        self.assertNotIn('transform', tools)
        self.assertIn('delete', _task_tools('Delete the temporary cube'))

    def test_both_regions_shrink_without_changing_height_or_upper_bowl(self):
        before = trophy()
        saved = before.copy()
        after, receipt = deform_regions(before, ['neck', 'base'], 0.9)
        self.assertTrue(np.array_equal(before, saved))
        self.assertTrue(np.array_equal(after[:, 2], before[:, 2]))
        upper = before[:, 2] >= 0.65
        self.assertTrue(np.array_equal(after[upper], before[upper]))
        for mask in (before[:, 2] < 0.1, (before[:, 2] > 0.32) & (before[:, 2] < 0.45)):
            self.assertLess(np.linalg.norm(after[mask, :2], axis=1).mean(),
                            np.linalg.norm(before[mask, :2], axis=1).mean())
        self.assertGreater(receipt['changed_vertices'], 0)
        self.assertTrue(receipt['preserved_z'])
        self.assertTrue(receipt['preserved_outside'])
        self.assertEqual(shape_profile(after)['geometry_hash'], receipt['after_hash'])

    def test_one_region_does_not_touch_the_other(self):
        before = trophy()
        after, _ = deform_regions(before, ['neck'], 0.9)
        self.assertTrue(np.array_equal(before[before[:, 2] < 0.2], after[before[:, 2] < 0.2]))

    def test_ambiguous_neck_and_invalid_inputs_fail_before_changes(self):
        cylinder = trophy()
        radius = np.linalg.norm(cylinder[:, :2], axis=1)
        cylinder[:, :2] /= radius[:, None]
        with self.assertRaisesRegex(ValueError, 'neck'):
            deform_regions(cylinder, ['neck'], 0.9)
        for factor in (float('nan'), True, 0, 1.2):
            with self.subTest(factor=factor), self.assertRaises(ValueError):
                deform_regions(trophy(), ['base'], factor)
        for regions in ([], ['head'], ['base', 'base']):
            with self.subTest(regions=regions), self.assertRaises(ValueError):
                deform_regions(trophy(), regions, 0.9)

    def test_structured_tool_arguments_are_bounded(self):
        self.assertIn('narrow_mesh_regions', TOOL_SPECS)
        self.assertTrue(_validate_args('narrow_mesh_regions', {'name': 'Cup', 'regions': ['neck', 'base']})[0])
        for args in ({'name': 'Cup', 'regions': ['head']},
                     {'name': 'Cup', 'regions': ['neck'], 'factor': True},
                     {'name': 'Cup', 'regions': ['neck'], 'factor': 2}):
            self.assertFalse(_validate_args('narrow_mesh_regions', args)[0])

    def test_postcondition_requires_independent_geometry_readback(self):
        after, receipt = deform_regions(trophy(), ['neck', 'base'], 0.9)
        receipt['name'] = 'Cup'
        args = {'name': 'Cup', 'regions': ['neck', 'base']}
        check = dict(shape_profile(after), name='Cup')
        self.assertTrue(_postcondition('narrow_mesh_regions', args, receipt, check)[0])
        check['geometry_hash'] = 'different'
        self.assertFalse(_postcondition('narrow_mesh_regions', args, receipt, check)[0])

    def test_fixed_tool_forwards_execution_session(self):
        requests = []
        def post(payload, timeout):
            requests.append(payload)
            return {'success': True, 'return_value': {'name': 'Cup'}}
        result = execute_tool('mesh_shape', {'name': 'Cup'}, post, session_id='scene-session')
        self.assertEqual(result['name'], 'Cup')
        self.assertEqual(requests[0]['args']['session_id'], 'scene-session')


if __name__ == '__main__':
    unittest.main()
