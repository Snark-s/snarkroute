import { describe, expect, it } from "vitest";
import { deadlineLeftMs } from "./time-budget";
import type { AgentTask } from "./types";

describe("explicit deadline", () => {
  it("counts wall-clock time to the deadline and is absent without one", () => {
    const start = Date.parse("2026-10-29T21:00:00Z");
    const task = { spec: { goal: "x", deadline: "2026-10-30T06:00:00Z" } } as AgentTask;
    expect(deadlineLeftMs(task, start + 5 * 3_600_000)).toBe(4 * 3_600_000);
    expect(deadlineLeftMs({ spec: { goal: "x" } } as AgentTask, start)).toBeUndefined();
  });
});
