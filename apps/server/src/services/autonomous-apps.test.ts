import { afterEach, describe, expect, it } from "vitest";
import { readAutonomousAppStatus, setAutonomousAppDeps, startAutonomousApp, stopAutonomousApp } from "./autonomous-apps";

function fakeWorld(initial: { open?: boolean; health?: Record<string, unknown> | null } = {}) {
  const world = { open: initial.open ?? false, health: initial.health ?? null as Record<string, unknown> | null, spawned: 0, shutdowns: 0, clock: 0 };
  setAutonomousAppDeps({
    installed: () => true,
    portOpen: async () => world.open,
    fetchJson: async (url, init) => {
      if (url.endsWith("/api/system/shutdown") && init?.method === "POST") { world.shutdowns += 1; world.open = false; return { ok: true, body: { ok: true } }; }
      if (!world.health) throw new Error("no health");
      return { ok: true, body: world.health };
    },
    spawnLauncher: () => { world.spawned += 1; world.open = true; world.health = { ok: true, service: "tove", state: "ready", mode: "run", pid: 42 }; },
    now: () => world.clock,
    wait: async (ms) => { world.clock += ms; }
  });
  return world;
}

afterEach(() => setAutonomousAppDeps(null));

describe("autonomous apps (Tove/Factory) in the Мастерская", () => {
  it("reports stopped when the port is closed", async () => {
    fakeWorld();
    expect((await readAutonomousAppStatus("tove")).state).toBe("stopped");
  });

  it("uses the app's own health state, not just an open port", async () => {
    fakeWorld({ open: true, health: { ok: true, service: "tove", state: "paused_gpu", mode: "pause_gpu", current: null } });
    const status = await readAutonomousAppStatus("tove");
    expect(status).toMatchObject({ state: "paused_gpu", running: true, mode: "pause_gpu" });
  });

  it("does not treat a foreign process on the port as the app", async () => {
    fakeWorld({ open: true, health: { ok: true, service: "something-else" } });
    expect((await readAutonomousAppStatus("factory")).state).toBe("unavailable");
    await expect(stopAutonomousApp("factory")).rejects.toThrow();
  });

  it("never starts a second instance on repeated or concurrent starts", async () => {
    const world = fakeWorld();
    const [a, b] = await Promise.all([startAutonomousApp("tove"), startAutonomousApp("tove")]);
    expect(a.state).toBe("ready");
    expect(b.state).toBe("ready");
    await startAutonomousApp("tove");
    expect(world.spawned).toBe(1);
  });

  it("stops through the app's own shutdown endpoint", async () => {
    const world = fakeWorld({ open: true, health: { ok: true, service: "tove", state: "working" } });
    const status = await stopAutonomousApp("tove");
    expect(world.shutdowns).toBe(1);
    expect(status.state).toBe("stopped");
  });

  it("reports unavailable when the application is not installed", async () => {
    fakeWorld();
    setAutonomousAppDeps({ installed: () => false });
    expect((await readAutonomousAppStatus("factory")).state).toBe("unavailable");
  });
});
