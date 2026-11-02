import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Sentinel, SentinelRunResult, SentinelTile } from "./sentinel";
import { attachSentinel, passportTicket, sentinelTiles } from "./sentinel-runtime";

const result = (): SentinelRunResult => ({
  checkedAt: "2026-10-20T14:00:00.000Z", tiles: [], tickets: [], status: "ok",
  pulse: { agent: "snarkroute-sentinel", where: "SnarkRoute", schedule: "5m", lastPulse: "2026-10-20T14:00:00.000Z", result: "ok", status: "ok" }
});
const clean = async () => ({ errors: [], warnings: [] });

describe("attachSentinel", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); delete process.env.SNARKROUTE_SENTINEL; });

  it("serves the latest run and writes latest.json without starting timers when disabled", async () => {
    process.env.SNARKROUTE_SENTINEL = "0";
    const dir = await mkdtemp(join(tmpdir(), "sentinel-")); dirs.push(dir);
    const app = Fastify();
    const fake = { runOnce: async () => result(), stop: () => {} } as unknown as Sentinel;
    const wired = attachSentinel(app, { dataDir: dir, sentinel: fake, tiles: () => [], passportCheck: clean });
    const before = await app.inject({ method: "GET", url: "/api/sentinel" });
    expect(before.json()).toMatchObject({ ok: true, enabled: false, latest: null });
    await wired.runNow();
    const after = await app.inject({ method: "GET", url: "/api/sentinel" });
    expect(after.json().latest.status).toBe("ok");
    expect(JSON.parse(await readFile(join(dir, "latest.json"), "utf8")).status).toBe("ok");
    await app.close();
  });

  it("turns passport drift into a ticket at most once a day", async () => {
    process.env.SNARKROUTE_SENTINEL = "0";
    const dir = await mkdtemp(join(tmpdir(), "sentinel-")); dirs.push(dir);
    let clock = Date.parse("2026-11-02T12:00:00Z");
    let checks = 0;
    const app = Fastify();
    const fake = { runOnce: async () => result(), stop: () => {} } as unknown as Sentinel;
    const wired = attachSentinel(app, { dataDir: dir, sentinel: fake, tiles: () => [], now: () => new Date(clock),
      passportCheck: async () => { checks += 1; return { errors: [], warnings: ["tove: в рабочей копии build/x, main = abc"] }; } });
    expect((await wired.runNow()).tickets.map(t => t.reason)).toEqual(["passport_drift"]);
    clock += 60 * 60_000;
    expect((await wired.runNow()).tickets).toEqual([]);
    clock += 24 * 60 * 60_000;
    expect((await wired.runNow()).tickets.map(t => t.reason)).toEqual(["passport_drift"]);
    expect(checks).toBe(2);
    const tickets = (await readFile(join(dir, "tickets.jsonl"), "utf8")).trim().split("\n");
    expect(tickets).toHaveLength(2);
    expect(JSON.parse(await readFile(join(dir, "passport.json"), "utf8")).warnings).toHaveLength(1);
    await app.close();
  });
});

describe("keep-alive for autonomous apps", () => {
  const tiles: SentinelTile[] = [
    { id: "tove", label: "tove", url: "http://127.0.0.1:4890", healthPath: "/api/health", watch: "always", owner: "tove" },
    { id: "factory", label: "factory", url: "http://127.0.0.1:4891", healthPath: "/api/health", watch: "always", owner: "tove" },
    { id: "ollama_inference", label: "ollama", url: "http://127.0.0.1:11434", healthPath: "/api/version", watch: "when_running" }
  ];

  it("gives a restart to apps the owner left running and none to the rest", async () => {
    const started: string[] = [];
    const wired = sentinelTiles({ tiles, intent: () => "run", start: async id => { started.push(id); } });
    expect(wired.find(t => t.id === "ollama_inference")?.restart).toBeUndefined();
    await wired.find(t => t.id === "tove")!.restart!();
    await wired.find(t => t.id === "factory")!.restart!();
    expect(started).toEqual(["tove", "factory"]);
  });

  it("never restarts an app the owner deliberately stopped and stops calling its absence a failure", () => {
    const wired = sentinelTiles({ tiles, intent: id => id === "factory" ? "stopped" : "run", start: async () => {} });
    const factory = wired.find(t => t.id === "factory")!;
    expect(factory.restart).toBeUndefined();
    expect(factory.watch).toBe("when_running");
    expect(wired.find(t => t.id === "tove")!.restart).toBeDefined();
  });

  it("a clean passport check produces no ticket", () => {
    expect(passportTicket({ errors: [], warnings: [] }, new Date())).toBeUndefined();
    expect(passportTicket({ errors: ["нет паспорта"], warnings: [] }, new Date())?.detail).toContain("ошибка: нет паспорта");
  });
});
