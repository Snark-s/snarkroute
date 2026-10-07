import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePersonaBridge, startPersonaBridgeSupervisor } from "./persona-bridge.mjs";

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

test("bridge uses pythonw by default on Windows to avoid console windows", async () => {
  let probes = 0;
  await ensurePersonaBridge({
    env: { PERSONA_HOME: "persona" }, platform: "win32",
    exists: (path) => path.endsWith("start_extension_bridge.py") || path.endsWith("pythonw.exe"),
    probe: async () => ++probes > 1, log: { log() {}, warn: assert.fail },
    launch: (file, _args, options) => {
      assert.ok(file.endsWith("pythonw.exe"));
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      return { once() {}, unref() {} };
    },
  });
});

test("missing Persona and disabled autostart do not launch anything", async () => {
  const launch = () => assert.fail("unexpected launch");
  await ensurePersonaBridge({ env: {}, exists: () => false, probe: async () => false, launch });
  await ensurePersonaBridge({ env: { PERSONA_BRIDGE_AUTO_START: "0" }, probe: () => assert.fail("unexpected probe"), launch });
});

test("supervisor keeps checking the bridge and never overlaps checks", async () => {
  let scheduled;
  let checks = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const timer = {};
  const result = startPersonaBridgeSupervisor({
    intervalMs: 10_000,
    ensure: async () => { checks += 1; await waiting; },
    schedule: (callback, delay) => {
      scheduled = callback;
      assert.equal(delay, 10_000);
      return timer;
    },
  });
  assert.equal(result, timer);
  const first = scheduled();
  await scheduled();
  assert.equal(checks, 1);
  release();
  await first;
  await scheduled();
  assert.equal(checks, 2);
});
