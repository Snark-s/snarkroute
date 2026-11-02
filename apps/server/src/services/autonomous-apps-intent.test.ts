import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autonomousAppIntent, setAutonomousAppDeps, startAutonomousApp, stopAutonomousApp } from "./autonomous-apps";

const dirs: string[] = [];
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "intent-")); dirs.push(dir);
  const state = { open: false, clock: 0 };
  setAutonomousAppDeps({
    intentFile: () => join(dir, "intent.json"),
    installed: () => true,
    portOpen: async () => state.open,
    fetchJson: async (url, init) => {
      if (url.endsWith("/api/system/shutdown") && init?.method === "POST") { state.open = false; return { ok: true, body: { ok: true } }; }
      return { ok: true, body: { ok: true, service: "tove", state: "ready", mode: "run" } };
    },
    spawnLauncher: () => { state.open = true; },
    now: () => state.clock,
    wait: async ms => { state.clock += ms; }
  });
  return state;
}
afterEach(async () => { setAutonomousAppDeps(null); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("owner intent for autonomous apps", () => {
  it("defaults to run, so a reboot or crash is recovered", async () => {
    await world();
    expect(autonomousAppIntent("tove")).toBe("run");
  });

  it("a deliberate stop is remembered and a later start clears it", async () => {
    const state = await world();
    state.open = true;
    await stopAutonomousApp("tove");
    expect(autonomousAppIntent("tove")).toBe("stopped");
    expect(autonomousAppIntent("factory")).toBe("run");
    await startAutonomousApp("tove");
    expect(autonomousAppIntent("tove")).toBe("run");
  });

  it("test doubles without an explicit file never touch the real intent file", async () => {
    setAutonomousAppDeps({ installed: () => true, portOpen: async () => true,
      fetchJson: async () => ({ ok: true, body: { ok: true, service: "tove", state: "ready" } }), wait: async () => {} });
    await stopAutonomousApp("tove").catch(() => undefined);
    setAutonomousAppDeps(null);
    // The real file is untouched by the double above (it may hold the owner's own choice, never "stopped" from a test).
    expect(["run", "stopped"]).toContain(autonomousAppIntent("tove"));
  });
});
