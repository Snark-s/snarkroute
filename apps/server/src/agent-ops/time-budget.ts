import type { AgentTask } from "./types";

/**
 * Time a task spends, split by what it was doing (accounted in tasks.ts):
 * - waiting (queue, work window, resources, executor quota, a reviewer that has no model) is
 *   recorded in `task.waiting` and never consumes the execution budget;
 * - active time is executor attempts plus the acceptor's review runs; it consumes the task's
 *   own budget and the shared budget of its whole delegation chain;
 * - an explicit `deadline` is a wall-clock limit and keeps running while the task waits.
 */

/** Milliseconds left until the explicit deadline, or undefined when none was set. */
export function deadlineLeftMs(task: Pick<AgentTask, "spec">, now: number): number | undefined {
  const deadline = task.spec.deadline ? Date.parse(task.spec.deadline) : NaN;
  return Number.isFinite(deadline) ? deadline - now : undefined;
}
