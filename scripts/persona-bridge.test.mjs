import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePersonaBridge } from "./persona-bridge.mjs";

test("already running bridge is not launched twice", async () => {
  await ensurePersonaBridge({ env: {}, probe: async () => true, launch: () => assert.fail("duplicate launch") });
});

test("bridge launches hidden with the existing Persona environment", async () => {
  let probes = 0;
  let launched = false;
  await ensurePersonaBridge({ env: { PERSONA_HOME: "persona", PERSONA_PYTHON: "python" },
    exists: () => true, probe: async () => ++probes > 1, log: { log() {}, warn: assert.fail },
    launch: (file, args, options) => {
      launched = true;
      assert.equal(file, "python");
      assert.ok(args[0].endsWith("start_extension_bridge.py"));
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.equal(options.env.PERSONA_HOME, "persona");
      return { once() {}, unref() {} };
    },
  });
  assert.equal(launched, true);
});

test("missing Persona and disabled autostart do not launch anything", async () => {
  const launch = () => assert.fail("unexpected launch");
  await ensurePersonaBridge({ env: {}, exists: () => false, probe: async () => false, launch });
  await ensurePersonaBridge({ env: { PERSONA_BRIDGE_AUTO_START: "0" }, probe: () => assert.fail("unexpected probe"), launch });
});
