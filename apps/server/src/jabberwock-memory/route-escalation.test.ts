import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge } from "./supervisor-bridge";
import { RouteRunner } from "./route-runner";
import { AtomicWorkspaceTools } from "./atomic-tools";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(fixAt = Infinity, minCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "route-escalation-"));
  const db = join(root, "memory.sqlite");
  const memory = new JabberwockMemoryService(db);
  cleanup.push(async () => { memory.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "code.ts"), "function setActive(active:boolean){return active;}\n");
  const project = memory.create_project({ name: "Escalation", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Activity", original_request: "Wire actual activity" });
  let repairs = 0;
  const runtime = { execute: vi.fn(async (input: any) => {
    if (input.phase === "verification") return { response: JSON.stringify({ verdict: "accepted", summary: "Independent source checked", evidence: ["AST inspected"] }),
      metadata: { toolEvidence: input.verification?.toolEvidence, toolsUsed: ["fs.read"] } };
    const tools = await AtomicWorkspaceTools.create(root, "read_write");
    if (input.instruction.startsWith("CORRECTIVE EXECUTION") && (++repairs === fixAt || minCount > 1)) {
      const old = await readFile(join(root, "code.ts"), "utf8");
      const action = { name: "fs.patch", arguments: { path: "code.ts", old, new: old + "setActive(true);\n" } };
      const intent = await tools.mutationIntent(action); const result = await tools.execute(action);
      return { response: "Fixed", metadata: { mutationEvents: [{ ...intent, state: "finished", success: result.success }], toolEvidence: [result] } };
    }
    return { response: "Read", metadata: { toolEvidence: [await tools.execute({ name: "fs.read", arguments: { path: "code.ts" } })] } };
  }) };
  const bridge = new SupervisorBridge(memory, { runtime, router: { route: async () => ({ mode: "fixed", model: "local" }) } });
  const runner = new RouteRunner(memory, bridge);
  const route = runner.create_route({ taskId: task.id, executionConfig: { routingMode: "fixed", model: "local", runtimeMode: "agent", permissions: "read_write", correctiveExecution: { stepIndexes: [0] } },
    verificationConfig: { policies: [{ stepIndex: 0, sources: [{ path: "code.ts", uniqueSymbol: "setActive", requiredCalls: minCount === 1 ? ["setActive"] : [{ callee: "setActive", minCount }] }] }] },
    steps: [{ title: "Wire activity", instruction: "Wire helper in code.ts", acceptanceCriteria: ["Actual call exists"], maxAttempts: 6 },
      { title: "Next", instruction: "Inspect result", acceptanceCriteria: ["Result inspected"] }] });
  await runner.wait(route.id);
  return { root, db, memory, task, runtime, bridge, runner, route, repairs: () => repairs };
}
it.each([1, 2])("local repair success on attempt %s continues the same route", async fixAt => {
  const f = await fixture(fixAt);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "completed", completedSteps: 2 });
  expect(f.repairs()).toBe(fixAt);
});
it("two unresolved attempts escalate with evidence and never execute a third repair", async () => {
  const f = await fixture();
  expect(f.repairs()).toBe(2);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { kind: "coding_escalation" } });
  const packet = f.runner.get_escalation(f.route.id)!;
  expect(packet).toMatchObject({ routeId: f.route.id, taskId: f.task.id, stepId: f.route.steps[0].id, originalGoal: "Wire actual activity",
    repairTarget: { subject: "setActive" }, expectedCondition: { type: "call_count", callee: "setActive" }, model: "local" });
  expect(packet.localAttempts).toHaveLength(2);
  expect(packet.counterevidence.join(" ")).toContain("0 actual calls");
  expect(packet.relevantSourcePaths).toContain("code.ts");
  expect(packet.acceptanceCriteria).toEqual(["Actual call exists"]);
  expect(packet.recommendedVerification).toBeTruthy();
  expect(packet.reason).toContain("two");
  const runs = f.memory.list_runs_for_step(f.route.steps[0].id);
  f.runner.continue_route({ routeId: f.route.id, resolution: "Try again" }); await f.runner.wait(f.route.id);
  expect(f.repairs()).toBe(2);
  expect(f.memory.list_runs_for_step(f.route.steps[0].id).filter(r => runs.some(old => old.id === r.id))).toEqual(runs);
});
it("external resolution cannot auto-pass despite a verifier model claiming acceptance", async () => {
  const f = await fixture(); const old = f.memory.list_runs_for_step(f.route.steps[0].id);
  f.runner.continue_route({ routeId: f.route.id, resolution: "Claimed fixed", externalResolution: { stepId: f.route.steps[0].id, evidence: ["I fixed it"], changedFiles: ["code.ts"] } });
  await f.runner.wait(f.route.id);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { kind: "coding_escalation", code: "external_resolution_rejected" } });
  expect(f.repairs()).toBe(2);
  const runs = f.memory.list_runs_for_step(f.route.steps[0].id);
  expect(runs.filter(r => old.some(previous => previous.id === r.id))).toEqual(old);
  expect(runs.find(r => (r.metadata.runtime as any)?.executionKind === "external_resolution")?.metadata.runtime).toMatchObject({ externalVerification: "rejected" });
  expect(f.memory.get_task_context(f.task.id)!.decisions.at(-1)?.text).toBe("Claimed fixed");
});
it("independent verification accepts an external change then advances without replay", async () => {
  const f = await fixture(); const old = f.memory.list_runs_for_step(f.route.steps[0].id);
  await writeFile(join(f.root, "code.ts"), (await readFile(join(f.root, "code.ts"), "utf8")) + "setActive(true);\n");
  const calls = f.runtime.execute.mock.calls.length;
  f.runner.continue_route({ routeId: f.route.id, resolution: "External wiring applied", externalResolution: { stepId: f.route.steps[0].id, evidence: ["Actual source edited"], changedFiles: ["code.ts"] } });
  await f.runner.wait(f.route.id);
  expect(f.runtime.execute.mock.calls[calls][0].phase).toBe("verification");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "completed", completedSteps: 2, changedFiles: ["code.ts"] });
  expect(f.repairs()).toBe(2);
  expect(f.memory.list_runs_for_step(f.route.steps[0].id).filter(r => old.some(previous => previous.id === r.id))).toEqual(old);
});
it("escalation survives reopening and remains cancellable", async () => {
  const f = await fixture(); await f.runner.close();
  const reopened = new JabberwockMemoryService(f.db);
  try {
    const runner = new RouteRunner(reopened, new SupervisorBridge(reopened)); runner.recover();
    expect(runner.get_escalation(f.route.id)).toEqual(f.runner.get_escalation(f.route.id));
    runner.cancel_route(f.route.id);
    expect(runner.get_route_state(f.route.id).status).toBe("cancelled");
    expect(() => runner.continue_route({ routeId: f.route.id, resolution: "Late", externalResolution: { stepId: f.route.steps[0].id, evidence: ["Late"], changedFiles: [] } })).toThrow();
  } finally { reopened.close(); }
});
it("external resolution is bound to the blocked step", async () => {
  const f = await fixture();
  expect(() => f.runner.continue_route({ routeId: f.route.id, resolution: "Wrong step", externalResolution: { stepId: f.route.steps[1].id, evidence: ["Claim"], changedFiles: [] } })).toThrow();
  expect(f.memory.get_task_context(f.task.id)!.decisions).toHaveLength(0);
});
it("an unknown external verification stays escalated instead of retrying the executor", async () => {
  const f = await fixture();
  f.runtime.execute.mockImplementation(async () => ({ response: "No assessment", metadata: { toolsUsed: ["fs.read"] } }) as any);
  f.runner.continue_route({ routeId: f.route.id, resolution: "External result", externalResolution: { stepId: f.route.steps[0].id, evidence: ["Submitted"], changedFiles: [] } });
  await f.runner.wait(f.route.id);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { kind: "coding_escalation", code: "external_resolution_unverified" } });
  expect(f.repairs()).toBe(2);
});
it("escalates after two unresolved attempts even when both made partial source progress", async () => {
  const f = await fixture(Infinity, 3);
  expect(f.repairs()).toBe(2);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { kind: "coding_escalation", targetAttempts: 2 } });
  const runs = f.memory.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any)?.executionKind === "repair");
  expect(runs.map(run => (run.metadata.runtime as any).noProgress)).toEqual([false, false]);
  expect(runs.map(run => (run.metadata.runtime as any).targetResolved)).toEqual([false, false]);
});
