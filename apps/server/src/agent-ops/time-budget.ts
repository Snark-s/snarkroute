import type { AgentTask, TaskState } from "./types";

/**
 * Time a task spends, split by what it was doing:
 * - waiting (queue, work window, resources, executor quota, a reviewer that has no model) never
 *   consumes the execution budget — a task may wait for the night window;
 * - active (an executor run, machine checks, the reviewer's model call, retries and reworks)
 *   consumes the task's own budget and the shared budget of its whole delegation chain;
 * - an explicit `deadline` is a wall-clock limit and keeps running while the task waits.
 */

export type TaskTiming = { activeMs: number; waitingMs: number; since: string; phase: "active" | "waiting" | "done" };

const ACTIVE_STATES = new Set<TaskState>(["running"]);
const DONE_STATES = new Set<TaskState>(["verified", "failed", "cancelled"]);

/**
 * Which bucket the time in a state belongs to. Only an executor run is active by state; the
 * acceptor's own work is counted from its review runs (start..end), so waiting for a lock, a
 * resource or a reviewer quota between them stays free.
 */
export function phaseOf(task: Pick<AgentTask, "state">): TaskTiming["phase"] {
  if (DONE_STATES.has(task.state)) return "done";
  return ACTIVE_STATES.has(task.state) ? "active" : "waiting";
}

/** Adds the time since the last change to the bucket of the phase the task was in. Call before every state change. */
export function accrue(task: AgentTask, now: number): TaskTiming {
  const timing = task.timing ?? { activeMs: 0, waitingMs: 0, since: task.createdAt, phase: "waiting" };
  const elapsed = Math.max(0, now - Date.parse(timing.since));
  if (timing.phase === "active") timing.activeMs += elapsed;
  else if (timing.phase === "waiting") timing.waitingMs += elapsed;
  timing.since = new Date(now).toISOString();
  timing.phase = phaseOf(task);
  task.timing = timing;
  return timing;
}

/** Active minutes so far: executor runs (including the one in progress) plus the acceptor's review runs. */
export function activeMinutes(task: AgentTask, now: number): number {
  const timing = task.timing;
  const running = timing?.phase === "active" ? Math.max(0, now - Date.parse(timing.since)) : 0;
  const reviews = (task.reviewRuns ?? []).reduce((sum, run) => sum + Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt)), 0);
  return ((timing?.activeMs ?? 0) + running + reviews) / 60_000;
}

export function waitingMinutes(task: AgentTask, now: number): number {
  const timing = task.timing;
  if (!timing) return Math.max(0, now - Date.parse(task.createdAt)) / 60_000;
  const current = timing.phase === "waiting" ? Math.max(0, now - Date.parse(timing.since)) : 0;
  return (timing.waitingMs + current) / 60_000;
}

/** Milliseconds left until the explicit deadline, or undefined when none was set. */
export function deadlineLeftMs(task: Pick<AgentTask, "spec">, now: number): number | undefined {
  const deadline = task.spec.deadline ? Date.parse(task.spec.deadline) : NaN;
  return Number.isFinite(deadline) ? deadline - now : undefined;
}
