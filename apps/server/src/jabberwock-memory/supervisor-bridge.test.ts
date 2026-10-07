import { afterEach, describe, expect, it, vi } from "vitest";
import { JabberwockMemoryService } from "./service";
import {
  SupervisorBridge,
  type SupervisorAgentRuntime,
  type SupervisorModelRouter,
  type SupervisorRoutingResult
} from "./supervisor-bridge";

const memories: JabberwockMemoryService[] = [];

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

describe("Jabberwock Supervisor Bridge", () => {
  it("returns compact working-memory state without raw runs", () => {
    const { memory, project, task } = fixture();
    memory.add_fact({ project_id: project.id, task_id: task.id, text: "Use the existing provider layer.", source: "request" });
    const step = memory.create_step({ task_id: task.id, sequence: 1, instruction: "Inspect routing", status: "active" });
    memory.add_run({ step_id: step.id, model: "old-model", prompt: "old prompt", response: "RAW OLD RESPONSE", status: "completed" });
    memory.complete_step(step.id, "Routing inspected.");

    const state = new SupervisorBridge(memory, mocks()).supervisorGetState(task.id);

    expect(state).toMatchObject({
      taskId: task.id,
      project: { id: project.id, name: "Bridge project" },
      goal: { originalRequest: "Execute atomic externally planned steps." },
      facts: [{ text: "Use the existing provider layer." }],
      completedSteps: [{ id: step.id, result_summary: "Routing inspected." }],
      activeSteps: []
    });
    expect(JSON.stringify(state)).not.toContain("RAW OLD RESPONSE");
  });

  it("executes one fixed step, records its run, completes the step, and excludes old run responses from the packet", async () => {
    const { memory, project, task } = fixture();
    const oldStep = memory.create_step({ task_id: task.id, sequence: 1, instruction: "Old work" });
    memory.add_run({ step_id: oldStep.id, model: "old", prompt: "old", response: "DO_NOT_FORWARD_RAW_RUN", status: "completed" });
    memory.complete_step(oldStep.id, "Old work summarized.");
    memory.add_fact({ project_id: project.id, text: "SQLite only.", source: "request" });
    let receivedPacket = "";
    const runtime: SupervisorAgentRuntime = {
      execute: vi.fn(async (input) => {
        receivedPacket = input.contextPacket;
        return { response: "Atomic result", summary: "Atomic step completed." };
      })
    };
    const router = routerResult({ mode: "fixed", model: "bonsai-2-27b", provider: "local_openai", providerModelId: "bonsai.gguf" });
    const bridge = new SupervisorBridge(memory, { router, runtime });

    const result = await bridge.supervisorExecuteStep({
      taskId: task.id,
      instruction: "Implement the isolated adapter.",
      routingMode: "fixed",
      model: "bonsai-2-27b",
      expectedOutput: "A concise patch summary",
      constraints: ["Do not use PersonaCore"]
    });

    expect(result).toMatchObject({ status: "completed", sequence: 2, response: "Atomic result", routing: { mode: "fixed", provider: "local_openai" } });
    expect(memory.get_step(result.stepId)).toMatchObject({ status: "completed", result_summary: "Atomic step completed." });
    expect(memory.list_runs_for_step(result.stepId)).toEqual([
      expect.objectContaining({ model: "bonsai-2-27b", response: "Atomic result", status: "completed" })
    ]);
    expect(receivedPacket).toContain("Old work summarized.");
    expect(receivedPacket).toContain("CURRENT INSTRUCTION\nImplement the isolated adapter.");
    expect(receivedPacket).not.toContain("DO_NOT_FORWARD_RAW_RUN");
  });

  it("uses the auto router and exposes only routing metadata it actually returns", async () => {
    const { memory, task } = fixture();
    const route = vi.fn(async (): Promise<SupervisorRoutingResult> => ({
      mode: "auto",
      model: "selected-model",
      provider: "openrouter",
      providerModelId: "provider/selected-model",
      reason: "policy: capability match",
      metadata: { selectedEngineId: "engine:selected" }
    }));
    const bridge = new SupervisorBridge(memory, {
      router: { route },
      runtime: { execute: vi.fn(async () => ({ response: "Selected response" })) }
    });

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Return structured JSON.", routingMode: "auto" });

    expect(route).toHaveBeenCalledWith(expect.objectContaining({ routingMode: "auto", model: undefined }));
    expect(result.routing).toMatchObject({ model: "selected-model", provider: "openrouter", reason: "policy: capability match" });
    expect(result.routing.score).toBeUndefined();
    expect(memory.list_runs_for_step(result.stepId)[0]).toMatchObject({
      model: "selected-model",
      metadata: { routing: { provider: "openrouter", metadata: { selectedEngineId: "engine:selected" } } }
    });
  });

  it("records an external assessment plus new facts and decisions without continuing automatically", () => {
    const { memory, task } = fixture();
    const step = memory.create_step({ task_id: task.id, sequence: 1, instruction: "Produce draft" });
    memory.complete_step(step.id, "Draft produced.");
    const bridge = new SupervisorBridge(memory, mocks());

    const recorded = bridge.supervisorRecordAssessment({
      taskId: task.id,
      stepId: step.id,
      assessment: "The draft violates the portability constraint.",
      accepted: false,
      facts: ["The target format must remain portable."],
      decisions: [{ text: "Reject this draft.", rationale: "It changes the public format." }]
    });
    const state = bridge.supervisorGetState(task.id);

    expect(recorded.step).toMatchObject({ assessment: "The draft violates the portability constraint.", accepted: false });
    expect(state.facts).toEqual(expect.arrayContaining([expect.objectContaining({ text: "The target format must remain portable." })]));
    expect(state.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Reject this draft." })]));
    expect(memory.list_task_steps(task.id)).toHaveLength(1);
  });

  it("records a failed run and marks the same step failed when runtime execution throws", async () => {
    const { memory, task } = fixture();
    const bridge = new SupervisorBridge(memory, {
      router: routerResult({ mode: "auto", model: "weak-model", provider: "local_openai" }),
      runtime: { execute: vi.fn(async () => { throw new Error("provider unavailable"); }) }
    });

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Execute once.", routingMode: "auto" });

    expect(result).toMatchObject({ status: "failed", error: "provider unavailable" });
    expect(memory.get_step(result.stepId)).toMatchObject({ status: "failed", result_summary: "provider unavailable" });
    expect(memory.list_runs_for_step(result.stepId)).toEqual([
      expect.objectContaining({ status: "failed", response: "provider unavailable" })
    ]);
    expect(bridge.supervisorGetState(task.id)).toMatchObject({ activeSteps: [], failedSteps: [{ id: result.stepId }] });
  });

  it("keeps runtime retry/escalation inside one supervisor step when metadata is available", async () => {
    const { memory, task } = fixture();
    const bridge = new SupervisorBridge(memory, {
      router: routerResult({ mode: "auto", model: "bonsai", provider: "local_openai" }),
      runtime: {
        execute: vi.fn(async () => ({
          response: "Recovered result",
          routing: {
            model: "stronger-model",
            provider: "openrouter",
            escalated: true,
            retries: 1,
            metadata: { escalationPath: ["bonsai", "stronger-model"] }
          }
        }))
      }
    });

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Try the atomic task.", routingMode: "auto" });

    expect(result).toMatchObject({
      status: "completed",
      routing: { model: "stronger-model", provider: "openrouter", escalated: true, retries: 1 }
    });
    expect(memory.list_task_steps(task.id)).toHaveLength(1);
    expect(memory.list_runs_for_step(result.stepId)[0]?.metadata).toMatchObject({
      routing: { metadata: { escalationPath: ["bonsai", "stronger-model"] } }
    });
  });
});

function fixture() {
  const memory = new JabberwockMemoryService(":memory:");
  memories.push(memory);
  const project = memory.create_project({ name: "Bridge project", description: "Small context", root_path: "Y:\\Project" });
  const task = memory.create_task({ project_id: project.id, title: "Bridge task", original_request: "Execute atomic externally planned steps." });
  return { memory, project, task };
}

function routerResult(result: SupervisorRoutingResult): SupervisorModelRouter {
  return { route: vi.fn(async () => result) };
}

function mocks(): { router: SupervisorModelRouter; runtime: SupervisorAgentRuntime } {
  return {
    router: routerResult({ mode: "auto", model: "mock-model", provider: "mock" }),
    runtime: { execute: vi.fn(async () => ({ response: "mock response" })) }
  };
}
