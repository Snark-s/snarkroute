import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentOps, type AgentOps } from "../agent-ops";
import { ActivityMonitor } from "../agent-ops/activity";
import type { ExecutorAdapter, ExecutorProfile } from "../agent-ops/executors";
import { goalProgress } from "../agent-ops/goals";
import type { AgentTask } from "../agent-ops/types";
import { registerAgentOpsRoutes } from "./agent-ops";

const profile: ExecutorProfile = { kinds: ["text", "analysis", "code_edit"], editsFiles: true, shell: true, maxContextTokens: 100_000, quality: "high", pause: "none", costTier: "subscription", order: 1 };
const idleExecutor: ExecutorAdapter = {
  id: "codex_cli", label: "fake codex", profile,
  probe: async () => ({ installed: true, authenticated: true, checkedAt: new Date().toISOString(), source: "fake" }),
  resourceRequest: () => ({ class: "light", cpuSlots: 1 }),
  run: () => new Promise(() => undefined)
};

describe("D1: goals in agent-ops", () => {
  let app: FastifyInstance;
  let ops: AgentOps;
  let directory: string;
  let tove: string;
  let factory: string;
  let workspace: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-ops-goals-"));
    workspace = join(directory, "sandbox", "p");
    await mkdir(workspace, { recursive: true });
    ops = await createAgentOps({ directory: join(directory, "data"), workspaceRoots: [join(directory, "sandbox")], adapters: [idleExecutor], tickMs: 60_000,
      activity: new ActivityMonitor(async () => ({ at: new Date().toISOString(), ok: true, totalCpuPercent: 5, processes: [], renders: [] }), 60_000),
      telemetry: async () => ({ memory: { totalMiB: 65536, usedMiB: 8192, freeMiB: 57344 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
    app = Fastify();
    registerAgentOpsRoutes(app, { ops: Promise.resolve(ops) });
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

  const call = (method: "GET" | "POST", url: string, token?: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url: `/api/agent-ops${url}`, headers: token ? { "x-snarkroute-agent-token": token } : {}, ...(payload === undefined ? {} : { payload }) });

  it("registers a goal, orders its stages and counts progress by accepted stages only", async () => {
    expect((await call("POST", "/goals", undefined, { title: "x" })).statusCode).toBe(401);
    const created = await call("POST", "/goals", tove, { title: "Найти заказ на анимацию", source: "chatgpt" });
    expect(created.statusCode).toBe(201);
    const goal = created.json().goal as { id: string; source: string; createdBy: string; progress: { status: string } };
    expect(goal).toMatchObject({ source: "chatgpt", createdBy: "app:tove", progress: { status: "no_stages" } });
    // The same active goal is not registered twice.
    expect((await call("POST", "/goals", tove, { title: "найти заказ на анимацию" })).json().goal.id).toBe(goal.id);

    const first = (await call("POST", "/tasks", tove, { goal: "Собрать список площадок", workspace, goalId: goal.id })).json().task as AgentTask;
    const second = await call("POST", "/tasks", tove, { goal: "Откликнуться на лучший заказ", workspace: join(directory, "sandbox"), goalId: goal.id, after: [first.id] });
    expect(second.statusCode).toBe(202);
    expect(second.json().task.dependsOn).toEqual([first.id]);

    const view = (await call("GET", `/goals/${goal.id}`, tove)).json().goal;
    expect(view.stages.map((stage: { id: string }) => stage.id)).toEqual([first.id, second.json().task.id]);
    expect(view.progress).toMatchObject({ total: 2, verified: 0, active: 2, percent: 0, status: "in_progress" });
    // Trusted agents share one picture of what is in work.
    expect((await call("GET", "/goals", factory)).json().goals.map((item: { id: string }) => item.id)).toContain(goal.id);
  });

  it("refuses unknown goals, stages of another goal and closing with open stages", async () => {
    const goal = (await call("POST", "/goals", tove, { title: "Вторая цель" })).json().goal as { id: string };
    const other = (await call("POST", "/goals", tove, { title: "Третья цель" })).json().goal as { id: string };
    const stage = (await call("POST", "/tasks", tove, { goal: "Этап второй цели", workspace, goalId: goal.id, allowDuplicate: true })).json().task as AgentTask;
    expect((await call("POST", "/tasks", tove, { goal: "Чужой порядок", workspace, goalId: other.id, after: [stage.id], allowDuplicate: true })).statusCode).toBe(400);
    expect((await call("POST", "/tasks", tove, { goal: "Нет цели", workspace, goalId: "g-20261104-deadbeef" })).statusCode).toBe(404);
    expect((await call("POST", "/tasks", tove, { goal: "Плохой id", workspace, goalId: "goal-1" })).statusCode).toBe(400);
    expect((await call("POST", `/goals/${goal.id}/close`, tove, { state: "done" })).statusCode).toBe(409);
    expect((await call("POST", `/goals/${goal.id}/close`, factory, { state: "cancelled" })).statusCode).toBe(403);

    const cancelled = await call("POST", `/goals/${goal.id}/close`, tove, { state: "cancelled", note: "передумал" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().goal.state).toBe("cancelled");
    expect(ops.tasks.get(stage.id)?.cancelRequestedAt ?? ops.tasks.get(stage.id)?.state).toBeTruthy();
    expect((await call("POST", "/tasks", tove, { goal: "Поздний этап", workspace, goalId: goal.id, allowDuplicate: true })).statusCode).toBe(409);
  });

  it("derives the goal status from its stages", () => {
    const stage = (state: AgentTask["state"]) => ({ state }) as AgentTask;
    expect(goalProgress([stage("verified"), stage("verified"), stage("cancelled")])).toMatchObject({ percent: 100, status: "all_accepted" });
    expect(goalProgress([stage("verified"), stage("blocked")])).toMatchObject({ percent: 50, status: "needs_owner", needsOwner: 1 });
    expect(goalProgress([stage("verified"), stage("failed")])).toMatchObject({ percent: 50, status: "stalled" });
  });
});
