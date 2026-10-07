import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JabberwockMemoryService } from "./service";
import { SupervisorBridge, type SupervisorAgentRuntime } from "./supervisor-bridge";
import { RouteRunner } from "./route-runner";
import { SnarkRouteAtomicAgentRuntime } from "./atomic-agent-runtime";
import { createHash } from "node:crypto";

const memories: JabberwockMemoryService[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const memory of memories.splice(0)) memory.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function assessment(verdict = "accepted", extra = {}) {
  return { response: JSON.stringify({ verdict, summary: "Checked actual state", evidence: ["Read actual file"], ...extra }),
    metadata: { toolsUsed: ["fs.read"], toolCallCount: 1 } };
}
function fixture(execute: SupervisorAgentRuntime["execute"] = async input => input.phase === "verification" ? assessment() : { response: "Done" }, database = ":memory:") {
  const memory = new JabberwockMemoryService(database);
  memories.push(memory);
  memory.set_setting("jabberwock.defaultModel", "bonsai");
  const project = memory.create_project({ name: "Runner", root_path: process.cwd() });
  const task = memory.create_task({ project_id: project.id, title: "Coding", original_request: "Implement and verify" });
  const runtime = { execute: vi.fn(execute) };
  const bridge = new SupervisorBridge(memory, { runtime, router: { route: async input => ({ mode: input.routingMode, model: input.model ?? "bonsai" }) } });
  const runner = new RouteRunner(memory, bridge);
  const create = (count = 2, maxAttempts = 3) => runner.create_route({ taskId: task.id, autoStart: false,
    steps: Array.from({ length: count }, (_, i) => ({ title: `Step ${i}`, instruction: `Do ${i}`, acceptanceCriteria: [`Check ${i}`], maxAttempts })) });
  return { memory, task, runner, create, runtime, bridge };
}

describe("autonomous Route Runner", () => {
  it("persists native execution configuration while forcing verification to read_only/json", async () => {
    const f = fixture(async input => input.phase === "verification" ? assessment() : { response: "done" });
    const route = f.create(1);
    f.memory.update_route(route.id, { executionConfig: { ...route.executionConfig, toolProtocol: "native" } });
    f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).executionConfig.toolProtocol).toBe("native");
    const execution = f.runtime.execute.mock.calls.find(([input]) => input.phase === "execution")![0];
    const verification = f.runtime.execute.mock.calls.find(([input]) => input.phase === "verification")![0];
    expect(execution.toolProtocol).toBe("native");
    expect(verification).toMatchObject({ toolProtocol: "json", permissions: "read_only" });
  });
  it("never recovers an autostart creation rejected by an active legacy execution", async () => {
    const f = fixture();
    const legacy = f.memory.create_step({ task_id: f.task.id, sequence: 0, instruction: "Legacy execution", status: "active" });
    const created = vi.spyOn(f.memory, "create_route");
    expect(() => f.runner.create_route({ taskId: f.task.id, steps: [{ title: "New route", instruction: "Do work", acceptanceCriteria: ["Work checked"] }] })).toThrow("Another execution");
    const routeId = created.mock.results[0].value.id as string;
    expect(f.memory.get_route(routeId)?.status).toBe("failed");
    f.memory.complete_step(legacy.id, "Legacy done");
    f.runner.recover(); await f.runner.wait(routeId);
    expect(f.memory.get_route(routeId)?.status).toBe("failed"); expect(f.runtime.execute).not.toHaveBeenCalled();
  });
  it("blocks for a model decision when three journaled inspections cannot produce any assessment", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-model-assessment-")); directories.push(root);
    await writeFile(join(root, "code.txt"), "before");
    const memory = new JabberwockMemoryService(":memory:"); memories.push(memory); memory.set_setting("jabberwock.defaultModel", "bonsai");
    const project = memory.create_project({ name: "Model budget", root_path: root });
    const task = memory.create_task({ project_id: project.id, title: "Assess", original_request: "Inspect actual file" });
    let executions = 0, checks = 0;
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async input => {
      if (input.phase !== "verification") { executions++; return { response: JSON.stringify({ content: "Draft", tool_actions: [] }) }; }
      checks++;
      return { response: JSON.stringify(checks % 2
        ? { content: "Inspect", tool_actions: [{ name: "fs.read", arguments: { path: "code.txt" } }] }
        : { content: "No structured assessment", tool_actions: [] }) };
    } });
    const runner = new RouteRunner(memory, new SupervisorBridge(memory, { runtime, router: { route: async input => ({ mode: input.routingMode, model: "bonsai" }) } }));
    const route = runner.create_route({ taskId: task.id, steps: [{ title: "Assess", instruction: "Inspect file", acceptanceCriteria: ["Actual content verified"] }], executionConfig: { permissions: "read_write" } });
    await runner.wait(route.id);
    expect(runner.get_route_state(route.id)).toMatchObject({ status: "blocked", retries: 0, blockedReason: { code: "verification_exhausted", attempts: 1 } });
    expect(executions).toBe(1); expect(checks).toBe(6);
    expect(await readFile(join(root, "code.txt"), "utf8")).toBe("before");
  });
  it("repairs inconclusive verification locally when builtin tools journal all effects and inspect actual state", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-inconclusive-")); directories.push(root);
    await writeFile(join(root, "code.txt"), "before");
    const memory = new JabberwockMemoryService(":memory:"); memories.push(memory); memory.set_setting("jabberwock.defaultModel", "bonsai");
    const project = memory.create_project({ name: "Journal", root_path: root });
    const task = memory.create_task({ project_id: project.id, title: "Repair", original_request: "Change before to after" });
    let executions = 0, checks = 0, writes = 0;
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async input => {
      if (input.phase === "verification") {
        checks++;
        if (checks % 2) return { response: JSON.stringify({ content: "Inspect", tool_actions: [{ name: "fs.read", arguments: { path: "code.txt" } }] }) };
        return { response: JSON.stringify({ content: { verdict: writes ? "accepted" : "unknown", summary: "Actual file inspected", evidence: [await readFile(join(root, "code.txt"), "utf8")] }, tool_actions: [] }) };
      }
      executions++;
      if (executions === 2) {
        writes++; return { response: JSON.stringify({ content: "Repair current state", tool_actions: [{ name: "fs.patch", arguments: { path: "code.txt", old: "before", new: "after" } }] }) };
      }
      return { response: JSON.stringify({ content: "Draft inspected", tool_actions: [] }) };
    } });
    const runner = new RouteRunner(memory, new SupervisorBridge(memory, { runtime, router: { route: async input => ({ mode: input.routingMode, model: "bonsai" }) } }));
    const route = runner.create_route({ taskId: task.id, steps: [{ title: "Repair", instruction: "Change before to after", acceptanceCriteria: ["Actual file contains after"] }], executionConfig: { permissions: "read_write" } });
    await runner.wait(route.id);
    expect(runner.get_route_state(route.id)).toMatchObject({ status: "completed", retries: 1 });
    expect(await readFile(join(root, "code.txt"), "utf8")).toBe("after"); expect(writes).toBe(1);
  });
  it("reconciles a failed file tool that actually applied its mutation and records the known changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-failed-write-")); directories.push(root);
    await writeFile(join(root, "code.txt"), "before"); let writes = 0;
    const hash = (content: string) => createHash("sha256").update(content).digest("hex");
    const f = fixture(async input => {
      if (input.phase === "verification") return assessment();
      writes++; await writeFile(join(root, "code.txt"), "after");
      input.onProgress?.({ mutationEvents: [{ tool: "fs.write", path: "code.txt", state: "finished", success: false, beforeHash: hash("before"), afterHash: hash("after") }] });
      throw new Error("Failure after rename");
    });
    const project = f.memory.create_project({ name: "Failed write", root_path: root });
    const task = f.memory.create_task({ project_id: project.id, title: "Write", original_request: "Write after" });
    const route = f.runner.create_route({ taskId: task.id, steps: [{ title: "Write", instruction: "Write after", acceptanceCriteria: ["Actual file contains after"] }] });
    await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "completed", changedFiles: ["code.txt"] }); expect(writes).toBe(1);
    expect(f.memory.list_runs_for_step(route.steps[0].id)[0].metadata.runtime).toMatchObject({ mutationEvents: [{ verification: "applied" }] });
  });
  it("executes, verifies and advances in order, reusing steps and completing without external execute_step calls", async () => {
    const f = fixture(); const route = f.create();
    f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "completed", completedSteps: 2, retries: 0 });
    expect(f.runtime.execute.mock.calls.map(([input]) => [input.instruction.includes("Do 0") ? 0 : 1, input.phase]))
      .toEqual([[0, "execution"], [0, "verification"], [1, "execution"], [1, "verification"]]);
    expect(f.memory.list_task_steps(f.task.id)).toHaveLength(2);
    expect(f.memory.list_runs_for_step(route.steps[0].id)).toHaveLength(2);
  });
  it("repairs an ordinary failure locally and retries after verification", async () => {
    let executions = 0;
    const f = fixture(async input => input.phase === "verification" ? assessment(executions === 1 ? "retry" : "accepted", { safeToRetry: true })
      : (++executions === 1 ? Promise.reject(new Error("Build error")) : { response: "Fixed" }));
    const route = f.create(1); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "completed", retries: 1 });
    expect(executions).toBe(2);
  });
  it("verifies an ambiguous timeout after a real mutation and never repeats the write", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-mutation-")); directories.push(root);
    const file = join(root, "code.txt"); await writeFile(file, "before"); let writes = 0;
    const f = fixture(async input => {
      if (input.phase === "verification") { expect(await readFile(file, "utf8")).toBe("one block"); return assessment(); }
      writes++; await writeFile(file, "one block"); throw new Error("Timeout after write");
    });
    const route = f.create(1); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).status).toBe("completed"); expect(writes).toBe(1);
  });
  it("exhausts attempts into structured BLOCKED and continues from that step with a persisted decision", async () => {
    let accept = false;
    const f = fixture(async input => input.phase === "verification" ? assessment(accept ? "accepted" : "retry", { safeToRetry: true }) : { response: "Draft" });
    const route = f.create(2, 2); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "blocked", blockedReason: { code: "max_attempts", attempts: 2, failedStep: route.steps[0].id } });
    accept = true; f.runner.continue_route({ routeId: route.id, resolution: "Use the approved approach" }); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).status).toBe("completed");
    expect(f.memory.get_task_context(f.task.id)?.decisions).toEqual([expect.objectContaining({ text: "Use the approved approach" })]);
    expect(f.runner.get_route_state(route.id).decisions).toEqual([expect.objectContaining({ text: "Use the approved approach" })]);
  });
  it("aborts running execution on cancel and starts no pending steps", async () => {
    const f = fixture(async input => {
      await new Promise<void>((_, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      return { response: "Never" };
    });
    const route = f.create(); f.runner.start_route(route.id);
    await vi.waitFor(() => expect(f.runtime.execute).toHaveBeenCalledTimes(1));
    f.runner.cancel_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).status).toBe("cancelled");
    expect(f.memory.get_route(route.id)?.steps[1].attempts).toBe(0);
  });
  it("bounds unverifiable model responses and resumes verification with an explicitly approved model", async () => {
    const f = fixture(async input => input.phase === "verification"
      ? input.routing.model === "approved-model" ? assessment() : { response: "I need to read again" }
      : { response: "Draft" });
    const route = f.create(1); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "blocked", blockedReason: {
      code: "verification_exhausted", attempts: 1, evidence: expect.arrayContaining([expect.stringContaining("not valid JSON")])
    } });
    expect(f.runtime.execute).toHaveBeenCalledTimes(4);
    f.runner.continue_route({ routeId: route.id, resolution: "Use the approved local model", executionConfig: {
      routingMode: "fixed", model: "approved-model"
    } });
    await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id)).toMatchObject({ status: "completed", completedSteps: 1 });
    expect(f.runtime.execute).toHaveBeenCalledTimes(5);
    expect(f.memory.get_route(route.id)?.executionConfig).toMatchObject({ routingMode: "fixed", model: "approved-model" });
    expect(f.memory.get_task_context(f.task.id)?.decisions[0].rationale).toContain("approved-model");
  });
  it("claims one route once even across two runner instances", async () => {
    const f = fixture(); const route = f.create();
    const other = new RouteRunner(f.memory, f.bridge);
    f.runner.start_route(route.id); other.start_route(route.id); f.runner.start_route(route.id);
    await f.runner.wait(route.id);
    expect(f.runtime.execute).toHaveBeenCalledTimes(4);
  });
  it("persists progress, recovers interrupted runs and verifies before resuming writes after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-recovery-")); directories.push(root);
    const database = join(root, "working-memory.sqlite"); const f = fixture(undefined, database); const route = f.create();
    f.memory.complete_step(route.steps[0].id, "Already done");
    f.memory.update_route_step(route.steps[0].id, { status: "completed", attempts: 1 });
    f.memory.claim_route(route.id);
    f.memory.update_route_step(route.steps[1].id, { status: "running", attempts: 1, needsVerification: true });
    f.memory.add_run({ step_id: route.steps[1].id, model: "bonsai", prompt: "work", response: "", status: "running" });
    f.memory.close(); memories.splice(memories.indexOf(f.memory), 1);
    const resumed = fixture(undefined, database); resumed.runner.recover(); await resumed.runner.wait(route.id);
    expect(resumed.runner.get_route_state(route.id)).toMatchObject({ status: "completed", completedSteps: 2 });
    expect(resumed.runtime.execute).toHaveBeenCalledTimes(1);
    expect(resumed.runtime.execute.mock.calls[0][0].phase).toBe("verification");
    expect(resumed.memory.list_runs_for_step(route.steps[1].id)[0].status).toBe("interrupted");
  });
  it("blocks an unverifiable mutation instead of blindly repeating it", async () => {
    let writes = 0;
    const f = fixture(async input => input.phase === "verification" ? assessment("unknown") : (++writes, Promise.reject(new Error("Timed out"))));
    const route = f.create(1); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).status).toBe("blocked"); expect(writes).toBe(1);
  });
  it("continues read-only inspection after an inconclusive assessment without escalating or repeating a write", async () => {
    let checks = 0, writes = 0;
    const f = fixture(async input => input.phase === "verification" ? assessment(++checks === 1 ? "unknown" : "accepted")
      : (++writes, { response: "Done" }));
    const route = f.create(1); f.runner.start_route(route.id); await f.runner.wait(route.id);
    expect(f.runner.get_route_state(route.id).status).toBe("completed");
    expect(checks).toBe(2); expect(writes).toBe(1);
  });
  it("retains standalone execute_step and default/fixed routing", async () => {
    const f = fixture(); const result = await f.bridge.supervisorExecuteStep({ taskId: f.task.id, instruction: "Legacy" });
    expect(result.status).toBe("completed"); expect(result.routing).toMatchObject({ mode: "default", model: "bonsai" });
    expect(f.memory.list_runs_for_step(result.stepId)).toHaveLength(1);
  });
  it("journals and verifies a real tool mutation when the next model call times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "route-journal-")); directories.push(root);
    await writeFile(join(root, "code.txt"), "before");
    const memory = new JabberwockMemoryService(":memory:"); memories.push(memory);
    memory.set_setting("jabberwock.defaultModel", "bonsai");
    const project = memory.create_project({ name: "Journal", root_path: root });
    const task = memory.create_task({ project_id: project.id, title: "Coding", original_request: "Write one block" });
    let executions = 0, checks = 0;
    const model: SupervisorAgentRuntime = { execute: async input => {
      if (input.phase === "verification") {
        if (++checks === 1) return { response: JSON.stringify({ content: "Inspect actual file", tool_actions: [{ name: "fs.read", arguments: { path: "code.txt" } }] }) };
        return { response: JSON.stringify({ content: JSON.stringify({ verdict: "accepted", summary: "One block exists", evidence: ["Read actual code.txt: one block"] }), tool_actions: [] }) };
      }
      if (++executions === 1) return { response: JSON.stringify({ content: "Write", tool_actions: [{ name: "fs.write", arguments: { path: "code.txt", content: "one block" } }] }) };
      throw new Error("Ambiguous timeout after mutation");
    } };
    const bridge = new SupervisorBridge(memory, { runtime: new SnarkRouteAtomicAgentRuntime(model), router: { route: async request => ({ mode: request.routingMode, model: "bonsai" }) } });
    const runner = new RouteRunner(memory, bridge);
    const route = runner.create_route({ taskId: task.id, steps: [{ title: "Write", instruction: "Write one block", acceptanceCriteria: ["One block exists"] }], executionConfig: { permissions: "read_write" } });
    await runner.wait(route.id);
    expect(runner.get_route_state(route.id)).toMatchObject({ status: "completed", changedFiles: ["code.txt"] });
    expect(await readFile(join(root, "code.txt"), "utf8")).toBe("one block");
    expect(executions).toBe(2);
    expect(memory.list_runs_for_step(route.steps[0].id)[0].metadata.runtime).toMatchObject({ mutationEvents: [{ state: "finished", success: true, beforeHash: expect.any(String), afterHash: expect.any(String) }] });
  });
  it("does not let recovery steal a route from an active runner", async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture(async input => input.phase === "verification" ? assessment() : (await gate, { response: "Done" }));
    const route = f.create(1); f.runner.start_route(route.id);
    await vi.waitFor(() => expect(f.runtime.execute).toHaveBeenCalledTimes(1));
    new RouteRunner(f.memory, f.bridge).recover();
    expect(f.runtime.execute).toHaveBeenCalledTimes(1);
    finish(); await f.runner.wait(route.id); expect(f.runner.get_route_state(route.id).status).toBe("completed");
  });
  it("serializes routes that share a workspace even with different project IDs", async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture(async input => input.phase === "verification" ? assessment() : (await gate, { response: "Done" }));
    const first = f.create(1); f.runner.start_route(first.id);
    const project = f.memory.create_project({ name: "Same directory", root_path: process.cwd().replaceAll("\\", "/") });
    const task = f.memory.create_task({ project_id: project.id, title: "Concurrent", original_request: "Inspect same workspace" });
    const second = f.runner.create_route({ taskId: task.id, autoStart: false, steps: [{ title: "Step", instruction: "Inspect", acceptanceCriteria: ["Inspected"] }] });
    expect(() => f.runner.start_route(second.id)).toThrow("Another execution is active");
    finish(); await f.runner.wait(first.id); f.runner.start_route(second.id); await f.runner.wait(second.id);
    expect(f.runner.get_route_state(second.id).status).toBe("completed");
  });
  it("recovers an autostart route persisted immediately before its initial claim", async () => {
    const f = fixture(); const route = f.memory.create_route({ taskId: f.task.id, steps: [{ title: "Step", instruction: "Inspect", acceptanceCriteria: ["Inspected"] }] });
    f.runner.recover(); await f.runner.wait(route.id); expect(f.runner.get_route_state(route.id).status).toBe("completed");
  });
  it("resumes another recovered route on owner completion without polling or an external start", async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture(async input => input.phase === "verification" ? assessment() : (await gate, { response: "Done" }));
    const create = () => f.memory.create_route({ taskId: f.task.id, steps: [{ title: "Step", instruction: "Inspect", acceptanceCriteria: ["Inspected"] }] });
    const routes = [create(), create()]; f.runner.recover();
    await vi.waitFor(() => expect(f.runtime.execute).toHaveBeenCalledTimes(1));
    expect(routes.map(route => f.memory.get_route(route.id)?.status).sort()).toEqual(["pending", "running"]);
    finish();
    await vi.waitFor(() => expect(routes.map(route => f.memory.get_route(route.id)?.status)).toEqual(["completed", "completed"]));
    expect(f.runtime.execute).toHaveBeenCalledTimes(4);
  });
});
