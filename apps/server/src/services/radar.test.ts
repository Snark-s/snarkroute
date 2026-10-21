import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RADARS, RADAR_SYSTEM_PROMPT } from "./radar-config";
import { createDefaultRadarModelInvoker, cronMatches, runDueRadars, runRadar, startRadarScheduler } from "./radar";

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

  it.each(DEFAULT_RADARS)("uses a mocked model with Russian instructions and writes $id", async radarDefinition => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const radar = { ...radarDefinition, enabled: true };
    const invoker = vi.fn(async () => ({ text: "## Shortlist\n\n- Official call", provider: "openrouter" as const, model: radar.model }));
    const result = await runRadar(radar, { dataRoot: root, invoker, now: () => new Date("2026-10-20T18:00:00.000Z") });
    expect(result.status).toBe("ok");
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({
      provider: radar.provider,
      model: radar.model,
      systemPrompt: expect.stringMatching(/русском языке/i),
      prompt: expect.stringMatching(/русском языке/i)
    }));
    expect(await readFile(join(root, radar.id, "2026-10-20.md"), "utf8")).toContain("Official call");
    expect(JSON.parse(await readFile(join(root, radar.id, "pulse.json"), "utf8"))).toMatchObject({ status: "ok", outputPath: result.outputPath });
  });

  it("sends the Russian system and user prompts to a mocked provider", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toEqual([
        { role: "system", content: RADAR_SYSTEM_PROMPT },
        { role: "user", content: DEFAULT_RADARS[0].prompt }
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Ответ на русском" } }] }), { status: 200 });
    });
    process.env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await createDefaultRadarModelInvoker()({
        provider: "openrouter",
        model: DEFAULT_RADARS[0].model,
        systemPrompt: RADAR_SYSTEM_PROMPT,
        prompt: DEFAULT_RADARS[0].prompt
      });
      expect(result.text).toBe("Ответ на русском");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
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
