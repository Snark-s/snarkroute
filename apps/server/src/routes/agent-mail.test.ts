import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentOps, type AgentOps } from "../agent-ops";
import { ActivityMonitor } from "../agent-ops/activity";
import { registerAgentOpsRoutes } from "./agent-ops";

describe("D3: mail between agents", () => {
  let app: FastifyInstance;
  let ops: AgentOps;
  let directory: string;
  let tove: string;
  let secretary: string;
  let factory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-ops-mail-"));
    ops = await createAgentOps({ directory: join(directory, "data"), workspaceRoots: [join(directory, "sandbox")], adapters: [], tickMs: 60_000,
      activity: new ActivityMonitor(async () => ({ at: new Date().toISOString(), ok: true, totalCpuPercent: 5, processes: [], renders: [] }), 60_000),
      telemetry: async () => ({ memory: { totalMiB: 65536, usedMiB: 8192, freeMiB: 57344 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
    app = Fastify();
    registerAgentOpsRoutes(app, { ops: Promise.resolve(ops) });
    await app.ready();
    tove = ops.registry.issueAgentToken({ id: "app:tove", kind: "app", label: "Tove" }, 60_000);
    secretary = ops.registry.issueAgentToken({ id: "app:secretary", kind: "app", label: "Секретарь" }, 60_000);
    factory = ops.registry.issueAgentToken({ id: "app:factory", kind: "app", label: "Factory" }, 60_000);
  });

  afterAll(async () => {
    await app.close();
    ops.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const call = (method: "GET" | "POST", url: string, token?: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url: `/api/agent-ops${url}`, headers: token ? { "x-snarkroute-agent-token": token } : {}, ...(payload === undefined ? {} : { payload }) });

  it("delivers a letter tied to a task, wakes a waiting receiver and records the receipt", async () => {
    expect((await call("POST", "/mail", undefined, { to: "app:secretary", subject: "x", body: "y" })).statusCode).toBe(401);
    expect((await call("POST", "/mail", tove, { to: "nobody", subject: "x", body: "y" })).statusCode).toBe(400);

    const waiting = call("GET", "/mail/wait?timeoutMs=5000", secretary);
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now();
    const sent = await call("POST", "/mail", tove, { to: "app:secretary", subject: "Вопрос по цели", body: "Нужен ли этап публикации?", taskId: "t-20261104-0000abcd" });
    expect(sent.statusCode).toBe(201);
    const woke = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    const [letter] = woke.json().letters;
    expect(letter).toMatchObject({ from: "app:tove", to: "app:secretary", taskId: "t-20261104-0000abcd" });

    // Agents read only their own box; the receiver acknowledges, the sender sees the receipt.
    expect((await call("GET", "/mail?box=app:secretary", factory)).statusCode).toBe(403);
    expect((await call("POST", `/mail/${letter.id}/ack`, factory, {})).statusCode).toBe(403);
    expect((await call("POST", `/mail/${letter.id}/ack`, secretary, { note: "да, нужен" })).json().letter.ackNote).toBe("да, нужен");
    expect((await call("GET", "/mail?unacknowledged=1", secretary)).json().letters).toHaveLength(0);
    const receipt = (await call("GET", "/mail/sent", tove)).json().letters[0];
    expect(receipt.readAt).toBeTruthy();
    expect(receipt.ackAt).toBeTruthy();

    const reply = await call("POST", "/mail", secretary, { to: "app:tove", subject: "Re: Вопрос по цели", body: "Нужен.", replyTo: letter.id });
    expect(reply.json().letter.replyTo).toBe(letter.id);
    expect((await call("POST", "/mail", factory, { to: "app:tove", subject: "Re", body: "чужой ответ", replyTo: letter.id })).statusCode).toBe(400);
  });

  it("returns an empty inbox after the timeout when nothing arrives", async () => {
    expect((await call("GET", "/mail/wait?timeoutMs=150", factory)).json().letters).toEqual([]);
  });
});
