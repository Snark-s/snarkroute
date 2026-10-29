import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentBrief, workspaceAllowed, type AgentRegistry } from "./agents";
import { opsContext } from "./context";
import type { ExecutorAdapter, ExecutorOutcome, ExecutorProbe } from "./executors";
import { workspaceLockKey, type LockManager } from "./locks";
import type { QuotaLedger } from "./quota-ledger";
import type { Lease, ResourceDispatcher } from "./resources";
import { rankExecutors, type RouteCandidate } from "./router";
import type { AgentOpsStore } from "./store";
import {
  TERMINAL_STATES, WAITING_STATES,
  type AgentIdentity, type AgentTask, type Attempt, type ComputerMode, type FailureClass, type TaskEvent, type TaskSpec, type TaskState
} from "./types";
import { changedPaths, createWorktree, gitTopLevel, killProcessTree, processAlive, processImage, runCheck, snapshotWorkspace } from "./workspace";

export class AgentOpsError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}, readonly status = 409) {
    super(message);
    this.name = "AgentOpsError";
  }
}

type RunningTask = { controller: AbortController; heartbeat: NodeJS.Timeout; adapter: ExecutorAdapter };

export type TaskServiceDeps = {
  store: AgentOpsStore;
  registry: AgentRegistry;
  ledger: QuotaLedger;
  locks: LockManager;
  dispatcher: ResourceDispatcher;
  adapters: ExecutorAdapter[];
  mode: () => Promise<{ mode: ComputerMode; label: string }>;
  apiUrl: string;
  worktreeRoot: string;
  now?: () => number;
  tickMs?: number;
  /** Tests run without spawning a real `git`/checks. */
  workspace?: { snapshot?: typeof snapshotWorkspace; alive?: typeof processAlive };
};

const PROBE_TTL_MS = 60_000;
const DEFAULT_WALL_MINUTES = 30;
const AGING_POINTS_PER_MINUTE = 2;
const STARVATION_MINUTES = 10;

export class AgentTaskService {
  private tasks = new Map<string, AgentTask>();
  private running = new Map<string, RunningTask>();
  private watching = new Set<string>();
  private probes = new Map<string, ExecutorProbe>();
  private probedAt = 0;
  private ticking?: Promise<void>;
  private again = false;
  private timer?: NodeJS.Timeout;
  private lastMode?: ComputerMode;

  constructor(private readonly deps: TaskServiceDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private adapter(id: string | undefined): ExecutorAdapter | undefined { return this.deps.adapters.find(adapter => adapter.id === id); }
  private snapshot(dir: string | undefined) { return (this.deps.workspace?.snapshot ?? snapshotWorkspace)(dir); }
  private alive(pid: number | undefined, image?: string) { return (this.deps.workspace?.alive ?? processAlive)(pid, image); }

  async init(): Promise<void> {
    for (const task of await this.deps.store.loadTasks()) this.tasks.set(task.id, task);
    await this.reconcileAfterRestart();
    this.timer = setInterval(() => this.kick(), this.deps.tickMs ?? 2000);
    this.timer.unref?.();
    this.kick();
  }

  /** Executor processes are left alone on shutdown; the next start reconciles them instead of guessing. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const run of this.running.values()) clearInterval(run.heartbeat);
  }

  /** Waits for pending writes (tests, orderly shutdown). */
  async drain(): Promise<void> { await this.settle(); await this.deps.store.flush(); }

  get(id: string): AgentTask | undefined { return this.tasks.get(id); }

  list(filter: { agentId?: string; states?: TaskState[]; limit?: number } = {}): AgentTask[] {
    return [...this.tasks.values()]
      .filter(task => (!filter.agentId || task.agentId === filter.agentId) && (!filter.states || filter.states.includes(task.state)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
  }

  events(id: string): Promise<TaskEvent[]> { return this.deps.store.readEvents(id); }
  log(id: string): Promise<string> { return this.deps.store.readLog(id); }

  // ---------------------------------------------------------------- submission

  async submit(identity: AgentIdentity, input: TaskSpec): Promise<{ task: AgentTask; deduplicated: boolean }> {
    const spec = normalizeSpec(input);
    if (spec.idempotencyKey) {
      const existing = [...this.tasks.values()].find(task => task.spec.idempotencyKey === spec.idempotencyKey && task.agentId === identity.id);
      if (existing) return { task: existing, deduplicated: true };
    }
    const policy = identity.policy;
    const parent = identity.taskId ? this.tasks.get(identity.taskId) : spec.parentTaskId ? this.tasks.get(spec.parentTaskId) : undefined;
    if (spec.parentTaskId && !parent) throw new AgentOpsError("PARENT_NOT_FOUND", `Родительская задача ${spec.parentTaskId} не найдена.`, {}, 404);
    if (parent && !identity.taskId && parent.agentId !== identity.id && identity.kind !== "owner") throw new AgentOpsError("PARENT_NOT_OWNED", "Подзадачу можно создать только к своей задаче.", {}, 403);

    let workdir: string | undefined;
    if (spec.workspace) {
      workdir = resolve(spec.workspace);
      const info = await stat(workdir).catch(() => undefined);
      if (!info?.isDirectory()) throw new AgentOpsError("WORKSPACE_NOT_FOUND", `Рабочая папка не найдена: ${workdir}`, {}, 400);
      if (!workspaceAllowed(workdir, policy.workspaceRoots)) throw new AgentOpsError("WORKSPACE_NOT_ALLOWED", `Папка ${workdir} вне разрешённых для агента ${identity.id}.`, { roots: policy.workspaceRoots }, 403);
      if (parent?.workdir && !workspaceAllowed(workdir, [parent.workdir]) && identity.taskId) throw new AgentOpsError("WORKSPACE_NOT_ALLOWED", "Подзадача исполнителя может работать только внутри папки своей задачи.", {}, 403);
      if (spec.isolation === "worktree" && !(await gitTopLevel(workdir))) throw new AgentOpsError("WORKTREE_NEEDS_GIT", "Изоляция worktree требует git-репозитория.", {}, 400);
    }

    const fingerprint = taskFingerprint(spec.goal, workdir);
    const chainAgents = parent ? [...parent.chain.agents, identity.id] : [identity.id];
    const depth = parent ? parent.chain.depth + 1 : 1;
    const rootPolicy = parent ? this.deps.registry.policy(this.tasks.get(parent.chain.rootTaskId)?.agentId === "owner" ? "owner" : "agent") : policy;
    const maxDepth = Math.min(policy.maxDelegationDepth, rootPolicy.maxDelegationDepth);
    if (depth > maxDepth) throw new AgentOpsError("DELEGATION_TOO_DEEP", `Глубина делегирования ${depth} больше разрешённой ${maxDepth}.`, { depth, maxDepth });
    if (parent && parent.chain.fingerprints.includes(fingerprint)) {
      throw new AgentOpsError("DELEGATION_CYCLE", "Циклическое делегирование: эта же цель уже есть выше в цепочке.", { chain: parent.chain });
    }
    if (parent) {
      const budget = this.chainBudget(parent.chain.rootTaskId);
      if (budget.tasksLeft <= 0) throw new AgentOpsError("CHAIN_BUDGET_EXCEEDED", `Бюджет цепочки исчерпан: задач ${budget.tasksUsed} из ${budget.limits.tasks}.`, { budget });
      if (budget.wallMinutesLeft <= 0) throw new AgentOpsError("CHAIN_BUDGET_EXCEEDED", "Бюджет времени цепочки исчерпан.", { budget });
    }
    if (!spec.allowDuplicate) {
      const duplicate = [...this.tasks.values()].find(task => task.fingerprint === fingerprint && !TERMINAL_STATES.has(task.state));
      if (duplicate) throw new AgentOpsError("DUPLICATE_TASK", `Такое поручение уже есть: ${duplicate.id} (${duplicate.state}).`, { existingTaskId: duplicate.id });
    }
    const today = this.iso().slice(0, 10);
    const todayCount = [...this.tasks.values()].filter(task => task.agentId === identity.id && task.createdAt.startsWith(today)).length;
    if (todayCount >= policy.dailyTaskLimit) throw new AgentOpsError("DAILY_LIMIT", `Дневной лимит поручений агента (${policy.dailyTaskLimit}) исчерпан.`);

    const id = `t-${this.iso().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
    const at = this.iso();
    const task: AgentTask = {
      id, spec, title: spec.title?.trim() || spec.goal.split(/\r?\n/)[0].slice(0, 90), state: "queued", reason: "Поставлена в очередь",
      agentId: identity.id,
      chain: { rootTaskId: parent?.chain.rootTaskId ?? id, parentTaskId: parent?.id, depth, agents: chainAgents, fingerprints: [...(parent?.chain.fingerprints ?? []), fingerprint] },
      fingerprint, priority: Math.max(0, Math.min(policy.maxPriority, spec.priority ?? 50)), createdAt: at, updatedAt: at,
      excludedExecutors: {}, attempts: [], workdir, lockKeys: []
    };
    if (spec.budget) task.spec.budget = { ...spec.budget, wallMinutes: Math.min(spec.budget.wallMinutes ?? DEFAULT_WALL_MINUTES, rootPolicy.chainBudget.wallMinutes) };
    this.tasks.set(id, task);
    await this.persist(task, "submitted", `Поручение принято от ${identity.id}${parent ? ` (подзадача ${parent.id}, глубина ${depth})` : ""}.`, { spec });
    this.kick();
    return { task, deduplicated: false };
  }

  chainBudget(rootTaskId: string) {
    const root = this.tasks.get(rootTaskId);
    const members = [...this.tasks.values()].filter(task => task.chain.rootTaskId === rootTaskId);
    const policy = this.deps.registry.policy(root?.agentId === "owner" ? "owner" : "agent");
    const limits = {
      tasks: policy.chainBudget.tasks,
      wallMinutes: Math.min(policy.chainBudget.wallMinutes, root?.spec.budget?.wallMinutes ? root.spec.budget.wallMinutes * 4 : policy.chainBudget.wallMinutes),
      subscriptionRuns: Math.min(policy.chainBudget.subscriptionRuns, root?.spec.budget?.subscriptionRuns ?? policy.chainBudget.subscriptionRuns)
    };
    const subscriptionRuns = members.flatMap(task => task.attempts).filter(attempt => this.adapter(attempt.executor)?.profile.costTier === "subscription").length;
    const wallMinutes = root ? (this.now() - Date.parse(root.createdAt)) / 60_000 : 0;
    return { limits, tasksUsed: members.length, tasksLeft: limits.tasks - members.length, subscriptionRunsUsed: subscriptionRuns,
      subscriptionRunsLeft: limits.subscriptionRuns - subscriptionRuns, wallMinutesUsed: Math.round(wallMinutes), wallMinutesLeft: Math.round(limits.wallMinutes - wallMinutes) };
  }

  // ---------------------------------------------------------------- control

  async cancel(id: string, identity: AgentIdentity, reason = "Отмена"): Promise<AgentTask> {
    const task = this.require(id);
    this.assertControl(task, identity);
    if (TERMINAL_STATES.has(task.state)) return task;
    task.cancelRequestedAt = this.iso();
    const run = this.running.get(id);
    if (run) {
      run.controller.abort();
      const pid = task.attempts.at(-1)?.pid;
      if (pid) killProcessTree(pid);
      await this.persist(task, "cancel_requested", `${reason}: процесс исполнителя останавливается.`);
    } else if (task.state === "unknown_outcome" && this.watching.has(id)) {
      const attempt = task.attempts.at(-1);
      if (attempt?.pid && await this.alive(attempt.pid, attempt.pidImage)) killProcessTree(attempt.pid);
      this.watching.delete(id);
      await this.finish(task, "cancelled", `${reason} (${identity.id}).`);
    } else {
      await this.finish(task, "cancelled", `${reason} (${identity.id}).`);
    }
    return task;
  }

  /** For the Workshop's «Остановить все задачи»: only tasks SnarkRoute manages, never the owner's own processes. */
  async cancelAllManaged(identity: AgentIdentity): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results = [];
    for (const task of this.list({ limit: 10_000 }).filter(item => !TERMINAL_STATES.has(item.state))) {
      try { await this.cancel(task.id, identity, "Остановить все задачи"); results.push({ id: task.id, ok: true }); }
      catch (error) { results.push({ id: task.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }

  /** A human or the submitting agent decides what an unknown or blocked outcome was. */
  async resolve(id: string, identity: AgentIdentity, action: "requeue" | "continue" | "mark_failed" | "mark_verified", note?: string): Promise<AgentTask> {
    const task = this.require(id);
    this.assertControl(task, identity);
    if (!["unknown_outcome", "blocked", "failed", "awaiting_verification"].includes(task.state)) throw new AgentOpsError("BAD_STATE", `Задача в состоянии ${task.state}; решение не требуется.`);
    if (this.watching.has(id)) throw new AgentOpsError("STILL_RUNNING", "Процесс исполнителя ещё работает; дождитесь его завершения или отмените задачу.");
    if (action === "mark_verified") {
      if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Подтвердить результат без проверок может только владелец.", {}, 403);
      await this.finish(task, "verified", `Подтверждено владельцем${note ? `: ${note}` : ""}.`);
    } else if (action === "mark_failed") {
      await this.finish(task, "failed", `Отмечено как ошибка (${identity.id})${note ? `: ${note}` : ""}.`);
    } else {
      if (action === "continue") task.spec.onPartial = "continue";
      if (action === "requeue") task.excludedExecutors = {};
      this.deps.locks.releaseOwner(task.id);
      await this.setState(task, "queued", `Возвращена в очередь (${identity.id})${note ? `: ${note}` : ""}.`, "resolved");
      this.kick();
    }
    return task;
  }

  async verify(id: string, identity: AgentIdentity): Promise<AgentTask> {
    const task = this.require(id);
    this.assertControl(task, identity);
    if (!["awaiting_verification", "failed", "unknown_outcome"].includes(task.state) || !task.spec.checks?.length) throw new AgentOpsError("BAD_STATE", "Проверять нечего: нет машинных проверок или задача ещё не выполнена.");
    if (this.watching.has(id)) throw new AgentOpsError("STILL_RUNNING", "Процесс исполнителя ещё работает.");
    await this.runVerification(task);
    return task;
  }

  private assertControl(task: AgentTask, identity: AgentIdentity): void {
    if (identity.kind === "owner" || task.agentId === identity.id) return;
    if (identity.taskId && task.chain.agents.includes(identity.id)) return;
    if (identity.taskId && this.tasks.get(identity.taskId)?.chain.rootTaskId === task.chain.rootTaskId && task.chain.parentTaskId === identity.taskId) return;
    throw new AgentOpsError("NOT_OWNER", `Задачей ${task.id} управляет ${task.agentId}.`, {}, 403);
  }

  private require(id: string): AgentTask {
    const task = this.tasks.get(id);
    if (!task) throw new AgentOpsError("TASK_NOT_FOUND", `Задача ${id} не найдена.`, {}, 404);
    return task;
  }

  // ---------------------------------------------------------------- scheduler

  kick(): void {
    if (this.ticking) { this.again = true; return; }
    this.ticking = this.tick().catch(() => undefined).finally(() => {
      this.ticking = undefined;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  /** Resolves when the current scheduling pass (and any it queued) is over. Used by tests and the smoke script. */
  async settle(): Promise<void> {
    while (this.ticking) await this.ticking;
  }

  private async refreshProbes(force = false): Promise<void> {
    if (!force && this.now() - this.probedAt < PROBE_TTL_MS) return;
    this.probedAt = this.now();
    await Promise.all(this.deps.adapters.map(async adapter => {
      try {
        const probe = await adapter.probe(force);
        this.probes.set(adapter.id, probe);
        if (adapter.profile.costTier === "subscription") {
          this.deps.ledger.recordAuth(adapter.id, !probe.installed ? "not_installed" : probe.authenticated === false ? "not_subscription" : "ok", probe.source, probe.detail);
        }
      } catch (error) {
        this.probes.set(adapter.id, { installed: false, authenticated: null, detail: error instanceof Error ? error.message : String(error), checkedAt: this.iso(), source: "probe-error" });
      }
    }));
  }

  probeSnapshot(): Map<string, ExecutorProbe> { return new Map(this.probes); }
  async refreshExecutorProbes(force = true): Promise<void> { await this.refreshProbes(force); }

  private async tick(): Promise<void> {
    await this.refreshProbes();
    await this.deps.dispatcher.expireStale();
    const mode = await this.deps.mode();
    if (this.lastMode && this.lastMode !== mode.mode) {
      for (const id of this.running.keys()) {
        const task = this.tasks.get(id);
        if (task) await this.event(task, "mode_changed", mode.mode === "owner_busy"
          ? `Режим «${mode.label}»: новые тяжёлые этапы не начинаются; текущий этап (${this.adapter(task.executor)?.profile.pause === "stage_boundary" ? "одна генерация" : "запуск CLI"}) завершится сам, сохранение состояния не обещается.`
          : `Режим изменён на «${mode.label}».`);
      }
    }
    this.lastMode = mode.mode;
    for (const id of [...this.watching]) await this.checkWatched(id);

    const waiting = [...this.tasks.values()].filter(task => WAITING_STATES.has(task.state) && !this.running.has(task.id))
      .sort((a, b) => this.effectivePriority(b) - this.effectivePriority(a) || a.createdAt.localeCompare(b.createdAt));
    // A heavy task that has waited long blocks lower-priority heavy work from overtaking it again.
    const starving = waiting.find(task => this.waitedMinutes(task) >= STARVATION_MINUTES && this.isHeavy(task));
    for (const task of waiting) {
      if (starving && task !== starving && this.isHeavy(task) && this.effectivePriority(task) <= this.effectivePriority(starving)) {
        await this.wait(task, "waiting_resources", `Пропускает вперёд давно ждущую тяжёлую задачу ${starving.id}.`);
        continue;
      }
      await this.tryStart(task);
    }
  }

  private effectivePriority(task: AgentTask): number {
    const affinity = this.isHeavy(task) && this.deps.dispatcher.recentHeavyRuntime() === this.probes.get(task.executor ?? "local_route")?.runtimeId ? 5 : 0;
    return task.priority + Math.min(40, this.waitedMinutes(task) * AGING_POINTS_PER_MINUTE) + affinity;
  }

  private waitedMinutes(task: AgentTask): number { return (this.now() - Date.parse(task.createdAt)) / 60_000; }
  private isHeavy(task: AgentTask): boolean {
    const adapter = this.adapter(task.executor) ?? this.adapter(this.rank(task).find(candidate => candidate.suitable)?.executorId);
    return adapter ? adapter.resourceRequest(task, this.probes.get(adapter.id)).class === "heavy" : false;
  }

  rank(task: AgentTask): RouteCandidate[] {
    const policy = this.deps.registry.policy(task.agentId === "owner" ? "owner" : task.agentId.startsWith("task:") ? "child" : "agent");
    return rankExecutors({ spec: task.spec, policy, adapters: this.deps.adapters, probes: this.probes });
  }

  private async tryStart(task: AgentTask): Promise<void> {
    if (task.cancelRequestedAt) { await this.finish(task, "cancelled", "Отменена до запуска."); return; }
    const budget = this.chainBudget(task.chain.rootTaskId);
    if (budget.wallMinutesLeft <= 0) { await this.finish(task, "failed", "Истёк бюджет времени цепочки поручений.", "budget"); return; }

    const candidates = this.rank(task);
    const suitable = candidates.filter(candidate => candidate.suitable);
    const preferred = task.spec.executor && task.spec.executor !== "auto" ? candidates.find(candidate => candidate.executorId === task.spec.executor) : undefined;
    if (preferred && !preferred.suitable && !task.attempts.length && task.state === "queued") {
      await this.event(task, "routing", `Предпочтённый исполнитель ${preferred.label} не подходит: ${preferred.reasons.join("; ")}.`);
    }
    if (!suitable.length) {
      await this.setState(task, "blocked", `Нет подходящего исполнителя: ${candidates.map(candidate => `${candidate.label} — ${candidate.reasons.join(", ")}`).join("; ")}.`, "routing");
      return;
    }
    const notes: string[] = [];
    let permanent = true;
    let chosen: RouteCandidate | undefined;
    for (const candidate of suitable) {
      const excluded = task.excludedExecutors[candidate.executorId];
      if (excluded) { notes.push(`${candidate.label}: ${excluded}`); continue; }
      const probe = this.probes.get(candidate.executorId);
      if (!probe?.installed) { notes.push(`${candidate.label}: ${probe?.detail ?? "не обнаружен"}`); continue; }
      if (probe.authenticated === false) { notes.push(`${candidate.label}: ${probe.detail ?? "нет входа по подписке"}`); continue; }
      if (candidate.tier === "subscription" && budget.subscriptionRunsLeft <= 0) { notes.push(`${candidate.label}: бюджет подписочных запусков цепочки исчерпан`); continue; }
      const availability = this.deps.ledger.availability(candidate.executorId, candidate.tier);
      if (!availability.usable) { notes.push(`${candidate.label}: ${availability.reason}`); if (!availability.permanent) permanent = false; continue; }
      chosen = candidate;
      break;
    }
    if (!chosen) {
      if (permanent && !Object.keys(task.excludedExecutors).length) await this.setState(task, "blocked", `Все подходящие исполнители недоступны: ${notes.join("; ")}.`, "routing");
      else if (permanent) await this.setState(task, "blocked", `Подходящих исполнителей не осталось: ${notes.join("; ")}. Повтора вслепую не будет.`, "routing");
      else await this.wait(task, "waiting_executor", `Ждёт исполнителя: ${notes.join("; ")}.`);
      return;
    }

    const adapter = this.adapter(chosen.executorId)!;
    if (task.spec.isolation === "worktree" && task.workdir && !task.worktree) {
      const repo = (await gitTopLevel(task.workdir))!;
      const path = join(this.deps.worktreeRoot, task.id);
      const branch = `agent/${task.id}`;
      const guard = this.deps.locks.tryAcquire([`service:git-worktree:${repo}`], { taskId: task.id, agentId: task.agentId });
      if (!guard.ok) { await this.wait(task, "waiting_resources", "Другой задаче создают worktree в этом репозитории."); return; }
      try { await createWorktree(repo, path, branch); }
      catch (error) { this.deps.locks.releaseOwner(task.id); await this.setState(task, "blocked", `Не удалось создать worktree: ${error instanceof Error ? error.message : error}`, "worktree"); return; }
      this.deps.locks.releaseOwner(task.id);
      task.worktree = { path, branch, repo };
      task.workdir = path;
      await this.event(task, "worktree", `Отдельный worktree ${path} на ветке ${branch}.`);
    }

    const lockKeys = task.workdir ? [workspaceLockKey(task.workdir)] : [];
    const lock = this.deps.locks.tryAcquire(lockKeys, { taskId: task.id, agentId: task.agentId });
    if (!lock.ok) {
      await this.wait(task, "waiting_resources", `Рабочая копия занята: ${lock.conflicts.map(conflict => `${conflict.key} — задача ${conflict.heldBy} (${conflict.ownerAgentId}${conflict.state === "suspect" ? ", ждёт сверки после сбоя" : ""})`).join("; ")}.`);
      return;
    }
    task.lockKeys = lockKeys;
    const request = adapter.resourceRequest(task, this.probes.get(adapter.id));
    const decision = await this.deps.dispatcher.acquire({ ...request, holder: task.id, agentId: task.agentId, purpose: `${task.id} · ${adapter.label}`, origin: "agent",
      ttlMs: 5 * 60_000 });
    if (!decision.granted) {
      // Never hold the working copy while waiting for GPU/RAM or the work window.
      this.deps.locks.releaseOwner(task.id);
      task.lockKeys = [];
      await this.wait(task, decision.waitFor === "window" ? "waiting_window" : "waiting_resources", decision.reason);
      return;
    }
    await this.launch(task, adapter, decision.lease);
  }

  private async launch(task: AgentTask, adapter: ExecutorAdapter, lease: Lease): Promise<void> {
    const attempt: Attempt = { n: task.attempts.length + 1, executor: adapter.id, startedAt: this.iso(), baseline: await this.snapshot(task.workdir) };
    const partial = task.attempts.at(-1)?.changedFiles?.length && task.spec.onPartial === "continue" ? task.attempts.at(-1) : undefined;
    task.attempts.push(attempt);
    task.executor = adapter.id;
    task.leaseId = lease.id;
    task.startedAt ??= attempt.startedAt;
    const controller = new AbortController();
    const end = this.deps.ledger.begin(adapter.id);
    const heartbeat = setInterval(() => { this.deps.dispatcher.heartbeat(lease.id); }, 30_000);
    heartbeat.unref?.();
    this.running.set(task.id, { controller, heartbeat, adapter });
    await this.setState(task, "running", `Выполняет ${adapter.label}.`, "started", { executor: adapter.id, leaseId: lease.id, attempt: attempt.n });

    const budget = this.chainBudget(task.chain.rootTaskId);
    const wallMinutes = Math.max(1, Math.min(task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES, budget.wallMinutesLeft));
    const childIdentity = this.deps.registry.taskAgent(task.id, `${adapter.label} · ${task.title}`);
    const token = this.deps.registry.issueTaskToken(task.id, (wallMinutes + 30) * 60_000);
    const brief = agentBrief(childIdentity, { taskId: task.id, chainDepth: task.chain.depth, apiUrl: this.deps.apiUrl,
      budget: `${budget.tasksLeft} sub-tasks, ${budget.subscriptionRunsLeft} subscription runs, ${budget.wallMinutesLeft} min` });
    const log = (line: string) => { void this.deps.store.appendLog(task.id, `${new Date(this.now()).toISOString()} ${line}\n`); };
    const context = { origin: "agent" as const, agentId: childIdentity.id, taskId: task.id, heldRuntimes: lease.runtimeId ? [lease.runtimeId] : [] };
    const outcome = opsContext.run(context, () => adapter.run({
      task, workdir: task.workdir, prompt: buildTaskPrompt(task, partial), brief, signal: controller.signal,
      env: { SNARKROUTE_AGENT_TOKEN: token, SNARKROUTE_TASK_ID: task.id, SNARKROUTE_API_URL: this.deps.apiUrl },
      timeoutMs: wallMinutes * 60_000, maxTurns: task.spec.budget?.maxTurns ?? 40, log,
      onPid: pid => {
        // Persisted at once: after a crash this pid is how SnarkRoute tells a live run from a lost one.
        attempt.pid = pid;
        void this.deps.store.saveTask(task);
        void processImage(pid).then(image => { if (image) { attempt.pidImage = image; return this.deps.store.saveTask(task); } });
      }
    }));
    void outcome
      .catch(error => ({ ok: false, failureClass: "process" as FailureClass, message: error instanceof Error ? error.message : String(error) }))
      .then(result => this.complete(task, attempt, result, lease))
      .finally(() => { clearInterval(heartbeat); end(); this.running.delete(task.id); this.kick(); });
  }

  private async complete(task: AgentTask, attempt: Attempt, outcome: ExecutorOutcome, lease: Lease): Promise<void> {
    // Scarce resources go back first: verification and waiting never hold the GPU.
    this.deps.dispatcher.release(lease.id);
    task.leaseId = undefined;
    attempt.endedAt = this.iso();
    attempt.sessionId = outcome.sessionId;
    attempt.model = outcome.model;
    attempt.changedFiles = changedPaths(attempt.baseline, await this.snapshot(task.workdir));
    const adapter = this.adapter(attempt.executor)!;
    if (outcome.quotaReport) this.deps.ledger.recordQuotaReport(adapter.id, outcome.quotaReport);
    if (outcome.ok) {
      attempt.outcome = "succeeded";
      this.deps.ledger.recordSuccess(adapter.id);
      const artifactPath = outcome.artifactText ? await this.deps.store.writeArtifact(task.id, "result.md", outcome.artifactText) : undefined;
      task.result = {
        summary: (outcome.summary ?? outcome.message).slice(0, 20_000), executor: adapter.id, model: outcome.model, changedFiles: attempt.changedFiles,
        checks: [], workdir: task.workdir, branch: task.worktree?.branch, artifactPath, usage: outcome.usage,
        cost: { tier: adapter.profile.costTier, providerCost: 0, note: adapter.profile.costTier === "subscription" ? "Подписка: без оплаты за запрос, расходует квоту." : "Локально: 0." }
      };
      await this.event(task, "executor_finished", `${adapter.label}: ${outcome.message} Изменено файлов: ${attempt.changedFiles.length}.`, { changedFiles: attempt.changedFiles.slice(0, 100) });
      if (task.cancelRequestedAt) { await this.finish(task, "cancelled", "Отменена; исполнитель успел завершить работу, результат сохранён без проверки."); return; }
      await this.runVerification(task);
      return;
    }

    attempt.outcome = outcome.failureClass === "cancelled" ? "cancelled" : "failed";
    attempt.failureClass = outcome.failureClass;
    attempt.error = outcome.message.slice(0, 2000);
    const failure = outcome.failureClass ?? "process";
    if (["quota_exhausted", "rate_limited", "auth", "network"].includes(failure)) {
      this.deps.ledger.recordFailure(adapter.id, { class: failure, message: outcome.message, resetsAt: outcome.resetsAt, source: `delegated run ${task.id}` });
    }
    await this.event(task, "executor_failed", `${adapter.label}: ${failureLabel(failure)} — ${outcome.message.slice(0, 500)}`, { failureClass: failure, changedFiles: attempt.changedFiles.slice(0, 100) });
    if (failure === "cancelled" || task.cancelRequestedAt) { await this.finish(task, "cancelled", `Отменена${attempt.changedFiles.length ? `; остались изменения в ${attempt.changedFiles.length} файлах` : ""}.`); return; }

    if (attempt.changedFiles.length && task.spec.onPartial !== "continue") {
      // Partial edits stay locked: another executor must not run the same work over half-done files.
      await this.setState(task, "blocked", `${adapter.label}: ${failureLabel(failure)} после частичных изменений (${attempt.changedFiles.slice(0, 8).join(", ")}). Нужно решение: resolve continue (продолжить другим исполнителем с текущего состояния), requeue или mark_failed.`, "partial");
      return;
    }
    this.deps.locks.releaseOwner(task.id);
    task.lockKeys = [];
    if (["quota_exhausted", "rate_limited", "auth", "model_unavailable"].includes(failure)) {
      task.excludedExecutors[adapter.id] = `${failureLabel(failure)} в попытке ${attempt.n}`;
      await this.setState(task, "queued", `${adapter.label}: ${failureLabel(failure)}; процесс завершён, изменений нет — ищу другого исполнителя в пределах бюджета.`, "fallback");
      return;
    }
    const sameFailures = task.attempts.filter(item => item.executor === adapter.id && item.outcome === "failed").length;
    if ((failure === "network" || failure === "timeout" || failure === "process") && sameFailures < 2) {
      if (sameFailures >= 1) task.excludedExecutors[adapter.id] = `${failureLabel(failure)} дважды`;
      await this.setState(task, "queued", `${adapter.label}: ${failureLabel(failure)}; изменений нет, процесс завершён — повтор после паузы.`, "retry");
      return;
    }
    await this.finish(task, "failed", `${adapter.label}: ${failureLabel(failure)} — ${outcome.message.slice(0, 300)}`);
  }

  private async runVerification(task: AgentTask): Promise<void> {
    const checks = task.spec.checks ?? [];
    if (!checks.length) {
      this.deps.locks.releaseOwner(task.id);
      task.lockKeys = [];
      await this.setState(task, "awaiting_verification", "Машинных проверок нет: результат нужно проверить (agent_delegate_verify с проверками или решение владельца).", "verification");
      return;
    }
    await this.setState(task, "awaiting_verification", `Проверяю результат: ${checks.length} проверок.`, "verification");
    const results = [];
    for (const check of checks) results.push(await runCheck(check, task.workdir));
    if (task.result) task.result.checks = results;
    else task.result = { summary: "", executor: task.executor ?? "unknown", changedFiles: [], checks: results, workdir: task.workdir, cost: { tier: "local", providerCost: 0, note: "" } };
    this.deps.locks.releaseOwner(task.id);
    task.lockKeys = [];
    const failed = results.filter(result => !result.ok);
    if (failed.length) {
      await this.finish(task, "failed", `Проверка не прошла (${failed.length} из ${results.length}): ${failed.map(result => `${describeCheck(result.check)} — ${result.detail.split(/\r?\n/).slice(0, 2).join(" ")}`).join("; ").slice(0, 600)}`, "verification");
      return;
    }
    if (task.executor) this.deps.ledger.recordSuccess(task.executor, { verified: true });
    await this.finish(task, "verified", `Все проверки прошли (${results.length}).`);
  }

  // ---------------------------------------------------------------- restart recovery

  private async reconcileAfterRestart(): Promise<void> {
    for (const task of this.tasks.values()) {
      // An unknown outcome whose attempt never ended is a run we were still watching before this restart.
      const unfinished = task.state === "unknown_outcome" && task.attempts.at(-1) && !task.attempts.at(-1)!.endedAt;
      if (task.state === "running" || unfinished) {
        const attempt = task.attempts.at(-1);
        if (attempt?.pid && await this.alive(attempt.pid, attempt.pidImage)) {
          this.watching.add(task.id);
          this.deps.locks.confirm(task.id);
          await this.setState(task, "unknown_outcome", `SnarkRoute перезапущен во время выполнения; процесс ${attempt.pid} ещё работает. Жду его завершения, повторного запуска не будет.`, "restart");
        } else {
          await this.evaluateInterrupted(task, "SnarkRoute перезапущен во время выполнения, процесс исполнителя уже завершён");
        }
      } else if (task.state === "awaiting_verification" && task.spec.checks?.length) {
        await this.runVerification(task);
      } else if (task.state === "unknown_outcome" || task.state === "blocked") {
        this.deps.locks.confirm(task.id);
      } else if (TERMINAL_STATES.has(task.state) || WAITING_STATES.has(task.state)) {
        this.deps.locks.releaseOwner(task.id);
      }
      if (task.leaseId && task.state !== "unknown_outcome") { this.deps.dispatcher.release(task.leaseId); task.leaseId = undefined; }
    }
    // Locks and leases whose owner task is gone entirely are released.
    for (const lock of this.deps.locks.list()) if (!this.tasks.has(lock.ownerTaskId)) this.deps.locks.releaseOwner(lock.ownerTaskId);
    for (const lease of this.deps.dispatcher.list()) if (this.tasks.has(lease.holder) && this.tasks.get(lease.holder)!.state !== "unknown_outcome") this.deps.dispatcher.release(lease.id, { measured: false });
  }

  private async checkWatched(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const attempt = task?.attempts.at(-1);
    if (!task || !attempt) { this.watching.delete(id); return; }
    if (await this.alive(attempt.pid, attempt.pidImage)) {
      if (task.leaseId) this.deps.dispatcher.heartbeat(task.leaseId);
      return;
    }
    this.watching.delete(id);
    if (task.leaseId) { this.deps.dispatcher.release(task.leaseId, { measured: false }); task.leaseId = undefined; }
    await this.evaluateInterrupted(task, "Процесс исполнителя завершился без связи с SnarkRoute");
  }

  /** The outcome of a run whose output we lost: decided by files and checks, never by a blind rerun. */
  private async evaluateInterrupted(task: AgentTask, reason: string): Promise<void> {
    const attempt = task.attempts.at(-1);
    if (attempt) {
      attempt.endedAt ??= this.iso();
      attempt.outcome = "unknown";
      attempt.changedFiles = changedPaths(attempt.baseline, await this.snapshot(task.workdir));
    }
    const changed = attempt?.changedFiles ?? [];
    if (task.spec.checks?.length && changed.length) {
      const results = [];
      for (const check of task.spec.checks) results.push(await runCheck(check, task.workdir));
      task.result = { summary: "Исход восстановлен по файлам и проверкам после потери связи.", executor: task.executor ?? "unknown", changedFiles: changed, checks: results, workdir: task.workdir, branch: task.worktree?.branch,
        cost: { tier: this.adapter(task.executor)?.profile.costTier ?? "local", providerCost: 0, note: "" } };
      if (results.every(result => result.ok)) {
        this.deps.locks.releaseOwner(task.id);
        await this.finish(task, "verified", `${reason}; изменения есть (${changed.length}), все проверки прошли.`);
        return;
      }
    }
    if (!changed.length && task.spec.permissions?.network !== true) {
      this.deps.locks.releaseOwner(task.id);
      await this.setState(task, "queued", `${reason}; изменений в рабочей папке нет и сетевых действий не разрешалось — безопасно вернуть в очередь.`, "restart");
      return;
    }
    this.deps.locks.confirm(task.id);
    await this.setState(task, "unknown_outcome", `${reason}. Изменено файлов: ${changed.length}${task.spec.checks?.length ? ", проверки не прошли" : ", машинных проверок нет"}. Нужно решение: resolve continue/requeue/mark_failed (владелец может mark_verified).`, "unknown");
  }

  // ---------------------------------------------------------------- state helpers

  private async wait(task: AgentTask, state: TaskState, reason: string): Promise<void> {
    if (task.state === state && task.reason === reason) return;
    await this.setState(task, state, reason, "waiting");
  }

  private async setState(task: AgentTask, state: TaskState, reason: string, eventType = "state", data?: Record<string, unknown>): Promise<void> {
    task.state = state;
    task.reason = reason;
    await this.persist(task, eventType, reason, { state, ...(data ?? {}) });
  }

  private async finish(task: AgentTask, state: TaskState, reason: string, eventType = "finished"): Promise<void> {
    task.finishedAt = this.iso();
    this.deps.locks.releaseOwner(task.id);
    task.lockKeys = [];
    if (task.leaseId) { this.deps.dispatcher.release(task.leaseId); task.leaseId = undefined; }
    await this.setState(task, state, reason, eventType);
  }

  private async event(task: AgentTask, type: string, message: string, data?: Record<string, unknown>): Promise<void> {
    await this.deps.store.appendEvent(task.id, { at: this.iso(), type, message, ...(data ? { data } : {}) }).catch(() => undefined);
  }

  private async persist(task: AgentTask, type: string, message: string, data?: Record<string, unknown>): Promise<void> {
    task.updatedAt = this.iso();
    await this.deps.store.saveTask(task);
    await this.event(task, type, message, data);
  }
}

export function normalizeSpec(input: TaskSpec): TaskSpec {
  if (!input || typeof input.goal !== "string" || !input.goal.trim()) throw new AgentOpsError("BAD_SPEC", "Нужна цель поручения (goal).", {}, 400);
  if (input.goal.length > 40_000) throw new AgentOpsError("BAD_SPEC", "Цель слишком длинная (больше 40 000 символов).", {}, 400);
  const checks = (input.checks ?? []).slice(0, 12);
  for (const check of checks) {
    if (check.type === "command" && (!check.command?.trim() || /[\r\n]/.test(check.command))) throw new AgentOpsError("BAD_SPEC", "Команда проверки должна быть одной программой без переводов строк.", {}, 400);
  }
  return {
    ...input,
    goal: input.goal.trim(),
    acceptance: (input.acceptance ?? []).slice(0, 30),
    checks,
    inputs: (input.inputs ?? []).slice(0, 50),
    constraints: (input.constraints ?? []).slice(0, 30),
    isolation: input.isolation === "worktree" ? "worktree" : "shared",
    permissions: { fileWrite: input.permissions?.fileWrite !== false, shell: input.permissions?.shell ?? "tests", network: input.permissions?.network === true }
  };
}

export function taskFingerprint(goal: string, workdir?: string): string {
  const normalized = goal.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${normalized}|${workdir ? resolve(workdir).toLowerCase() : ""}`).digest("hex").slice(0, 24);
}

export function buildTaskPrompt(task: AgentTask, partial?: Attempt): string {
  const spec = task.spec;
  const section = (title: string, items?: string[]) => items?.length ? `\n${title}:\n${items.map(item => `- ${item}`).join("\n")}\n` : "";
  return [
    `# Delegated task ${task.id}: ${task.title}`,
    "",
    "Goal:",
    spec.goal,
    section("Acceptance criteria", spec.acceptance),
    section("Inputs", spec.inputs),
    section("Constraints", spec.constraints),
    task.workdir ? `Working folder: ${task.workdir}. Stay inside it.${task.worktree ? ` It is a separate git worktree on branch ${task.worktree.branch}; commit there if the goal asks for a commit.` : ""}` : "No working folder: answer in text only.",
    section("Checks SnarkRoute will run itself after you finish (your report does not replace them)", spec.checks?.map(describeCheck)),
    partial ? `\nA previous attempt (${partial.executor}) stopped (${partial.failureClass ?? partial.outcome}) and left changes in: ${partial.changedFiles?.slice(0, 30).join(", ")}. Continue from the current state; do not redo finished work.` : "",
    "\nWhen done, reply with a short summary: what you changed, how you checked it, and anything left undone. Do not claim checks passed unless you ran them."
  ].filter(part => part !== undefined).join("\n");
}

export function describeCheck(check: NonNullable<TaskSpec["checks"]>[number]): string {
  if (check.type === "command") return `run \`${[check.command, ...(check.args ?? [])].join(" ")}\` (exit code 0)`;
  if (check.type === "file_exists") return `file exists: ${check.path}`;
  return `file ${check.path} contains "${check.text.slice(0, 80)}"`;
}

function failureLabel(failure: FailureClass): string {
  return ({ quota_exhausted: "лимит подписки исчерпан", rate_limited: "временное ограничение частоты", auth: "ошибка авторизации", network: "сеть или сервис недоступны",
    process: "сбой процесса", timeout: "превышено время", model_unavailable: "модель недоступна", cancelled: "отменено", verification: "проверка не прошла" } as Record<FailureClass, string>)[failure];
}
