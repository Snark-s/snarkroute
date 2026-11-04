import { randomUUID } from "node:crypto";
import { AgentOpsError, type AgentTaskService } from "./tasks";
import type { AgentOpsStore } from "./store";
import { TERMINAL_STATES, type AgentIdentity, type AgentTask } from "./types";

/**
 * D1: the goal layer. A goal is what the owner (or an agent on his behalf) wants achieved; tasks of
 * the shared queue are its stages and carry `spec.goalId`, stages wait for each other with
 * `spec.after`. Progress is counted only by stages the independent Acceptor has accepted.
 */
export type GoalSource = "workshop" | "chatgpt" | "telegram" | "agent" | "mcp";
export type GoalState = "active" | "done" | "cancelled";
export type Goal = {
  id: string;
  title: string;
  description?: string;
  source: GoalSource;
  createdBy: string;
  /** The agent that drives the goal (plans and submits its stages); defaults to the creator. */
  assignee: string;
  state: GoalState;
  priority: number;
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  note?: string;
};
export type GoalProgress = {
  total: number; verified: number; failed: number; cancelled: number; active: number; needsOwner: number;
  /** Accepted stages out of the stages that still count (cancelled ones do not). */
  percent: number;
  status: "no_stages" | "in_progress" | "needs_owner" | "all_accepted" | "stalled";
};
export type GoalView = Goal & { progress: GoalProgress; stages: Array<{ id: string; title: string; state: AgentTask["state"]; reason: string; after: string[]; agentId: string; updatedAt: string }> };

const SOURCES: GoalSource[] = ["workshop", "chatgpt", "telegram", "agent", "mcp"];
const MAX_GOALS = 2000;

export function goalProgress(stages: AgentTask[]): GoalProgress {
  const count = (test: (task: AgentTask) => boolean) => stages.filter(test).length;
  const verified = count(task => task.state === "verified"), failed = count(task => task.state === "failed"), cancelled = count(task => task.state === "cancelled");
  const needsOwner = count(task => task.state === "blocked"), active = count(task => !TERMINAL_STATES.has(task.state));
  const counted = stages.length - cancelled;
  const status: GoalProgress["status"] = !stages.length ? "no_stages" : needsOwner ? "needs_owner" : active ? "in_progress" : counted && verified === counted ? "all_accepted" : "stalled";
  return { total: stages.length, verified, failed, cancelled, active, needsOwner, percent: counted ? Math.round(verified / counted * 100) : 0, status };
}

export class GoalService {
  private goals = new Map<string, Goal>();

  constructor(private readonly deps: { store: AgentOpsStore; tasks: AgentTaskService; now?: () => number }) {}

  private iso(): string { return new Date(this.deps.now?.() ?? Date.now()).toISOString(); }

  async init(): Promise<void> {
    const saved = await this.deps.store.readState<{ goals?: Goal[] }>("goals", {});
    for (const goal of saved.goals ?? []) this.goals.set(goal.id, goal);
    // Stages refer to goals; the task service asks here before accepting a stage.
    this.deps.tasks.attachGoals({ assertCanAttach: (goalId, identity) => this.assertCanAttach(goalId, identity) });
  }

  private save(): Promise<void> { return this.deps.store.writeState("goals", { goals: [...this.goals.values()] }); }

  /** The owner, the goal's creator and assignee, and trusted agents (level 3+) see goals: one shared picture. */
  canRead(goal: Goal, identity: AgentIdentity): boolean {
    return identity.kind === "owner" || identity.policy.level >= 3 || goal.createdBy === identity.id || goal.assignee === identity.id;
  }

  private canDrive(goal: Goal, identity: AgentIdentity): boolean {
    return identity.kind === "owner" || goal.createdBy === identity.id || goal.assignee === identity.id;
  }

  require(id: string, identity: AgentIdentity): Goal {
    const goal = this.goals.get(id);
    if (!goal) throw new AgentOpsError("GOAL_NOT_FOUND", `Цель ${id} не найдена.`, {}, 404);
    if (!this.canRead(goal, identity)) throw new AgentOpsError("NOT_YOUR_GOAL", `Цель ${id} не видна агенту ${identity.id}.`, {}, 403);
    return goal;
  }

  /** A stage may join an active goal; level 3 agents may add stages to any goal they see, others only to their own. */
  assertCanAttach(goalId: string, identity: AgentIdentity): void {
    const goal = this.require(goalId, identity);
    if (goal.state !== "active") throw new AgentOpsError("GOAL_CLOSED", `Цель ${goalId} уже ${goal.state === "done" ? "достигнута" : "отменена"}.`);
    if (!this.canDrive(goal, identity) && identity.policy.level < 3 && !identity.taskId) throw new AgentOpsError("NOT_YOUR_GOAL", `Добавлять этапы к цели ${goalId} может её автор или исполнитель.`, {}, 403);
  }

  async create(identity: AgentIdentity, input: { title?: unknown; description?: unknown; source?: unknown; assignee?: unknown; priority?: unknown; deadline?: unknown }): Promise<Goal> {
    if (identity.kind === "anonymous") throw new AgentOpsError("IDENTITY_REQUIRED", "Цели ставит владелец или агент с токеном.", {}, 401);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) throw new AgentOpsError("BAD_GOAL", "Нужна формулировка цели до 200 символов.", {}, 400);
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 20_000) : undefined;
    const source = SOURCES.includes(input.source as GoalSource) ? input.source as GoalSource : identity.kind === "owner" ? "workshop" : "agent";
    const deadline = typeof input.deadline === "string" && input.deadline ? input.deadline : undefined;
    if (deadline && !Number.isFinite(Date.parse(deadline))) throw new AgentOpsError("BAD_GOAL", "deadline должен быть датой ISO.", {}, 400);
    const assignee = typeof input.assignee === "string" && /^[a-z]+:[\w.-]{1,80}$/i.test(input.assignee) ? input.assignee : identity.id;
    if (assignee !== identity.id && identity.kind !== "owner" && identity.policy.level < 3) throw new AgentOpsError("BAD_GOAL", "Назначить цель другому агенту может владелец или доверенный агент.", {}, 403);
    const active = [...this.goals.values()].filter(goal => goal.state === "active");
    const duplicate = active.find(goal => goal.title.toLowerCase() === title.toLowerCase());
    if (duplicate) return duplicate;
    if (this.goals.size >= MAX_GOALS) this.prune();
    const at = this.iso();
    const priority = Math.max(0, Math.min(identity.policy.maxPriority, Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50));
    const goal: Goal = { id: `g-${at.slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`, title, ...(description ? { description } : {}), source, createdBy: identity.id, assignee,
      state: "active", priority, ...(deadline ? { deadline } : {}), createdAt: at, updatedAt: at };
    this.goals.set(goal.id, goal);
    await this.save();
    return goal;
  }

  stages(goalId: string): AgentTask[] {
    return this.deps.tasks.list({ limit: 100_000 }).filter(task => task.spec.goalId === goalId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  view(goal: Goal): GoalView {
    const stages = this.stages(goal.id);
    return { ...goal, progress: goalProgress(stages), stages: stages.map(task => ({ id: task.id, title: task.title, state: task.state, reason: task.reason, after: task.spec.after ?? [], agentId: task.agentId, updatedAt: task.updatedAt })) };
  }

  list(identity: AgentIdentity, filter: { states?: GoalState[]; limit?: number } = {}): GoalView[] {
    return [...this.goals.values()]
      .filter(goal => this.canRead(goal, identity) && (!filter.states || filter.states.includes(goal.state)))
      .sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || b.priority - a.priority || b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(500, filter.limit ?? 100))
      .map(goal => this.view(goal));
  }

  /** done needs every stage finished (or the owner's word); cancel also cancels unfinished stages. */
  async close(id: string, identity: AgentIdentity, state: "done" | "cancelled", note?: string): Promise<GoalView> {
    const goal = this.require(id, identity);
    if (!this.canDrive(goal, identity)) throw new AgentOpsError("NOT_YOUR_GOAL", "Закрыть цель может владелец, её автор или исполнитель.", {}, 403);
    if (goal.state !== "active") return this.view(goal);
    const open = this.stages(id).filter(task => !TERMINAL_STATES.has(task.state));
    if (state === "done" && open.length && identity.kind !== "owner") throw new AgentOpsError("GOAL_HAS_OPEN_STAGES", `У цели ещё ${open.length} незавершённых этапов.`, { open: open.map(task => task.id) });
    if (state === "cancelled") for (const task of open) await this.deps.tasks.cancel(task.id, identity, `Цель ${id} отменена`).catch(() => undefined);
    const at = this.iso();
    Object.assign(goal, { state, updatedAt: at, closedAt: at, ...(note ? { note: note.slice(0, 2000) } : {}) });
    await this.save();
    return this.view(goal);
  }

  /** Keeps the store bounded: the oldest closed goals go first, active ones are never dropped. */
  private prune(): void {
    const closed = [...this.goals.values()].filter(goal => goal.state !== "active").sort((a, b) => (a.closedAt ?? a.updatedAt).localeCompare(b.closedAt ?? b.updatedAt));
    for (const goal of closed.slice(0, Math.max(1, this.goals.size - MAX_GOALS + 1))) this.goals.delete(goal.id);
  }
}
