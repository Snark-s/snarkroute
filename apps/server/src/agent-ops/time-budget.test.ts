import { describe, expect, it } from "vitest";
import { accrue, activeMinutes, deadlineLeftMs, waitingMinutes } from "./time-budget";
import type { AgentTask } from "./types";

describe("task time budget", () => {
  it("does not spend the execution budget while waiting for the night window", () => {
    const start = Date.parse("2026-10-29T21:00:00Z");
    const task = { id: "t", createdAt: new Date(start).toISOString(), state: "waiting_window", spec: { goal: "x", deadline: "2026-10-30T06:00:00Z" } } as unknown as AgentTask;
    accrue(task, start);
    task.state = "running"; accrue(task, start + 5 * 3_600_000);
    task.state = "awaiting_acceptance"; accrue(task, start + 5 * 3_600_000 + 4 * 60_000);
    expect(waitingMinutes(task, start + 5 * 3_600_000 + 6 * 60_000)).toBe(300);
    expect(activeMinutes(task, start + 5 * 3_600_000 + 6 * 60_000)).toBe(6);
    expect(deadlineLeftMs(task, start + 5 * 3_600_000)).toBe(4 * 3_600_000);
  });
});
