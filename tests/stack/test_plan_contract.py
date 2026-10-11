import ast
import asyncio
import json
from pathlib import Path
import sys
import unittest

from stack_paths import home
LOCAL = home('mixar_local')
sys.path.insert(0, str(LOCAL))
from plan_contract import execution_passed, validate_blender_code, verification_passed


class PlannerContractTests(unittest.TestCase):
    def test_e_rejects_invalid_python_import_escape_and_fake_receipt(self):
        for code in ('bpy.context.', 'import os\n__RESULT__={}',
                     '# __RESULT__\nx=3', "eval('3')\n__RESULT__={}",
                     'x=().__class__\n__RESULT__={}'): 
            with self.subTest(code=code), self.assertRaises(ValueError):
                validate_blender_code(code, 'script')

    def test_read_only_verification_enforced(self):
        for code in ('bpy.context.scene.frame_current=2\n__RESULT__={"passed":True}',
                     'bpy.ops.object.delete()\n__RESULT__={"passed":True}',
                     'bpy.data.objects.remove(obj)\n__RESULT__={"passed":True}'):
            with self.subTest(code=code), self.assertRaises(ValueError):
                validate_blender_code(code, 'verify')
        validate_blender_code('import bpy\n__RESULT__={"passed":len(bpy.context.scene.objects)==3}', 'verify')

    def test_f_execution_without_positive_boolean_receipt_never_verified(self):
        for result in (None, {}, {'success': True}, {'success': True, 'return_value': {'passed': 'false'}},
                       {'success': True, 'return_value': {'passed': 1}},
                       {'success': True, 'return_value': {'verified': True}},
                       {'success': False, 'return_value': {'passed': True}}):
            self.assertFalse(verification_passed(result))
        self.assertTrue(verification_passed({'success': True, 'return_value': {'passed': True}}))
        self.assertTrue(verification_passed({'success': True, 'output': '__RESULT__{"passed":true}'}))
        self.assertFalse(execution_passed(None))

    def test_f_failed_verification_prevents_optimistic_reporter_call(self):
        tree = ast.parse((LOCAL / 'server.py').read_text(encoding='utf-8-sig'))
        fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'final_text')
        called = []
        async def chat(*args, **kwargs):
            called.append(True)
            return 'Готово!'
        namespace = {'chat_llm': chat, 'verification_passed': verification_passed,
                     'execution_passed': execution_passed, 'compact': lambda value, limit: str(value), 'SYSTEM_FINAL': ''}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), '<final_text>', 'exec'), namespace)
        pending = namespace['final_text']('task', {'summary':'Done'}, {'success':True},
                                {'success':True, 'return_value':{'passed':False}})
        try:
            pending.send(None)
        except StopIteration as completed:
            result = completed.value
        self.assertFalse(called)
        self.assertNotEqual(result, 'Готово!')


if __name__ == '__main__':
    unittest.main()
