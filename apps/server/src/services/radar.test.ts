import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RADARS } from "./radar-config";
import { cronMatches, runDueRadars, runRadar, startRadarScheduler } from "./radar";

describe("radars", () => {
  const roots: string[] = [];
  afterEach(async () => {
    // Test roots are disposable; production radar data is never removed by this module.
    await Promise.all(roots.splice(0).map(async root => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }));
  });

  it("ships three disabled radar definitions", () => {
    expect(DEFAULT_RADARS).toHaveLength(3);
    expect(DEFAULT_RADARS.every(radar => radar.enabled === false)).toBe(true);
    expect(DEFAULT_RADARS.map(radar => radar.id)).toEqual([
      "filmfreeway-festival-radar", "immersive-media-brief", "h3-max-director-watch"
    ]);
  });

  it("writes a disabled pulse without invoking a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const invoker = vi.fn();
    const result = await runRadar(DEFAULT_RADARS[0], { dataRoot: root, invoker, now: () => new Date("2026-10-20T18:00:00.000Z") });
    expect(result.status).toBe("disabled");
    expect(invoker).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(root, DEFAULT_RADARS[0].id, "pulse.json"), "utf8"))).toMatchObject({ status: "ждёт", enabled: false });
  });

  it("uses a mocked model and writes markdown plus a pulse", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const radar = { ...DEFAULT_RADARS[0], enabled: true };
    const invoker = vi.fn(async () => ({ text: "## Shortlist\n\n- Official call", provider: "openrouter" as const, model: radar.model }));
    const result = await runRadar(radar, { dataRoot: root, invoker, now: () => new Date("2026-10-20T18:00:00.000Z") });
    expect(result.status).toBe("ok");
    expect(invoker).toHaveBeenCalledWith({ provider: radar.provider, model: radar.model, prompt: radar.prompt });
    expect(await readFile(join(root, radar.id, "2026-10-20.md"), "utf8")).toContain("Official call");
    expect(JSON.parse(await readFile(join(root, radar.id, "pulse.json"), "utf8"))).toMatchObject({ status: "ok", outputPath: result.outputPath });
  });

  it("runs only enabled radars whose cron is due", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const now = new Date(2026, 9, 20, 10, 0, 0);
    const due = { ...DEFAULT_RADARS[2], enabled: true };
    const notDue = { ...DEFAULT_RADARS[0], enabled: true };
    const invoker = vi.fn(async request => ({ text: request.model, provider: request.provider, model: request.model }));
    const results = await runDueRadars({ radars: [due, notDue], dataRoot: root, invoker, now: () => now });
    expect(results.map(result => result.radarId)).toEqual([due.id]);
    expect(invoker).toHaveBeenCalledOnce();
  });

  it("does not start a timer while all configured radars are disabled", () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const stop = startRadarScheduler({ radars: DEFAULT_RADARS });
    stop();
    expect(clearInterval).not.toHaveBeenCalled();
    clearInterval.mockRestore();
  });

  it("matches the five cron fields used by the radar schedule", () => {
    expect(cronMatches(new Date(2026, 9, 20, 10, 0), "0 10 * * *")).toBe(true);
    expect(cronMatches(new Date(2026, 9, 20, 10, 1), "0 10 * * *")).toBe(false);
  });
});
