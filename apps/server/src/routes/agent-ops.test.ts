import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentOps, type AgentOps } from "../agent-ops";
import { ActivityMonitor } from "../agent-ops/activity";
import { currentOpsContext } from "../agent-ops/context";
import type { ExecutorAdapter, ExecutorProfile } from "../agent-ops/executors";
import { localServicePort } from "../services/local-service-endpoints";
import { registerAgentOpsRoutes } from "./agent-ops";

const profile: ExecutorProfile = { kinds: ["text", "analysis", "code_edit"], editsFiles: true, shell: true, maxContextTokens: 100_000, quality: "high", pause: "none", costTier: "subscription", order: 1 };
const idleExecutor: ExecutorAdapter = {
  id: "codex_cli", label: "fake codex", profile,
  probe: async () => ({ installed: true, authenticated: true, checkedAt: new Date().toISOString(), source: "fake" }),
  resourceRequest: () => ({ class: "light", cpuSlots: 1 }),
  // Never finishes during the test: the queue state stays stable.
  run: () => new Promise(() => undefined)
};

describe("agent-ops HTTP authorization", () => {
  let app: FastifyInstance;
  let ops: AgentOps;
  let directory: string;
  let tove: string;
  let factory: string;
  const launcherOrigin = `http://127.0.0.1:${localServicePort("launcher")}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-ops-http-"));
    await mkdir(join(directory, "sandbox", "p"), { recursive: true });
    ops = await createAgentOps({ directory: join(directory, "data"), workspaceRoots: [join(directory, "sandbox")], adapters: [idleExecutor], reviewer: null, tickMs: 60_000,
      activity: new ActivityMonitor(async () => ({ at: new Date().toISOString(), ok: true, totalCpuPercent: 5, processes: [], renders: [] }), 60_000),
      telemetry: async () => ({ gpu: { name: "RTX", totalMiB: 16384, usedMiB: 2048, freeMiB: 14336, utilizationPercent: 3 }, memory: { totalMiB: 65536, usedMiB: 8192, freeMiB: 57344 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
    app = Fastify();
    registerAgentOpsRoutes(app, { ops: Promise.resolve(ops) });
    app.get("/__context", async () => currentOpsContext());
    await app.ready();
    tove = ops.registry.issueAgentToken({ id: "app:tove", kind: "app", label: "Tove" }, 60_000);
    factory = ops.registry.issueAgentToken({ id: "app:factory", kind: "app", label: "Factory" }, 60_000);
  });

  afterAll(async () => {
    await app.close();
    await ops.tasks.drain();
    ops.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const call = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string> = {}, payload?: Record<string, unknown>) =>
    app.inject({ method, url: `/api/agent-ops${url}`, headers, ...(payload === undefined ? {} : { payload }) });

  it("gives no owner rights without a credential", async () => {
    expect((await call("PUT", "/mode", {}, { mode: "free" })).statusCode).toBe(401);
    expect((await call("PUT", "/schedule", {}, { rules: [] })).statusCode).toBe(401);
    expect((await call("POST", "/tasks", {}, { goal: "x" })).statusCode).toBe(401);
    expect((await call("POST", "/leases", {}, { class: "heavy", vramMiB: 1024 })).statusCode).toBe(401);
    expect((await call("POST", "/simulate", {}, { executor: "codex_cli" })).statusCode).toBe(401);
    expect((await call("GET", "/agents")).statusCode).toBe(401);
    const status = await call("GET", "/status");
    expect(status.statusCode).toBe(200);
    expect(status.json().identity).toEqual({ id: "anonymous", kind: "anonymous" });
  });

  it("hands the owner session only to the Workshop page and accepts it afterwards", async () => {
    expect((await call("POST", "/owner-session")).statusCode).toBe(403);
    expect((await call("POST", "/owner-session", { origin: "http://127.0.0.1:9999", "sec-fetch-mode": "cors" })).statusCode).toBe(403);
    expect((await call("POST", "/owner-session", { origin: launcherOrigin })).statusCode).toBe(403);
    const granted = await call("POST", "/owner-session", { origin: launcherOrigin, "sec-fetch-mode": "cors" });
    expect(granted.statusCode).toBe(200);
    const session = granted.json().session as string;
    expect((await call("PUT", "/mode", { "x-snarkroute-owner-session": session }, { mode: "owner_busy", minutes: 5 })).statusCode).toBe(200);
    expect((await call("PUT", "/mode", { "x-snarkroute-owner-session": `${session}x` }, { mode: "free" })).statusCode).toBe(401);
    expect((await call("GET", "/agents", { "x-snarkroute-owner-session": session })).statusCode).toBe(200);
    // An agent cannot turn its own token into an owner session.
    expect((await call("POST", "/owner-session", { "x-snarkroute-agent-token": tove })).statusCode).toBe(403);
    expect((await call("PUT", "/mode", { "x-snarkroute-owner-session": session }, { mode: null })).statusCode).toBe(200);
  });

  it("applies the same limits to an agent over HTTP as over MCP", async () => {
    expect((await call("PUT", "/mode", { "x-snarkroute-agent-token": tove }, { mode: "free" })).statusCode).toBe(403);
    expect((await call("PUT", "/limits", { "x-snarkroute-agent-token": tove }, { background: { reserveVramMiB: 0 } })).statusCode).toBe(403);
    expect((await call("POST", "/simulate", { "x-snarkroute-agent-token": tove }, { executor: "codex_cli" })).statusCode).toBe(403);
    const submitted = await call("POST", "/tasks", { "x-snarkroute-agent-token": tove }, { goal: "Fix the thing", workspace: join(directory, "sandbox", "p"), priority: 100 });
    expect(submitted.statusCode).toBe(202);
    const task = submitted.json().task as { id: string; priority: number };
    expect(task.priority).toBe(70);
    expect((await call("GET", `/tasks/${task.id}`, { "x-snarkroute-agent-token": tove })).statusCode).toBe(200);
    expect((await call("GET", `/tasks/${task.id}`, { "x-snarkroute-agent-token": factory })).statusCode).toBe(403);
    expect((await call("GET", `/tasks/${task.id}/result`, { "x-snarkroute-agent-token": factory })).statusCode).toBe(403);
    expect((await call("GET", `/tasks/${task.id}`)).statusCode).toBe(403);
    expect((await call("POST", `/tasks/${task.id}/cancel`, { "x-snarkroute-agent-token": factory })).statusCode).toBe(403);
    expect((await call("GET", "/status", { "x-snarkroute-agent-token": factory })).json().tasks).toEqual([]);
    expect((await call("POST", "/tasks", { "x-snarkroute-agent-token": tove }, { goal: "escape", workspace: tmpdir() })).statusCode).toBe(403);
    await ops.tasks.cancel(task.id, ops.registry.owner());
  });

  it("holds an agent's direct resource request to the computer mode", async () => {
    await ops.setManualMode(ops.registry.owner(), { mode: "owner_busy" });
    const lease = await call("POST", "/leases", { "x-snarkroute-agent-token": tove }, { class: "heavy", vramMiB: 1024, purpose: "direct" });
    expect(lease.statusCode).toBe(409);
    expect(lease.json()).toMatchObject({ granted: false, waitFor: "window" });
    expect((await call("POST", "/admission", { "x-snarkroute-agent-token": tove }, { class: "heavy", vramMiB: 1024 })).json()).toMatchObject({ granted: false, waitFor: "window" });
    await ops.setManualMode(ops.registry.owner(), { mode: null });
  });

  it("runs every request that carries an agent token as that agent, and rejects bad tokens", async () => {
    const plain = await app.inject({ method: "GET", url: "/__context" });
    expect(plain.json()).toMatchObject({ origin: "owner" });
    const agent = await app.inject({ method: "GET", url: "/__context", headers: { "x-snarkroute-agent-token": tove } });
    expect(agent.json()).toMatchObject({ origin: "agent", agentId: "app:tove" });
    expect((await app.inject({ method: "GET", url: "/__context", headers: { "x-snarkroute-agent-token": "forged.token" } })).statusCode).toBe(401);
  });

  it("renews a launched agent's token without changing who it is", async () => {
    const renewed = await call("POST", "/token/refresh", { "x-snarkroute-agent-token": tove });
    expect(renewed.statusCode).toBe(200);
    expect(ops.registry.identityFromToken(renewed.json().token)?.id).toBe("app:tove");
    expect((await call("POST", "/token/refresh")).statusCode).toBe(403);
  });
});
