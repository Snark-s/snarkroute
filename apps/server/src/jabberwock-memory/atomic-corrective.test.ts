import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge } from "./supervisor-bridge";
import { AtomicWorkspaceTools } from "./atomic-tools";
import { RouteRunner } from "./route-runner";
import { makeRepairTarget, selectRepairTarget, targetMadeProgress } from "./repair-target";
import { continueRouteSchema } from "./route-input";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const baseline = 'export function setActive(active: boolean) { return active; }\nexport const events = new EventTarget();\nexport function saveState(state: string) { return state; }\nexport function saveKey(key: string) { return key; }\n';
const fixes: Record<string, string> = { setActive: 'setActive(true);', "events.addEventListener": 'events.addEventListener("change", () => {});', saveState: 'saveState("started");', saveKey: 'saveKey("job:active");' };
async function fixture(protocol: "json" | "native", stall = false, behavior: "source" | "ignoreFailures" | "regress" | "failRuntime" | "externalAfterRepair" | "bareLiteral" = "source") {
  const root = await mkdtemp(join(tmpdir(), "atomic-repair-test-"));
  const db = join(root, "memory.sqlite");
  const memory = new JabberwockMemoryService(db);
  let open = true;
  cleanup.push(async () => { if (open) memory.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "probe.ts"), baseline);
  const project = memory.create_project({ name: "Atomic", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Check source", original_request: "Verify source" });
  const bridge = new SupervisorBridge(memory, { router: { route: async () => ({ mode: "fixed", model: "fake" }) }, runtime: { execute: async input => {
    if (input.phase === "verification") {
      const counterevidence = behavior === "ignoreFailures" ? [] : [...(input.verification?.counterevidence ?? [])];
      if (behavior === "externalAfterRepair" && !counterevidence.some(value => value.includes("setActive has 0"))) counterevidence.push("Missing remote credential");
      return { response: JSON.stringify({ verdict: counterevidence.length ? "rejected" : "accepted", reason: "Actual full AST inspection", evidence: input.verification?.evidence, counterevidence }), metadata: { boundedVerifier: true, toolEvidence: input.verification?.toolEvidence } };
    }
    const tools = await AtomicWorkspaceTools.create(root, input.permissions);
    if (input.instruction.startsWith("CORRECTIVE EXECUTION")) {
      const target = JSON.parse(input.instruction.split("\n").find(line => line.startsWith("repairTarget: "))!.slice(14));
      expect(input.instruction.split("\n").filter(line => line.startsWith("repairTarget: "))).toHaveLength(1);
      expect(target).toMatchObject({ repairability: "auto", expectedCondition: { type: "call_count" }, actualEvidence: { sourceHash: expect.any(String) } });
      for (const other of Object.keys(fixes).filter(subject => subject !== target.subject)) expect(input.instruction).not.toContain(`"subject":"${other}"`);
      expect(input.toolProtocol).toBe(protocol);
      if (behavior === "failRuntime") { input.onProgress?.({ toolsUsed: ["fs.read"] }); throw new Error("Executor failed before mutation"); }
      if (!stall) {
        const old = await readFile(join(root, "probe.ts"), "utf8");
        const content = behavior === "regress" && target.subject === "events.addEventListener" ? old.replace(fixes.setActive + "\n", "") : old;
        const call = { name: "fs.patch", arguments: { path: "probe.ts", old, new: content + fixes[target.subject] + "\n" } };
        const intent = await tools.mutationIntent(call); const result = await tools.execute(call);
        return { response: "One target corrected", metadata: { mutationEvents: [{ ...intent, state: "finished", success: result.success }], toolEvidence: [result] } };
      }
    }
    return { response: "Inspected", metadata: { toolsUsed: ["fs.read"], toolEvidence: [await tools.execute({ name: "fs.read", arguments: { path: "probe.ts" } })] } };
  } } });
  const runner = new RouteRunner(memory, bridge);
  const requiredCalls = behavior === "bareLiteral" ? ["setActive", "events.addEventListener"] : ["setActive", "events.addEventListener",
    { callee: "saveState", arguments: [{ index: 0, equals: "started" }] }, { callee: "saveKey", arguments: [{ index: 0, stringContains: "job:" }] }];
  const route = runner.create_route({ taskId: task.id, autoStart: false, executionConfig: { routingMode: "fixed", model: "fake", runtimeMode: "agent", permissions: "read_write", toolProtocol: protocol, correctiveExecution: { stepIndexes: [0] } }, verificationConfig: { policies: [{ stepIndex: 0, sources: [{ path: "probe.ts", uniqueSymbol: "setActive", requiredCalls, ...(behavior === "bareLiteral" ? { requiredLiterals: ["job:"] } : {}) }] }] }, steps: [{ title: "Verify", instruction: "Inspect probe.ts", acceptanceCriteria: ["All original source policy clauses pass"], maxAttempts: 6 }] });
  runner.start_route(route.id); await runner.wait(route.id);
  return { memory, runner, bridge, route, db, closeMemory: () => { memory.close(); open = false; } };
}
it.each(["json", "native"] as const)("repairs A/B/C/D separately with full verification after each in %s", async protocol => {
  const f = await fixture(protocol);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "completed", completedSteps: 1 });
  const runs = f.memory.list_runs_for_step(f.route.steps[0].id);
  expect(runs).toHaveLength(10);
  const repairs = runs.filter(run => (run.metadata.runtime as any).executionKind === "repair");
  expect(repairs.map(run => (run.metadata.runtime as any).repairTarget.subject)).toEqual(Object.keys(fixes));
  for (const repair of repairs) {
    const meta = repair.metadata.runtime as any;
    expect(meta).toMatchObject({ targetAttemptNumber: 1, targetResolved: true, noProgress: false });
    expect(meta.verificationRunId).toBe(runs[runs.indexOf(repair) - 1].id);
    expect(meta.resultVerificationRunId).toBe(runs[runs.indexOf(repair) + 1].id);
    expect(meta.failedCriterion).toContain("sources[0]");
  }
  expect(JSON.parse(runs[1].response).counterevidence).toHaveLength(4);
  expect(JSON.parse(runs[3].response).counterevidence).toHaveLength(3);
  expect(JSON.parse(runs[9].response).verdict).toBe("accepted");
  const persisted = new JabberwockMemoryService(f.db);
  try {
    const saved = persisted.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any).executionKind === "repair");
    expect(saved.map(run => (run.metadata.runtime as any).repairTarget)).toEqual(repairs.map(run => (run.metadata.runtime as any).repairTarget));
    expect((saved[2].metadata.runtime as any).repairTarget).toMatchObject({ expectedCondition: { arguments: [{ index: 0, equals: "started" }] }, supportingFailures: [expect.objectContaining({ argumentIndex: 0 })], repairability: "auto" });
  } finally { persisted.close(); }
});
it("retains per-target no-progress and lifetime attempts across a SQLite reopen and continuation", async () => {
  const f = await fixture("native", true);
  const before = f.memory.get_route(f.route.id)!;
  expect(before).toMatchObject({ status: "blocked", blockedReason: { code: "repair_target_stalled", targetAttempts: 2, model: "fake", repairTarget: { subject: "setActive" } } });
  expect(before.steps[0].attempts).toBe(3);
  const old = f.memory.list_runs_for_step(before.steps[0].id);
  await f.runner.close(); f.closeMemory();
  const reopened = new JabberwockMemoryService(f.db);
  cleanup.unshift(async () => reopened.close());
  const runner = new RouteRunner(reopened, new SupervisorBridge(reopened, { router: { route: async () => ({ mode: "fixed", model: "fake" }) }, runtime: { execute: async input => {
    if (input.phase !== "verification") throw new Error("Stalled target must not execute again");
    return { response: JSON.stringify({ verdict: "rejected", reason: "Actual AST remains wrong", evidence: input.verification?.evidence, counterevidence: input.verification?.counterevidence }), metadata: { boundedVerifier: true, toolEvidence: input.verification?.toolEvidence } };
  } } }));
  runner.continue_route({ routeId: before.id, resolution: "Retain target stall boundary", additionalAttempts: 5 });
  await runner.wait(before.id);
  expect(reopened.get_route(before.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_target_stalled" } });
  expect(reopened.get_route(before.id)?.steps[0]).toMatchObject({ attempts: 3, maxAttempts: 8 });
  expect((reopened.list_runs_for_step(before.steps[0].id)[2].metadata.runtime as any).repairTarget).toMatchObject({ expectedCondition: { type: "call_count", callee: "setActive", min: 1 }, actualEvidence: { observedCount: 0 }, repairability: "auto" });
  expect(reopened.list_runs_for_step(before.steps[0].id).filter(run => old.some(previous => previous.id === run.id))).toEqual(old);
});
it("orders syntax/symbol/call deterministically and defers process receipts behind unanchored literals", () => {
  const target = (kind: any, subject: string) => makeRepairTarget(0, { kind, subject, failure: "failed", criterionReference: "policy" });
  const process = target("process_receipt", "build"), literal = target("missing_literal", "started"), call = target("missing_call", "setActive"), symbol = target("symbol_count", "setActive"), syntax = target("source_syntax", "syntax");
  expect(selectRepairTarget([process, literal, call, symbol, syntax])).toEqual(syntax);
  expect(selectRepairTarget([process, literal, call])).toEqual(call);
  expect(selectRepairTarget([process])).toEqual(process);
  expect(selectRepairTarget([process, literal])).toBeUndefined();
  expect(makeRepairTarget(0, { ...call, failure: "changed count" }).id).toBe(call.id);
});
it("stops on bare missing literal after semantic targets resolve without authorizing token insertion", async () => {
  const f = await fixture("native", false, "bareLiteral");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_scope_unknown", evidence: ["probe.ts: lifecycle literal job: absent."] } });
  const repairs = f.memory.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any).executionKind === "repair");
  expect(repairs.map(run => (run.metadata.runtime as any).repairTarget.subject)).toEqual(["setActive", "events.addEventListener"]);
});
it("bounds explicit continuation budgets", () => {
  expect(continueRouteSchema.safeParse({ resolution: "Approved", additionalAttempts: 5 }).success).toBe(true);
  for (const additionalAttempts of [0, 9, 1.5]) expect(continueRouteSchema.safeParse({ resolution: "Approved", additionalAttempts }).success).toBe(false);
});
it("keeps full source policy authoritative when a verifier incorrectly claims acceptance", async () => {
  const f = await fixture("native", false, "ignoreFailures");
  expect(f.runner.get_route_state(f.route.id).status).toBe("completed");
  const repairs = f.memory.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any).executionKind === "repair");
  expect(repairs.map(run => (run.metadata.runtime as any).repairTarget.subject)).toEqual(Object.keys(fixes));
});
it("blocks a previously resolved target that reappears instead of selecting it again", async () => {
  const f = await fixture("native", false, "regress");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_target_regressed", repairTarget: { subject: "setActive" }, targetAttempts: 1 } });
  expect(f.memory.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any).executionKind === "repair")).toHaveLength(2);
});
it("persists target identity and attempt numbers through progress updates and executor errors", async () => {
  const f = await fixture("native", false, "failRuntime");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_target_stalled", targetAttempts: 2, toolsUsed: ["fs.read"] } });
  const repairs = f.memory.list_runs_for_step(f.route.steps[0].id).filter(run => (run.metadata.runtime as any).executionKind === "repair");
  expect(repairs.map(run => (run.metadata.runtime as any).targetAttemptNumber)).toEqual([1, 2]);
  expect(repairs.every(run => run.status === "failed" && (run.metadata.runtime as any).repairTarget.subject === "setActive" && (run.metadata.runtime as any).resultVerificationRunId)).toBe(true);
});
it("retains a resolved source target when the full verifier finds an external blocker", async () => {
  const f = await fixture("native", false, "externalAfterRepair");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_scope_unknown" } });
  const repair = f.memory.list_runs_for_step(f.route.steps[0].id).find(run => (run.metadata.runtime as any).executionKind === "repair")!;
  expect(repair.metadata.runtime).toMatchObject({ repairTarget: { subject: "setActive" }, targetResolved: true, noProgress: false });
});
it("recognizes measured source progress without treating unrelated mutations as progress", () => {
  const before = makeRepairTarget(0, { kind: "symbol_count", path: "probe.ts", subject: "helper", failure: "3 implementations", criterionReference: "source", observedCount: 3, expectedCount: 1 });
  expect(targetMadeProgress(before, { ...before, observedCount: 2 })).toBe(true);
  expect(targetMadeProgress(before, { ...before, observedCount: 4 })).toBe(false);
  expect(targetMadeProgress(before, { ...before, failure: "Different text", observedCount: 3 })).toBe(false);
  expect(targetMadeProgress(before, undefined)).toBe(true);
});
