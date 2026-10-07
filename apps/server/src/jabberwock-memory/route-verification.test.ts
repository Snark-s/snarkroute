import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge, type SupervisorAgentRuntime } from "./supervisor-bridge";
import { RouteRunner } from "./route-runner";
import { AtomicWorkspaceTools } from "./atomic-tools";
const roots: string[] = [], memories: JabberwockMemoryService[] = [];
afterEach(async () => { for (const memory of memories.splice(0)) memory.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(model: SupervisorAgentRuntime, disk = false) {
  const root = await mkdtemp(join(tmpdir(), "route-bounded-")); roots.push(root);
  await writeFile(join(root, "code.ts"), "function active() {}\n");
  const database = disk ? join(root, "memory.sqlite") : ":memory:";
  const memory = new JabberwockMemoryService(database); memories.push(memory);
  const project = memory.create_project({ name: "Bounded", root_path: root });
  const task = memory.create_task({ project_id: project.id, title: "Check", original_request: "Inspect and repair" });
  const bridge = new SupervisorBridge(memory, { textRuntime: model, router: { route: async input => ({ mode: input.routingMode, model: input.model! }) } });
  const runner = new RouteRunner(memory, bridge);
  return { root, database, memory, task, runner };
}
const verdict = (value: string, counterevidence: string[] = []) => ({ response: JSON.stringify({ verdict: value, reason: "Actual source checked", evidence: ["code.ts"], counterevidence }) });
const steps = [{ title: "Check", instruction: "Verify active call", acceptanceCriteria: ["Actual active() call exists"] }];
const executionConfig = { routingMode: "fixed" as const, model: "executor", permissions: "read_write" as const };
describe("Route Runner bounded verification integration", () => {
  it("maps a separate verifier timeout to unknown/BLOCKED after one check, retaining the original route and history on continuation", async () => {
    let timeout = true, executions = 0, verifications = 0;
    const f = await setup({ execute: async input => {
      if (input.phase !== "verification") { executions++; expect(input.routing.model).toBe("executor"); return { response: '{"content":"Done","tool_actions":[]}' }; }
      verifications++; expect(input.routing.model).toBe("verifier");
      if (timeout) return new Promise((_, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      return verdict("accepted");
    } }, true);
    const config = { timeoutMs: 20, executionConfig: { routingMode: "fixed" as const, model: "verifier" }, policies: [{ stepIndex: 0, sources: [{ path: "code.ts" }] }] };
    const route = f.runner.create_route({ taskId: f.task.id, steps, executionConfig, verificationConfig: config });
    await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "blocked", completedSteps: 0, blockedReason: { code: "verification_unknown" }, verification: [{ model: "verifier", verdict: "unknown" }] });
    expect(executions).toBe(1); expect(verifications).toBe(1);
    const persisted = new JabberwockMemoryService(f.database); memories.push(persisted);
    expect(persisted.get_route(route.id)?.verificationConfig).toEqual(config);
    timeout = false; f.runner.continue_route({ routeId: route.id, resolution: "Verifier is now available; inspect existing effects." });
    await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ id: route.id, status: "completed", completedSteps: 1 });
    expect(executions).toBe(1); expect(f.memory.list_runs_for_step(route.steps[0].id)).toHaveLength(3);
  });
  it("uses deterministic counterevidence to require bounded corrective execution while preserving an earlier accepted step", async () => {
    let executions = 0;
    const f = await setup({ execute: async input => {
      if (input.phase === "verification") return verdict("accepted");
      executions++;
      if (input.instruction.includes("Repair")) {
        const tools = await AtomicWorkspaceTools.create(input.rootPath, "read_write");
        await tools.execute({ name: "fs.patch", arguments: { path: "code.ts", old: "function active() {}\n", new: "function active() {}\nactive();\n" } });
      }
      return { response: '{"content":"Done","tool_actions":[]}' };
    } });
    const route = f.runner.create_route({ taskId: f.task.id, autoStart: false, steps: [steps[0], { ...steps[0], instruction: "Repair missing call" }], executionConfig,
      verificationConfig: { policies: [{ stepIndex: 1, sources: [{ path: "code.ts", uniqueSymbol: "active", requiredCalls: ["active"] }] }] } });
    f.memory.complete_step(route.steps[0].id, "Earlier accepted progress"); f.memory.update_route_step(route.steps[0].id, { status: "completed", attempts: 1 });
    f.memory.update_route_step(route.steps[1].id, { needsVerification: true, attempts: 1, status: "blocked" });
    f.memory.update_route(route.id, { status: "blocked", blockedReason: { code: "old", failedStep: route.steps[1].id, attempts: 1, blockedReason: "Missing wiring", evidence: [], question: "Resolve" } });
    f.runner.continue_route({ routeId: route.id, resolution: "Inspect existing effects and repair the missing lifecycle calls." });
    await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "completed", completedSteps: 2, retries: 1 });
    expect(executions).toBe(1); expect(await readFile(join(f.root, "code.ts"), "utf8")).toContain("active();");
    const runs = f.memory.list_runs_for_step(route.steps[1].id);
    expect(runs[0].metadata.runtime).toMatchObject({ verificationVerdict: "rejected", modelCalls: 0 });
    expect(f.memory.get_route(route.id)?.steps[0].result_summary).toBe("Earlier accepted progress");
  });
});
