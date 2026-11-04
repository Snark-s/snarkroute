import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentOps, type AgentOps } from "../agent-ops";
import { ActivityMonitor } from "../agent-ops/activity";
import type { ExecutorAdapter, ExecutorProfile } from "../agent-ops/executors";
import { parsePlan } from "./service";

const profile: ExecutorProfile = { kinds: ["text", "analysis", "code_edit", "agent_tool"], editsFiles: true, shell: true, maxContextTokens: 100_000, quality: "high", pause: "none", costTier: "subscription", order: 1 };
const idleExecutor: ExecutorAdapter = {
  id: "codex_cli", label: "fake codex", profile,
  probe: async () => ({ installed: true, authenticated: true, checkedAt: new Date().toISOString(), source: "fake" }),
  resourceRequest: () => ({ class: "light", cpuSlots: 1 }),
  run: () => new Promise(() => undefined)
};

const plan = (stages: unknown[]) => JSON.stringify({ stages });
const stage = (key: string, after: string[] = []) => ({ key, title: `Этап ${key}`, goal: `Сделать этап ${key} и записать проверяемый результат`, acceptance: [`есть результат ${key}`], after });

describe("D2: Secretary", () => {
  let ops: AgentOps;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-ops-secretary-"));
    ops = await createAgentOps({ directory: join(directory, "data"), workspaceRoots: [join(directory, "data", "sandbox")], adapters: [idleExecutor], tickMs: 60_000,
      activity: new ActivityMonitor(async () => ({ at: new Date().toISOString(), ok: true, totalCpuPercent: 5, processes: [], renders: [] }), 60_000),
      telemetry: async () => ({ memory: { totalMiB: 65536, usedMiB: 8192, freeMiB: 57344 }, cpuCount: 16, capturedAt: new Date().toISOString() }) });
  });

  afterAll(async () => {
    await ops.tasks.drain();
    ops.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("validates plans strictly", () => {
    expect(parsePlan(plan([stage("a"), stage("b", ["a"])])).map(item => item.after)).toEqual([[], ["a"]]);
    expect(() => parsePlan("не json")).toThrow(/JSON/);
    expect(() => parsePlan(plan([]))).toThrow(/от 1 до 12/);
    expect(() => parsePlan(plan([stage("a", ["b"]), stage("b")]))).toThrow(/более позднего/);
    expect(() => parsePlan(plan([stage("a", ["x"])]))).toThrow(/неизвестный/);
    expect(() => parsePlan(plan([{ ...stage("a"), acceptance: [] }]))).toThrow(/критерий/);
    expect(() => parsePlan(plan([stage("a"), stage("a")]))).toThrow(/Повторный/);
  });

  it("registers the goal, plans it, dispatches ordered stages and closes it when all are accepted", async () => {
    const owner = ops.registry.owner("test");
    const message = await ops.secretary.receive(owner, { text: "Найти три заказа на анимацию\nБюджет не трогать", source: "workshop", requestKey: "k1" });
    expect(message.state).toBe("planning");
    expect((await ops.secretary.receive(owner, { text: "другой текст", requestKey: "k1" })).id).toBe(message.id);
    const goal = ops.goals.view(ops.goals.require(message.goalId!, owner));
    expect(goal).toMatchObject({ title: "Найти три заказа на анимацию", assignee: "app:secretary", source: "workshop" });
    const planTask = ops.tasks.get(message.planTaskId!)!;
    expect(planTask.spec.goalId).toBe(goal.id);

    // The executor and the Acceptor are simulated: a bad plan is re-planned, not shown to the owner.
    await writeFile(join(planTask.workdir!, "plan.json"), "{}", "utf8");
    planTask.state = "verified";
    await ops.secretary.tick();
    const replanned = ops.secretary.status().messages[0];
    expect(replanned.planAttempts).toBe(2);
    const secondPlan = ops.tasks.get(replanned.planTaskId!)!;
    await writeFile(join(secondPlan.workdir!, "plan.json"), plan([stage("a"), stage("b", ["a"])]), "utf8");
    secondPlan.state = "verified";
    await ops.secretary.tick();

    const dispatched = ops.secretary.status().messages[0];
    expect(dispatched.state).toBe("dispatched");
    const [a, b] = [ops.tasks.get(dispatched.stageIds!.a)!, ops.tasks.get(dispatched.stageIds!.b)!];
    expect(a.spec.goalId).toBe(goal.id);
    expect(b.dependsOn).toEqual([a.id]);

    a.state = "verified"; b.state = "verified";
    await ops.secretary.tick();
    expect(ops.secretary.status().messages[0].state).toBe("closed");
    expect(ops.goals.require(goal.id, owner).state).toBe("done");
    expect(ops.secretary.status().reports.map(report => report.kind).reverse()).toEqual(["goal_received", "replanned", "plan_ready", "stage_accepted", "stage_accepted", "goal_accepted"]);
  });

  it("does not take goals from anonymous callers", async () => {
    await expect(ops.secretary.receive(ops.registry.anonymous?.() ?? { id: "anonymous", kind: "anonymous", label: "", policy: ops.registry.policyForAgent("anonymous") }, { text: "x" })).rejects.toThrow(/владельца или агента/);
  });
});
