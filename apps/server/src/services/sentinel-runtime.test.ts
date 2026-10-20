import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Sentinel, SentinelRunResult } from "./sentinel";
import { attachSentinel } from "./sentinel-runtime";

const result: SentinelRunResult = {
  checkedAt: "2026-10-20T14:00:00.000Z", tiles: [], tickets: [], status: "ok",
  pulse: { agent: "snarkroute-sentinel", where: "SnarkRoute", schedule: "5m", lastPulse: "2026-10-20T14:00:00.000Z", result: "ok", status: "ok" }
};

describe("attachSentinel", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

  it("serves the latest run and writes latest.json without starting timers when disabled", async () => {
    process.env.SNARKROUTE_SENTINEL = "0";
    const dir = await mkdtemp(join(tmpdir(), "sentinel-")); dirs.push(dir);
    const app = Fastify();
    const fake = { runOnce: async () => result, stop: () => {} } as unknown as Sentinel;
    const wired = attachSentinel(app, { dataDir: dir, sentinel: fake });
    const before = await app.inject({ method: "GET", url: "/api/sentinel" });
    expect(before.json()).toMatchObject({ ok: true, enabled: false, latest: null });
    await wired.runNow();
    const after = await app.inject({ method: "GET", url: "/api/sentinel" });
    expect(after.json().latest.status).toBe("ok");
    expect(JSON.parse(await readFile(join(dir, "latest.json"), "utf8")).status).toBe("ok");
    await app.close();
    delete process.env.SNARKROUTE_SENTINEL;
  });
});
