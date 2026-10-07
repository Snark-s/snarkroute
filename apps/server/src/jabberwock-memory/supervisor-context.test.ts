import { describe, expect, it } from "vitest";
import { buildSupervisorContextPacket, type SupervisorGetStateResult } from "./supervisor-bridge";

describe("Jabberwock Supervisor prompt bounds", () => {
  it("stops growing after the bounded recent-step window", () => {
    const lengths = [10, 20, 50].map((count) => buildSupervisorContextPacket(stateWithSteps(count), {
      instruction: "Perform only the current atomic action.",
      expectedOutput: "A short result",
      constraints: ["Stay within the project"]
    }).length);

    expect(lengths[1]).toBeGreaterThan(lengths[0]);
    expect(Math.abs(lengths[2] - lengths[1])).toBeLessThan(100);
    expect(lengths[2]).toBeLessThan(20_000);
  });
});

function stateWithSteps(count: number): SupervisorGetStateResult {
  return {
    taskId: "task",
    project: { id: "project", name: "Project", description: "Compact project context", rootPath: "Y:\\Project", updatedAt: "2026-01-01" },
    goal: { title: "Goal", originalRequest: "Complete a long series of atomic tasks.", status: "active", updatedAt: "2026-01-01" },
    facts: [],
    decisions: [],
    completedSteps: Array.from({ length: count }, (_, index) => ({
      id: `step-${index + 1}`,
      task_id: "task",
      sequence: index + 1,
      instruction: "Old instruction",
      status: "completed",
      result_summary: "A compact prior result.",
      assessment: null,
      accepted: null,
      created_at: "2026-01-01",
      completed_at: "2026-01-01"
    })),
    activeSteps: [],
    failedSteps: [],
    artifacts: []
  };
}
