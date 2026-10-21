import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RADARS, RADAR_SYSTEM_PROMPT } from "./radar-config";
import { CLAUDE_SUBSCRIPTION_MODEL, createDefaultRadarModelInvoker, cronMatches, runClaudeCli, runDueRadars, runRadar, startRadarScheduler } from "./radar";

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
    const invoker = vi.fn(async () => ({ text: "## Shortlist\n\n- Official call", provider: radar.provider, model: radar.model }));
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

  it.each([
    ["402", new Error("Polza request failed (402).")],
    ["timeout", new Error("Polza radar request timed out.")],
    ["empty", { choices: [{ message: { content: "" } }] }]
  ])("retries Polza once and uses Claude fallback for %s", async (_label, failure) => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const polzaInvoker = vi.fn(async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    const claudeCli = vi.fn(async () => ({ text: "## Claude fallback\n\n- Проверено", model: CLAUDE_SUBSCRIPTION_MODEL, webSearch: true }));
    const invoker = createDefaultRadarModelInvoker({ polzaInvoker, claudeCli });
    const radar = { ...DEFAULT_RADARS[0], enabled: true, provider: "polza" as const };

    const result = await runRadar(radar, { dataRoot: root, invoker, now: () => new Date(2026, 9, 21, 12, 0, 0) });

    expect(result.status).toBe("ok");
    expect(polzaInvoker).toHaveBeenCalledTimes(2);
    expect(claudeCli).toHaveBeenCalledOnce();
    expect(result.pulse).toMatchObject({ provider: "claude-subscription", model: CLAUDE_SUBSCRIPTION_MODEL, fallback: true, fallbackRuns: 1 });
    const report = await readFile(join(root, radar.id, "2026-10-21.md"), "utf8");
    expect(report).toContain("Provider: `claude-subscription`");
    expect(report).toContain("- Fallback: true");
    expect(report).toContain("Polza failed after one retry");
  });

  it("does not invoke Claude when Polza succeeds", async () => {
    const polzaInvoker = vi.fn(async () => ({ choices: [{ message: { content: "Ответ Polza" } }] }));
    const claudeCli = vi.fn();
    const invoker = createDefaultRadarModelInvoker({ polzaInvoker, claudeCli });

    const result = await invoker({ provider: "polza", model: "perplexity/sonar-pro", systemPrompt: RADAR_SYSTEM_PROMPT, prompt: "Проверь новости" });

    expect(result).toMatchObject({ text: "Ответ Polza", provider: "polza", fallback: false });
    expect(polzaInvoker).toHaveBeenCalledOnce();
    expect(claudeCli).not.toHaveBeenCalled();
  });

  it("keeps the Claude OAuth token in child env only", async () => {
    const root = await mkdtemp(join(tmpdir(), "radar-")); roots.push(root);
    const token = "mock-oauth-secret";
    const tokenPath = join(root, "claude-oauth-token.txt");
    await writeFile(tokenPath, token, "utf8");
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let callNumber = 0;
    const spawnImpl = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      callNumber += 1;
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stderr.emit("data", `unknown tool WebSearch; diagnostic ${token}`);
        if (callNumber === 1) {
          child.stdout.emit("data", "");
          child.emit("close", 1);
        } else {
          child.stdout.emit("data", JSON.stringify({ result: `Ответ без ${token}`, model: "claude-test" }));
          child.emit("close", 0);
        }
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runClaudeCli(
      { provider: "polza", model: "perplexity/sonar-pro", systemPrompt: RADAR_SYSTEM_PROMPT, prompt: "Проверь новости" },
      { tokenPath, env: { ANTHROPIC_API_KEY: "must-not-pass", PATH: process.env.PATH }, spawnImpl }
    );

    expect(result).toMatchObject({ text: "Ответ без [REDACTED]", model: "claude-test", webSearch: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args.join(" ")).not.toContain(token);
    expect(calls[0].env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(calls[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
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
