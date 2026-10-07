import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge, type SupervisorAgentRuntime } from "./supervisor-bridge";
import { AtomicWorkspaceTools } from "./atomic-tools";
import { RouteRunner } from "./route-runner";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const baseline = 'export function setActive(active: boolean) { return active; }\nexport const events = new EventTarget();\n';
const addition = '\nevents.addEventListener("status", () => setActive(true));\n';
async function fixture(protocol: "native" | "json" = "native", permissions: "read_write" | "read_only" = "read_write", repair = true, indexes = [1], externalFailure = false) {
  const root = await mkdtemp(join(tmpdir(), "corrective-semantics-"));
  const memory = new JabberwockMemoryService(":memory:");
  cleanups.push(async () => { memory.close(); await rm(root, { recursive: true, force: true }); });
  const project = memory.create_project({ name: "Disposable", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Lifecycle", original_request: "Implement and verify event wiring" });
  await writeFile(join(root, "probe.ts"), baseline);
  const execute = vi.fn<Parameters<SupervisorAgentRuntime["execute"]>, ReturnType<SupervisorAgentRuntime["execute"]>>(async input => {
    if (input.phase === "verification" && externalFailure && input.instruction.includes("Verify lifecycle wiring")) return {
      response: JSON.stringify({ verdict: "rejected", reason: "External failure", evidence: ["Inspected source"], counterevidence: ["Missing remote credential"] }),
      metadata: { boundedVerifier: true, toolEvidence: input.verification?.toolEvidence } };
    if (input.phase === "verification") return { response: JSON.stringify({ verdict: input.verification?.counterevidence.length ? "rejected" : "accepted",
      reason: "Checked actual AST", evidence: input.verification?.evidence ?? ["Inspected final source"], counterevidence: input.verification?.counterevidence ?? [] }),
      metadata: { boundedVerifier: true, toolsUsed: ["fs.read"], toolEvidence: input.verification?.toolEvidence ?? [{ name: "fs.read", success: true }] } };
    if (input.instruction.includes("Create the helper")) { if (input.permissions === "read_write") await writeFile(join(root, "probe.ts"), baseline); return { response: "Incomplete helper present" }; }
    const tools = await AtomicWorkspaceTools.create(root, input.permissions);
    if (input.instruction.startsWith("CORRECTIVE EXECUTION") && repair) {
      const call = { name: "fs.patch", arguments: { path: "probe.ts", old: baseline, new: baseline + addition } };
      const intent = await tools.mutationIntent(call);
      const result = await tools.execute(call);
      return { response: "Repaired; inspect actual source", metadata: { mutationEvents: [{ ...intent, state: "finished", success: result.success }], toolEvidence: [result] } };
    }
    return { response: "Inspected current source", metadata: { toolEvidence: [await tools.execute({ name: "fs.read", arguments: { path: "probe.ts" } })] } };
  });
  const runner = new RouteRunner(memory, new SupervisorBridge(memory, { runtime: { execute }, router: { route: async () => ({ mode: "fixed", model: "fake" }) } }));
  const route = runner.create_route({ taskId: task.id, autoStart: false,
    executionConfig: { routingMode: "fixed", model: "fake", runtimeMode: "agent", permissions, toolProtocol: protocol, correctiveExecution: { stepIndexes: indexes } },
    verificationConfig: { policies: [{ stepIndex: 0, sources: [{ path: "probe.ts", uniqueSymbol: "setActive" }] },
      { stepIndex: 1, sources: [{ path: "probe.ts", uniqueSymbol: "setActive", requiredCalls: ["setActive", "events.addEventListener"], requiredLiterals: ["status"] }] }] },
    steps: [{ title: "Action", instruction: "Create the helper, leaving wiring for later", acceptanceCriteria: ["One helper exists"] },
      { title: "Verify lifecycle wiring", instruction: "Verify lifecycle wiring", acceptanceCriteria: ["Helper has a call site and status event listener"], maxAttempts: 3 },
      { title: "Finish", instruction: "Inspect final source", acceptanceCriteria: ["Finished"] }] });
  runner.start_route(route.id); await runner.wait(route.id);
  return { root, memory, runner, route, execute };
}
it.each(["json", "native"] as const)("turns rejected verification into bounded repair and re-verification in %s", async protocol => {
  const f = await fixture(protocol);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "completed", completedSteps: 3 });
  const repair = f.execute.mock.calls.map(([input]) => input).find(input => input.instruction.startsWith("CORRECTIVE EXECUTION"))!;
  expect(repair).toBeDefined(); expect(repair.instruction).toContain("Modify the workspace");
  expect(repair.instruction).toContain("Do not merely re-verify"); expect(repair.instruction).toContain("setActive has 0 actual calls");
  expect(repair.instruction).toContain("Helper has a call site and status event listener"); expect(repair.toolProtocol).toBe(protocol);
  expect(repair.phase).toBe("execution"); expect(repair.permissions).toBe("read_write");
  expect(await readFile(join(f.root, "probe.ts"), "utf8")).toContain(addition);
  const runs = f.memory.list_runs_for_step(f.route.steps[1].id);
  expect(runs).toHaveLength(4); expect(JSON.parse(runs[1].response).verdict).toBe("rejected");
  expect(JSON.parse(runs[3].response).verdict).toBe("accepted"); expect((runs[2].metadata.runtime as any).executionKind).toBe("repair");
  expect(f.memory.get_route(f.route.id)?.steps[0].accepted).toBe(true);
  expect(f.execute.mock.calls[0][0].instruction).toMatch(/^Create the helper/);
});
it("blocks read_only remediation without increasing mutation capability", async () => {
  const f = await fixture("native", "read_only");
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_requires_read_write" } });
  expect(f.execute.mock.calls.some(([input]) => input.instruction.startsWith("CORRECTIVE EXECUTION"))).toBe(false);
  expect(await readFile(join(f.root, "probe.ts"), "utf8")).toBe(baseline);
});
it("does not turn an excluded observational step into an editor", async () => {
  const f = await fixture("native", "read_write", true, []);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "remediation_not_allowed" } });
  expect(f.execute.mock.calls.some(([input]) => input.instruction.startsWith("CORRECTIVE EXECUTION"))).toBe(false);
});
it("re-verifies a claimed repair and stops the same target after two attempts without progress", async () => {
  const f = await fixture("native", "read_write", false);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", completedSteps: 1, blockedReason: { code: "repair_target_stalled", attempts: 3, targetAttempts: 2 } });
  expect(f.memory.list_runs_for_step(f.route.steps[1].id)).toHaveLength(6);
  expect(f.execute.mock.calls.filter(([input]) => input.instruction.startsWith("CORRECTIVE EXECUTION"))).toHaveLength(2);
});
it("does not treat an unconfirmed external rejection as a workspace repair", async () => {
  const f = await fixture("native", "read_write", true, [1], true);
  expect(f.runner.get_route_state(f.route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "repair_scope_unknown" } });
  expect(f.execute.mock.calls.some(([input]) => input.instruction.startsWith("CORRECTIVE EXECUTION"))).toBe(false);
  expect(await readFile(join(f.root, "probe.ts"), "utf8")).toBe(baseline);
});
