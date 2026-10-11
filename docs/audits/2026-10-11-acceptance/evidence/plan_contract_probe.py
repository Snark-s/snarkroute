"""Acceptance probe for plan_contract.validate_blender_code('verify'): optimistic and mutating verify scripts."""
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from plan_contract import validate_blender_code, verification_passed

CASES = {
    "literal_receipt (should reject)": "import bpy\n__RESULT__ = {'passed': True}\n",
    "indirect_true_receipt": "import bpy\n_ = bpy.context.scene\nok = True\n__RESULT__ = {'passed': ok}\n",
    "dict_call_receipt": "import bpy\n_ = bpy.data.objects\n__RESULT__ = dict(passed=True)\n",
    "mutation_via_ops_alias": "import bpy\nfrom bpy import ops\nops.object.select_all(action='SELECT')\nops.object.delete()\n__RESULT__ = {'passed': len(bpy.data.objects) == 0}\n",
    "mutation_via_hide_set": "import bpy\no = bpy.data.objects.get('Cube')\no.hide_set(True)\n__RESULT__ = {'passed': o.hide_get()}\n",
    "mutation_via_vector_zero": "import bpy\no = bpy.data.objects.get('Cube')\no.location.zero()\n__RESULT__ = {'passed': o.location.x == 0}\n",
    "direct_assign (should reject)": "import bpy\nbpy.data.objects['Cube'].location.x = 2\n__RESULT__ = {'passed': True}\n",
}
for name, code in CASES.items():
    try:
        validate_blender_code(code, "verify")
        verdict = "ACCEPTED"
    except ValueError as error:
        verdict = "rejected: " + str(error)
    print(f"{name:34} {verdict}")
# The receipt of an accepted optimistic script is treated as a pass.
print("optimistic receipt counted as pass:", verification_passed({"success": True, "output": "__RESULT__ {\"passed\": true}"}))
