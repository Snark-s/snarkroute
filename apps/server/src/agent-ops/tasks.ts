import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentBrief, workspaceAllowed, type AgentRegistry } from "./agents";
import { contractFor, evidenceFor, machineVerdicts, makeReview, mergeModelVerdicts } from "./acceptor";
import type { AcceptanceReviewer } from "./acceptor-reviewer";
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

type RunningTask = { controller: AbortController; heartbeat: NodeJS.Timeout; adapter: ExecutorAdapter; timeout?: NodeJS.Timeout };

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
  reviewer?: AcceptanceReviewer;
  toolCheck?: (task: AgentTask, check: Extract<NonNullable<TaskSpec["checks"]>[number], { type: "tool" }>) => Promise<import("./types").CheckResult>;
  toolObservations?: (task: AgentTask) => Promise<import("./types").CheckResult>;
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
  private verifying = new Map<string, AbortController>();
  private probes = new Map<string, ExecutorProbe>();
  private probedAt = 0;
  private ticking?: Promise<void>;
  private again = false;
  private timer?: NodeJS.Timeout;
  private lastMode?: ComputerMode;
  private closed = false;

  constructor(private readonly deps: TaskServiceDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private adapter(id: string | undefined): ExecutorAdapter | undefined { return this.deps.adapters.find(adapter => adapter.id === id); }
  private snapshot(dir: string | undefined) { return (this.deps.workspace?.snapshot ?? snapshotWorkspace)(dir); }
  private alive(pid: number | undefined, image?: string) { return (this.deps.workspace?.alive ?? processAlive)(pid, image); }

  async init(): Promise<void> {
    for (const task of await this.deps.store.loadTasks()) { task.contract ??= contractFor(task.spec); task.effects ??= (task.spec.effects ?? []).map(effect => ({ ...effect, state: "pending" })); this.tasks.set(task.id, task); }
    await this.reconcileAfterRestart();
    this.timer = setInterval(() => this.kick(), this.deps.tickMs ?? 2000);
    this.timer.unref?.();
    this.kick();
  }

  /** Executor processes are left alone on shutdown; the next start reconciles them instead of guessing. */
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const run of this.running.values()) { clearInterval(run.heartbeat); if (run.timeout) clearTimeout(run.timeout); }
    for (const controller of this.verifying.values()) controller.abort();
  }

  /** Waits for pending writes (tests, orderly shutdown). */
  async drain(): Promise<void> { await this.settle(); while (this.verifying.size) await new Promise(resolve => setTimeout(resolve, 10)); await this.deps.store.flush(); }

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

  async submit(identity: AgentIdentity, input: TaskSpec, options: { inspectExisting?: boolean } = {}): Promise<{ task: AgentTask; deduplicated: boolean }> {
    const spec = normalizeSpec(input);
    if (spec.idempotencyKey) {
      const existing = [...this.tasks.values()].find(task => task.spec.idempotencyKey === spec.idempotencyKey && task.agentId === identity.id);
      if (existing) return { task: existing, deduplicated: true };
    }
    const policy = identity.policy;
    const parent = identity.taskId ? this.tasks.get(identity.taskId) : spec.parentTaskId ? this.tasks.get(spec.parentTaskId) : undefined;
    if (spec.parentTaskId && !parent) throw new AgentOpsError("PARENT_NOT_FOUND", `Родительская задача ${spec.parentTaskId} не найдена.`, {}, 404);
    if (parent && !identity.taskId && parent.agentId !== identity.id && identity.kind !== "owner") throw new AgentOpsError("PARENT_NOT_OWNED", "Подзадачу можно создать только к своей задаче.", {}, 403);
    if (parent?.cancelRequestedAt || parent?.state === "cancelled") throw new AgentOpsError("PARENT_CANCELLED", "Отменённое поручение не может создавать новые подзадачи.");
    if (parent && identity.taskId) {
      const permission = parent.spec.permissions ?? {}, shellRank = { none: 0, tests: 1, workspace: 2 };
      if (spec.permissions?.network && !permission.network || spec.permissions?.fileWrite !== false && permission.fileWrite === false || shellRank[spec.permissions?.shell ?? "tests"] > shellRank[permission.shell ?? "tests"]) throw new AgentOpsError("PERMISSION_ESCALATION", "Подзадача не расширяет полномочия исходного поручения.", {}, 403);
      if (parent.spec.allowedExecutors?.length) spec.allowedExecutors = (spec.allowedExecutors ?? policy.allowedExecutors).filter(executor => parent.spec.allowedExecutors!.includes(executor));
    }

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
    const rootTask = parent ? this.tasks.get(parent.chain.rootTaskId) : undefined;
    const rootPolicy = rootTask?.budgetPolicyId ? this.deps.registry.policy(rootTask.budgetPolicyId) : parent ? this.deps.registry.policyForAgent(rootTask?.agentId ?? parent.agentId) : policy;
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
      excludedExecutors: {}, attempts: [], workdir, lockKeys: [], waiting: {since:at,minutes:0,resourceMinutes:0,pausedMinutes:0}
    };
    task.contract = contractFor(spec);
    task.evidence = []; task.reviews = []; task.reviewRuns = [];
    task.effects = (spec.effects ?? []).map(effect => ({ ...effect, state: "pending" }));
    if (options.inspectExisting) {
      task.state = "awaiting_verification"; task.reason = "Приёмщик независимо проверит уже предоставленный результат; выполнение не утверждается.";
      task.attempts = [{ n: 1, executor: "external", startedAt: at, endedAt: at, outcome: "unknown", strategy: "inspect_existing" }];
      task.reviewPending = true;
    }
    if (spec.budget) task.spec.budget = { ...spec.budget, wallMinutes: Math.min(spec.budget.wallMinutes ?? DEFAULT_WALL_MINUTES, rootPolicy.chainBudget.wallMinutes) };
    this.tasks.set(id, task);
    await this.persist(task, "submitted", `Поручение принято от ${identity.id}${parent ? ` (подзадача ${parent.id}, глубина ${depth})` : ""}.`, { spec });
    this.kick();
    return { task, deduplicated: false };
  }

  chainBudget(rootTaskId: string) {
    const root = this.tasks.get(rootTaskId);
    const members = [...this.tasks.values()].filter(task => task.chain.rootTaskId === rootTaskId);
    const policy = root?.budgetPolicyId ? this.deps.registry.policy(root.budgetPolicyId) : this.deps.registry.policyForAgent(root?.agentId ?? "unknown");
    const limits = {
      tasks: policy.chainBudget.tasks,
      wallMinutes: Math.min(policy.chainBudget.wallMinutes, root?.spec.budget?.wallMinutes ? root.spec.budget.wallMinutes * 4 : policy.chainBudget.wallMinutes),
      subscriptionRuns: Math.min(policy.chainBudget.subscriptionRuns, root?.spec.budget?.subscriptionRuns ?? policy.chainBudget.subscriptionRuns)
    };
    const subscriptionRuns = members.reduce((sum, task) => sum + task.attempts.reduce((runs, attempt) => runs + (attempt.modelCalls ? attempt.modelCalls.filter(call => call.tier === "subscription").length : this.adapter(attempt.executor)?.profile.costTier === "subscription" ? 1 : 0), 0)
      + (task.reviewRuns ?? []).filter(run => this.adapter(run.executor)?.profile.costTier === "subscription").length, 0);
    const activeMinutes = members.reduce((sum, task) => sum + this.activeMinutes(task), 0);
    const activeLimit = root?.spec.budget?.activeMinutes ?? limits.wallMinutes;
    const until = members.length && members.every(task => TERMINAL_STATES.has(task.state)) ? Math.max(...members.map(task => Date.parse(task.finishedAt ?? task.updatedAt))) : this.now();
    const wallMinutes = root ? (until - Date.parse(root.createdAt)) / 60_000 : 0;
    return { limits, tasksUsed: members.length, tasksLeft: limits.tasks - members.length, subscriptionRunsUsed: subscriptionRuns,
      subscriptionRunsLeft: limits.subscriptionRuns - subscriptionRuns, wallMinutesUsed: Math.round(wallMinutes), wallMinutesLeft: Math.round(limits.wallMinutes - wallMinutes), activeMinutesUsed: activeMinutes, activeMinutesLeft: Math.max(0, activeLimit-activeMinutes) };
  }

  private activeMinutes(task: AgentTask) {
    const duration = (start: string, end?: string) => Math.max(0, (end ? Date.parse(end) : this.now()) - Date.parse(start));
    return (task.attempts.filter(a => a.executor !== "external" && (!a.resourceWait || a.modelCalls?.some(call=>call.ok) || a.toolCalls?.length)).reduce((sum,a) => sum + duration(a.startedAt,a.endedAt),0) + (task.reviewRuns ?? []).reduce((sum,r) => sum + duration(r.startedAt,r.endedAt),0))/60000;
  }

  budgetUsage(task: AgentTask) {
    const until = TERMINAL_STATES.has(task.state) ? Date.parse(task.finishedAt ?? task.updatedAt) : this.now();
    const wall = Math.max(0, (until - Date.parse(task.createdAt)) / 60000), limit = task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES;
    const runs = task.attempts.reduce((sum, attempt) => sum + (attempt.modelCalls ? attempt.modelCalls.filter(call => call.tier === "subscription").length : this.adapter(attempt.executor)?.profile.costTier === "subscription" ? 1 : 0), 0) + (task.reviewRuns ?? []).filter(run => this.adapter(run.executor)?.profile.costTier === "subscription").length;
    const active = this.activeMinutes(task), activeLimit = task.spec.budget?.activeMinutes ?? limit;
    const interval = task.waiting ? Math.max(0,(this.now()-Date.parse(task.waiting.since))/60000) : 0;
    const resourceWait = task.attempts.filter(a=>a.resourceWait && !a.modelCalls?.some(call=>call.ok) && !a.toolCalls?.length).reduce((sum,a)=>sum+Math.max(0,(Date.parse(a.endedAt??a.startedAt)-Date.parse(a.startedAt))/60000),0);
    return { wallMinutesUsed: Math.round(wall * 10) / 10, wallMinutesLeft: Math.max(0, Math.round((limit - wall) * 10) / 10), wallMinutesLimit: limit,
      activeMinutesUsed: active, activeMinutesLeft: Math.max(0,activeLimit-active), activeMinutesLimit: activeLimit,
      waitingMinutes: (task.waiting?.minutes??0)+(WAITING_STATES.has(task.state)||task.waiting?.reason?interval:0), resourceWaitingMinutes: (task.waiting?.resourceMinutes??0)+(task.state==="waiting_resources"||task.waiting?.reason==="resource"?interval:0)+resourceWait,
      pausedMinutes: (task.waiting?.pausedMinutes??0)+(task.state==="paused"?interval:0),
      subscriptionRunsUsed: runs, subscriptionRunsLimit: task.spec.budget?.subscriptionRuns ?? this.chainBudget(task.chain.rootTaskId).limits.subscriptionRuns,
      attemptsUsed: task.attempts.filter(attempt => attempt.executor !== "external").length, attemptsLimit: task.spec.retry?.maxAttempts ?? 4, providerCost: 0 };
  }

  // ---------------------------------------------------------------- control

  async reviseBudget(id: string, identity: AgentIdentity, patch: { wallMinutes?: number; activeMinutes?: number; subscriptionRuns?: number }, reason: string) {
    if (identity.kind !== "owner" || !reason?.trim()) throw new AgentOpsError("OWNER_ONLY", "Пересмотреть бюджет может только владелец с основанием; счётчики сохраняются.", {}, 403);
    const task=this.require(id); if (this.running.has(id) || this.verifying.has(id) || this.watching.has(id)) throw new AgentOpsError("STILL_RUNNING", "Бюджет меняется между этапами.");
    if (Object.keys(patch).some(key=>!["wallMinutes","activeMinutes","subscriptionRuns"].includes(key))) throw new AgentOpsError("BAD_SPEC", "Меняется только распределение времени и подписочных шагов, не полномочия или защита от циклов.");
    const next={...task.spec.budget,...patch}; normalizeSpec({...task.spec,budget:next});
    if ((next.wallMinutes??DEFAULT_WALL_MINUTES)>identity.policy.chainBudget.wallMinutes || (next.activeMinutes??0)>identity.policy.chainBudget.wallMinutes || (next.subscriptionRuns??0)>identity.policy.chainBudget.subscriptionRuns) throw new AgentOpsError("CHAIN_BUDGET_EXCEEDED", "Пересмотр не может превышать действующий лимит владельца.");
    const used=this.budgetUsage(task).subscriptionRunsUsed;
    (task.budgetHistory??=[]).push({at:this.iso(),by:identity.id,reason,previous:structuredClone(task.spec.budget),next:structuredClone(next),subscriptionRunsUsed:used});
    task.spec.budget=next; task.budgetPolicyId=identity.policy.id;
    await this.persist(task,"budget_revised",`${reason}; использовано ${used} подписочных шагов, счётчики не обнулены.`);
    return task;
  }

  async cancel(id: string, identity: AgentIdentity, reason = "Отмена"): Promise<AgentTask> {
    const task = this.require(id);
    this.assertControl(task, identity);
    if (TERMINAL_STATES.has(task.state)) return task;
    task.cancelRequestedAt = this.iso();
    task.pauseRequestedAt = undefined;
    this.verifying.get(id)?.abort();
    for (const child of this.tasks.values()) if (child.chain.parentTaskId === id && !TERMINAL_STATES.has(child.state)) await this.cancel(child.id, this.deps.registry.owner("cancel delegated descendants"), `Отмена родительской задачи ${id} (${identity.id})`);
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

  /** Pause at the current stage boundary; never start another stage while paused. */
  async pause(id: string, identity: AgentIdentity): Promise<AgentTask> {
    const task = this.require(id); this.assertControl(task, identity);
    if (TERMINAL_STATES.has(task.state)) return task;
    task.pauseRequestedAt = this.iso();
    this.verifying.get(id)?.abort();
    if (this.running.has(id)) await this.persist(task, "pause_requested", "Пауза после текущего этапа исполнителя; новые этапы не запускаются.");
    else await this.setState(task, "paused", "Приостановлена поручителем; состояние и доказательства сохранены.");
    return task;
  }

  async resume(id: string, identity: AgentIdentity): Promise<AgentTask> {
    const task = this.require(id); this.assertControl(task, identity);
    if (task.state !== "paused") throw new AgentOpsError("BAD_STATE", "Возобновить можно приостановленную задачу.");
    task.pauseRequestedAt = undefined;
    // Unknown external effects must still be reconciled; resume is no authorization to repeat them.
    await this.setState(task, task.reviewPending ? "awaiting_verification" : "queued", "Возобновлена поручителем."); this.kick(); return task;
  }

  async amend(id: string, identity: AgentIdentity, patch: Partial<TaskSpec>, note: string): Promise<AgentTask> {
    const task = this.require(id); this.assertControl(task, identity);
    if (identity.taskId === task.id || identity.id.startsWith("acceptor:")) throw new AgentOpsError("EXECUTOR_CANNOT_AMEND", "Исполнитель и Приёмщик не могут менять требования поручителя.", {}, 403);
    if (task.cancelRequestedAt || task.state === "cancelled") throw new AgentOpsError("BAD_STATE", "Отменённое поручение нельзя возобновить уточнением; создайте новое.");
    if (this.running.has(id) || this.verifying.has(id) || this.watching.has(id)) throw new AgentOpsError("STILL_RUNNING", "Изменения контракта вносятся между этапами.");
    if (!note?.trim()) throw new AgentOpsError("BAD_SPEC", "Нужна причина уточнения контракта.");
    // Scope and authority cannot grow through an amendment; submit a new task instead.
    const allowed = new Set(["goal", "expectedResult", "acceptance", "criteria", "checks"]);
    if (Object.keys(patch).some(key => !allowed.has(key))) throw new AgentOpsError("BAD_SPEC", "Уточнение может менять только требования и проверки; полномочия неизменны.");
    const previous = structuredClone(task.spec), next = normalizeSpec({ ...task.spec, ...patch });
    const contract = contractFor(next); contract.originalGoal = task.contract!.originalGoal; contract.revision = task.contract!.revision + 1;
    contract.amendments = [...task.contract!.amendments, { at: this.iso(), by: identity.id, note, previous }];
    task.spec = next; task.contract = contract; task.reviewPending = true;
    task.finishedAt = undefined; task.nextAttemptAt = undefined;
    await this.setState(task, task.pauseRequestedAt ? "paused" : task.attempts.length ? "awaiting_verification" : "queued", `Контракт уточнён (${identity.id}): ${note}`, "contract_amended"); this.kick(); return task;
  }

  /** Write-ahead external-effect receipt. A duplicate reservation never grants execution. */
  async toolEffect(taskId: string, tool: string, key: string, action: "begin" | "reconcile" | "refused", reason?: string) {
    const task = this.require(taskId);
    if (task.agentId !== "app:buzha" || task.spec.actor !== "buzha" || !task.spec.tools?.includes(tool) || !task.executor?.startsWith("buzha_") || !key.startsWith("tool:")) throw new AgentOpsError("BAD_EFFECT", "Действие должно принадлежать действующему инструментальному исполнителю.");
    let record = task.effects?.find(effect => effect.key === key);
    if (action === "begin" && !record) {
      if (task.effects?.some(effect => ["started", "unknown"].includes(effect.state))) throw new AgentOpsError("UNKNOWN_EFFECT", "Есть внешнее действие с неизвестным исходом. Сначала независимая сверка; новые действия не запускаются.");
      record = { key, description: `Доставка разрешённого действия ${tool}; публикация или отправка требуют отдельной независимой приёмки.`, check: { type: "tool_used", tool, effectKey: key }, state: "pending" };
      (task.effects ??= []).push(record);
    }
    if (!record) throw new AgentOpsError("BAD_EFFECT", "Нет резервации инструмента.");
    if (action === "refused") { record.state = "refused"; record.detail = `SnarkBridge отказал до исполнения: ${reason}`; record.checkedAt = this.iso(); await this.persist(task, "effect_refused", record.detail); return { execute: false, state: record.state }; }
    const result = await this.effect(taskId, this.deps.registry.app("buzha", "Бужа"), key, action);
    const receipt = task.attempts.flatMap(attempt => attempt.toolCalls ?? []).find(call => call.effectKey === key && call.ok);
    return { execute: result.execute, state: result.effect.state, result: receipt?.result };
  }

  async effect(id: string, identity: AgentIdentity, key: string, action: "begin" | "reconcile" | "not_performed", note?: string): Promise<{ execute: boolean; effect: NonNullable<AgentTask["effects"]>[number] }> {
    const task = this.require(id);
    if (identity.taskId !== id) this.assertControl(task, identity);
    const effect = task.effects?.find(item => item.key === key);
    if (!effect) throw new AgentOpsError("BAD_EFFECT", "Действие не разрешено контрактом.");
    if (action === "not_performed") {
      if (identity.kind !== "owner" || !note?.trim()) throw new AgentOpsError("OWNER_ONLY", "Для разрешения повтора нужен владелец и явное основание, что действие не выполнено.", {}, 403);
      effect.state = "pending"; effect.detail = note; await this.persist(task, "effect_reconciled", `${key}: владелец подтвердил отсутствие действия: ${note}`);
      return { execute: false, effect };
    }
    if (action === "reconcile") { await this.reconcileEffects(task); return { execute: false, effect }; }
    // This method has no await before changing state: two reservations cannot both win.
    if (task.state !== "running" || task.cancelRequestedAt || task.pauseRequestedAt || effect.state !== "pending") return { execute: false, effect };
    effect.state = "started"; effect.startedAt = this.iso(); effect.attempt = task.attempts.at(-1)?.n;
    await this.persist(task, "effect_reserved", `Перед внешним действием сохранена резервация ${key}.`);
    return { execute: true, effect };
  }

  private async reconcileEffects(task: AgentTask): Promise<boolean> {
    for (const effect of task.effects ?? []) {
      if (effect.state === "pending" || effect.state === "refused") continue;
      const result = await this.check(task, effect.check);
      effect.checkedAt = this.iso(); effect.detail = result.detail;
      effect.state = result.ok ? "confirmed" : "unknown";
    }
    await this.deps.store.saveTask(task);
    return !(task.effects ?? []).some(effect => effect.state === "unknown" || effect.state === "started");
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
    if (!["requeue", "continue", "mark_failed", "mark_verified"].includes(action)) throw new AgentOpsError("BAD_REQUEST", "Неизвестное действие.");
    if (!["unknown_outcome", "blocked", "failed", "awaiting_verification"].includes(task.state)) throw new AgentOpsError("BAD_STATE", `Задача в состоянии ${task.state}; решение не требуется.`);
    if (this.watching.has(id)) throw new AgentOpsError("STILL_RUNNING", "Процесс исполнителя ещё работает; дождитесь его завершения или отмените задачу.");
    if (this.verifying.has(id)) throw new AgentOpsError("STILL_RUNNING", "Приёмщик ещё проверяет результат.");
    if (action === "mark_verified") {
      if (identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Подтвердить результат без проверок может только владелец.", {}, 403);
      if (!note?.trim()) throw new AgentOpsError("BAD_REQUEST", "Нужно основание независимой проверки владельцем.");
      const evidence = task.contract!.criteria.map(c => ({ id: randomUUID(), criterionId: c.id, attempt: task.attempts.at(-1)?.n ?? 0, revision: task.contract!.revision, checkIndex: -1, source: `owner:${identity.id}`, observedAt: this.iso(), independent: true as const, ok: true, detail: note, digest: createHash("sha256").update(note).digest("hex") }));
      (task.evidence ??= []).push(...evidence);
      await this.saveReview(task, makeReview(task, evidence.map(e => ({ criterionId: e.criterionId, status: "confirmed", evidenceIds: [e.id], reason: `Независимое подтверждение владельцем: ${note}` })), "accept", `Подтверждено владельцем: ${note}`, "Задача принята владельцем.", this.iso()));
      task.reviewPending = false;
      await this.finish(task, "verified", `Подтверждено владельцем${note ? `: ${note}` : ""}.`);
    } else if (action === "mark_failed") {
      await this.finish(task, "failed", `Отмечено как ошибка (${identity.id})${note ? `: ${note}` : ""}.`);
    } else {
      if (!(await this.reconcileEffects(task))) throw new AgentOpsError("UNKNOWN_EFFECT", "Исход внешнего действия неизвестен. Сначала восстановите его состояние через журнал действий.");
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
    if (!["awaiting_verification", "failed", "unknown_outcome", "blocked"].includes(task.state) || !task.attempts.length) throw new AgentOpsError("BAD_STATE", "Проверять нечего: задача ещё не выполнена.");
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
    if (this.closed) return;
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

    for (const task of this.tasks.values()) if (task.state === "awaiting_verification" && task.reviewPending && !task.pauseRequestedAt && !task.cancelRequestedAt && !this.verifying.has(task.id)
      && (!task.nextAttemptAt || Date.parse(task.nextAttemptAt) <= this.now())) void this.runVerification(task).catch(error => this.recoverVerificationError(task, error));

    const waiting = [...this.tasks.values()].filter(task => WAITING_STATES.has(task.state) && !this.running.has(task.id) && !task.pauseRequestedAt && !this.verifying.has(task.id) && (!task.nextAttemptAt || Date.parse(task.nextAttemptAt) <= this.now()))
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
    const policy = this.deps.registry.policyForAgent(task.agentId);
    return rankExecutors({ spec: task.spec, policy, adapters: this.deps.adapters, probes: this.probes });
  }

  private async tryStart(task: AgentTask): Promise<void> {
    if (task.cancelRequestedAt) { await this.finish(task, "cancelled", "Отменена до запуска."); return; }
    if (task.pauseRequestedAt) { await this.setState(task, "paused", "Приостановлена до запуска."); return; }
    if (task.dependsOn?.length) {
      const dependencies = task.dependsOn.map(id => this.tasks.get(id));
      if (dependencies.some(child => !child || child.state === "failed" || child.state === "cancelled" || child.state === "blocked")) { await this.setState(task, "blocked", `Подзадача требует решения: ${task.dependsOn.join(", ")}`); return; }
      if (dependencies.some(child => child!.state !== "verified")) { await this.wait(task, "waiting_executor", `Ждёт приёмки подзадач: ${task.dependsOn.join(", ")}`); return; }
      task.nextStep = `Продолжить с независимо принятыми подзадачами: ${dependencies.map(child => `${child!.id}: ${child!.result?.summary ?? child!.reason}`).join("; ")}`;
      task.dependsOn = undefined;
    }
    if (task.attempts.filter(attempt => !attempt.resourceWait).length >= (task.spec.retry?.maxAttempts ?? 4)) { await this.blockBudget(task, "Исчерпан бюджет попыток; результат ещё не принят."); return; }
    const budget = this.chainBudget(task.chain.rootTaskId);
    if (budget.wallMinutesLeft <= 0 || budget.activeMinutesLeft <= 0 || this.budgetUsage(task).activeMinutesLeft <= 0 || this.now() - Date.parse(task.createdAt) > (task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES) * 60000) { await this.blockBudget(task, "Истёк бюджет времени поручения или цепочки; результат ещё не принят."); return; }

    const candidates = this.rank(task);
    const suitable = candidates.filter(candidate => candidate.suitable);
    if (suitable.length && suitable.every(candidate => candidate.tier === "subscription") && budget.subscriptionRunsLeft <= 0) { await this.blockBudget(task, "Бюджет подписочных шагов задачи исчерпан; это не утверждение о квоте провайдера."); return; }
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
      if (excluded) { const temporary = /лимит|частоты/.test(excluded); if (!temporary || !this.deps.ledger.availability(candidate.executorId, candidate.tier).usable) { notes.push(`${candidate.label}: ${excluded}`); if (temporary) permanent = false; continue; } delete task.excludedExecutors[candidate.executorId]; }
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
      else { await this.wait(task, "waiting_executor", `Ждёт исполнителя: ${notes.join("; ")}.`); await this.recordWaiting(task); }
      return;
    }

    const adapter = this.adapter(chosen.executorId)!;
    if (!(await this.reconcileEffects(task))) { await this.setState(task, "unknown_outcome", "Исход внешнего действия неизвестен; сначала восстановить состояние. Повторное исполнение запрещено."); return; }
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
    if (request.class === "heavy" && !this.deps.registry.policyForAgent(task.agentId).canUseHeavyGpu) { this.deps.locks.releaseOwner(task.id); await this.setState(task, "blocked", "Политика поручителя не разрешает тяжёлую работу GPU.", "permissions"); return; }
    const decision = await this.deps.dispatcher.acquire({ ...request, holder: task.id, agentId: task.agentId, purpose: `${task.id} · ${adapter.label}`, origin: "agent",
      ttlMs: 5 * 60_000 });
    if (!decision.granted) {
      // Never hold the working copy while waiting for GPU/RAM or the work window.
      this.deps.locks.releaseOwner(task.id);
      task.lockKeys = [];
      await this.wait(task, decision.waitFor === "window" ? "waiting_window" : "waiting_resources", decision.reason);
      return;
    }
    if (Object.entries(task.spec.resourceLimits ?? {}).some(([key, limit]) => decision.lease[key as "vramMiB" | "ramMiB" | "cpuSlots"] > limit)) { this.deps.dispatcher.release(decision.lease.id); await this.blockBudget(task, "Оценка ресурсов исполнителя превышает ограничения контракта."); this.deps.locks.releaseOwner(task.id); return; }
    await this.launch(task, adapter, decision.lease);
  }

  private async launch(task: AgentTask, adapter: ExecutorAdapter, lease: Lease): Promise<void> {
    const attempt: Attempt = { n: task.attempts.length + 1, executor: adapter.id, startedAt: this.iso(), strategy: task.strategy ?? "original", baseline: await this.snapshot(task.workdir) };
    if (adapter.profile.gatewayManaged) attempt.modelCalls = [];
    if (task.cancelRequestedAt || task.pauseRequestedAt || this.closed) { this.deps.dispatcher.release(lease.id); this.deps.locks.releaseOwner(task.id); task.lockKeys = []; if (task.cancelRequestedAt) await this.finish(task, "cancelled", "Отменена до запуска."); else if (task.pauseRequestedAt) await this.setState(task, "paused", "Приостановлена до запуска."); return; }
    const partial = task.attempts.at(-1)?.changedFiles?.length && task.spec.onPartial === "continue" ? task.attempts.at(-1) : undefined;
    task.attempts.push(attempt);
    task.executor = adapter.id;
    task.leaseId = lease.id;
    task.startedAt ??= attempt.startedAt;
    const controller = new AbortController();
    const end = adapter.profile.gatewayManaged ? () => {} : this.deps.ledger.begin(adapter.id);
    const heartbeat = setInterval(() => { this.deps.dispatcher.heartbeat(lease.id); }, 30_000);
    heartbeat.unref?.();
    this.running.set(task.id, { controller, heartbeat, adapter });
    await this.setState(task, "running", `Выполняет ${adapter.label}.`, "started", { executor: adapter.id, leaseId: lease.id, attempt: attempt.n });

    const budget = this.chainBudget(task.chain.rootTaskId);
    const wallMinutes = Math.max(1 / 60, Math.min((task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES) - (this.now() - Date.parse(task.createdAt)) / 60000, budget.wallMinutesLeft, budget.activeMinutesLeft, this.budgetUsage(task).activeMinutesLeft));
    const childIdentity = this.deps.registry.taskAgent(task.id, `${adapter.label} · ${task.title}`);
    const token = this.deps.registry.issueTaskToken(task.id, (wallMinutes + 30) * 60_000);
    const brief = agentBrief(childIdentity, { taskId: task.id, chainDepth: task.chain.depth, apiUrl: this.deps.apiUrl,
      budget: `${budget.tasksLeft} sub-tasks, ${budget.subscriptionRunsLeft} subscription runs, ${budget.wallMinutesLeft} min` });
    const log = (line: string) => { void this.deps.store.appendLog(task.id, `${new Date(this.now()).toISOString()} ${line}\n`); };
    const context = { origin: "agent" as const, agentId: childIdentity.id, taskId: task.id, heldRuntimes: lease.runtimeId ? [lease.runtimeId] : [] };
    let timeout: NodeJS.Timeout | undefined;
    const interrupted = new Promise<ExecutorOutcome>(resolve => {
      timeout = setTimeout(() => { controller.abort(); resolve({ ok: false, failureClass: "timeout", message: "Истёк лимит времени этапа исполнителя." }); }, wallMinutes * 60000);
      this.running.get(task.id)!.timeout = timeout;
      controller.signal.addEventListener("abort", () => { if (attempt.pid) killProcessTree(attempt.pid); resolve({ ok: false, failureClass: task.cancelRequestedAt ? "cancelled" : "timeout", message: task.cancelRequestedAt ? "Отменено поручителем." : "Истёк лимит времени этапа." }); }, { once: true });
    });
    const outcome = opsContext.run(context, () => adapter.run({
      task: structuredClone(task), workdir: task.workdir, prompt: buildTaskPrompt(task, partial), brief, signal: controller.signal,
      env: { SNARKROUTE_AGENT_TOKEN: token, SNARKROUTE_TASK_ID: task.id, SNARKROUTE_API_URL: this.deps.apiUrl },
      timeoutMs: wallMinutes * 60_000, maxTurns: task.spec.budget?.maxTurns ?? 40, expectedModel: this.probes.get(adapter.id)?.model, log,
      remainingSubscriptionRuns: budget.subscriptionRunsLeft,
      onToolCall: async call => { (attempt.toolCalls ??= []).push(call); await this.persist(task, "tool_result", `${call.tool}: ${call.ok ? "получен результат" : "ошибка"}`, { callId: call.id, tool: call.tool, ok: call.ok }); },
      onModelCall: async call => { const existing = call.id && attempt.modelCalls?.find(c => c.id === call.id); if (existing) Object.assign(existing, call); else (attempt.modelCalls ??= []).push(call); attempt.requestedModel = call.model; if (call.ok) { attempt.model = call.model; attempt.provider = call.provider; } await this.persist(task, "model_call", `${call.provider} · ${call.model}: ${call.ok ? "ответ" : "запрос или ошибка"}`); },
      onPid: pid => {
        // Persisted at once: after a crash this pid is how SnarkRoute tells a live run from a lost one.
        attempt.pid = pid;
        void this.deps.store.saveTask(task);
        void processImage(pid).then(image => { if (image) { attempt.pidImage = image; return this.deps.store.saveTask(task); } });
      }
    }));
    void Promise.race([outcome, interrupted])
      .catch(error => ({ ok: false, failureClass: "process" as FailureClass, message: error instanceof Error ? error.message : String(error) }))
      .then(result => { if (timeout) clearTimeout(timeout); end(); return this.complete(task, attempt, result, lease); })
      .catch(error => this.recoverVerificationError(task, error))
      .finally(() => { clearInterval(heartbeat); end(); this.running.delete(task.id); this.kick(); });
  }

  private async complete(task: AgentTask, attempt: Attempt, outcome: ExecutorOutcome, lease: Lease): Promise<void> {
    if (this.closed) return; // A new process owns recovery after shutdown, never a late callback from this one.
    if (!outcome.ok && attempt.pid && await this.alive(attempt.pid, attempt.pidImage)) { this.watching.add(task.id); await this.setState(task, "unknown_outcome", `Процесс ${attempt.pid} ещё жив после прерывания; сначала дождаться завершения и восстановить результат. Повтор запрещён.`); return; }
    // Scarce resources go back first: verification and waiting never hold the GPU.
    this.deps.dispatcher.release(lease.id);
    task.leaseId = undefined;
    attempt.endedAt = this.iso();
    attempt.sessionId = outcome.sessionId;
    attempt.model = outcome.model ?? attempt.model;
    attempt.provider = outcome.provider ?? attempt.provider;
    attempt.changedFiles = changedPaths(attempt.baseline, await this.snapshot(task.workdir));
    const adapter = this.adapter(attempt.executor)!;
    if (outcome.quotaReport) this.deps.ledger.recordQuotaReport(adapter.id, outcome.quotaReport);
    if (outcome.budgetExhausted) { attempt.outcome = "failed"; attempt.failureClass = "budget"; attempt.error = outcome.budgetExhausted; await this.blockBudget(task, outcome.budgetExhausted); return; }
    if (outcome.waitForResources) { attempt.outcome = "unknown"; attempt.resourceWait = !attempt.modelCalls?.some(call => call.ok) && !attempt.toolCalls?.length; task.nextAttemptAt = this.retryAt(task, 30000); this.deps.locks.releaseOwner(task.id); task.lockKeys = []; await this.setState(task, "waiting_resources", outcome.waitForResources, "resource_wait"); await this.recordWaiting(task); return; }
    if (outcome.waitForTaskIds?.length) {
      attempt.outcome = "unknown"; task.dependsOn = outcome.waitForTaskIds; task.nextStep = outcome.message;
      this.deps.locks.releaseOwner(task.id); task.lockKeys = [];
      await this.setState(task, "waiting_executor", `Работа сохранена; ждёт подзадач ${outcome.waitForTaskIds.join(", ")}.`, "delegated_wait"); return;
    }
    if (outcome.ok) {
      attempt.outcome = "succeeded";
      this.deps.ledger.recordSuccess(adapter.id);
      const artifactPath = outcome.artifactText ? await this.deps.store.writeArtifact(task.id, "result.md", outcome.artifactText) : undefined;
      task.result = {
        summary: (outcome.summary ?? outcome.message).slice(0, 20_000), executor: adapter.id, model: outcome.model, provider: outcome.provider, changedFiles: attempt.changedFiles,
        checks: [], workdir: task.workdir, branch: task.worktree?.branch, artifactPath, usage: outcome.usage,
        cost: { tier: adapter.profile.costTier, providerCost: 0, note: adapter.profile.costTier === "subscription" ? "Подписка: без оплаты за запрос, расходует квоту." : "Локально: 0." }
      };
      await this.event(task, "executor_finished", `${adapter.label}: ${outcome.message} Изменено файлов: ${attempt.changedFiles.length}.`, { changedFiles: attempt.changedFiles.slice(0, 100) });
      if (task.cancelRequestedAt) { await this.finish(task, "cancelled", "Отменена; исполнитель успел завершить работу, результат сохранён без проверки."); return; }
      await this.runVerification(task).catch(error => this.recoverVerificationError(task, error));
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
    const errorVerdict = { criterionId: "executor", status: "missing" as const, evidenceIds: [], reason: `${failure}: ${attempt.error}` };
    const failureDecision = makeReview(task, [errorVerdict], ["quota_exhausted", "rate_limited", "model_unavailable"].includes(failure) ? "wait_resource" : failure === "auth" ? "owner_action" : "continue",
      `${failureLabel(failure)}: ${attempt.error}`, failure === "auth" ? "Восстановить вход исполнителя по подписке либо выбрать другого разрешённого исполнителя." : "Сохранить текущее состояние, проверить внешние действия и продолжить в рамках бюджета.", this.iso());
    failureDecision.failureSignature = createHash("sha256").update(`${failure}|${adapter.id}|${attempt.error?.replace(/\d+/g, "#")}`).digest("hex");
    failureDecision.resultFingerprint = createHash("sha256").update(JSON.stringify((await this.snapshot(task.workdir)).entries)).digest("hex");
    const repeated = (task.reviews ?? []).filter(review => review.failureSignature === failureDecision.failureSignature && review.resultFingerprint === failureDecision.resultFingerprint).length;
    if (repeated + 1 >= (task.spec.retry?.sameFailureLimit ?? 2) && failureDecision.decision === "continue") {
      failureDecision.decision = "change_approach"; task.strategy = `recovery-${attempt.n}`;
      failureDecision.nextStep = `Тот же сбой без изменения результата: требуется другая стратегия (${task.strategy}), новая диагностика или другой разрешённый исполнитель.`;
      if (this.rank(task).some(candidate => candidate.suitable && candidate.executorId !== adapter.id)) task.excludedExecutors[adapter.id] = "Повтор технического сбоя без прогресса";
    }
    await this.saveReview(task, failureDecision);
    if (task.pauseRequestedAt) { task.reviewPending = true; await this.setState(task, "paused", "Приостановлена после этапа исполнителя."); return; }
    if (!(await this.reconcileEffects(task)) || task.spec.permissions?.network && !task.effects?.length) { task.reviewPending = true; await this.setState(task, "unknown_outcome", "Исполнитель прерван после разрешённых внешних действий; сначала восстановить их состояние, без повторного запуска."); return; }

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
      await this.recordWaiting(task);
      return;
    }
    if ((failure === "network" || failure === "timeout" || failure === "process") && task.attempts.length < (task.spec.retry?.maxAttempts ?? 4)) {
      await this.setState(task, "queued", `${adapter.label}: ${failureLabel(failure)}; изменений нет, процесс завершён — повтор после паузы.`, "retry");
      task.nextAttemptAt = this.retryAt(task); await this.deps.store.saveTask(task);
      return;
    }
    await this.finish(task, "failed", `${adapter.label}: ${failureLabel(failure)} — ${outcome.message.slice(0, 300)}`);
  }

  private async runVerification(task: AgentTask): Promise<void> {
    if (this.verifying.has(task.id) || task.cancelRequestedAt || TERMINAL_STATES.has(task.state) && task.state !== "failed") return;
    task.contract ??= contractFor(task.spec); task.reviewPending = true;
    if (this.chainBudget(task.chain.rootTaskId).wallMinutesLeft <= 0 || this.chainBudget(task.chain.rootTaskId).activeMinutesLeft <= 0 || this.budgetUsage(task).activeMinutesLeft <= 0 || this.now() - Date.parse(task.createdAt) > (task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES) * 60000
      || (task.reviewRuns?.length ?? 0) >= (task.spec.review?.maxRuns ?? 12)) { await this.blockBudget(task, "Исчерпан бюджет времени или запусков Приёмщика; результат не принят."); return; }
    if (task.pauseRequestedAt) { await this.setState(task, "paused", "Приостановлена перед проверкой."); return; }
    // Separate claim processing from execution, including when the previous session crashed.
    const controller = new AbortController(); this.verifying.set(task.id, controller);
    const deadline = setTimeout(() => controller.abort(), Math.max(1000, Math.min((task.spec.budget?.wallMinutes ?? DEFAULT_WALL_MINUTES) * 60000 - (this.now() - Date.parse(task.createdAt)), this.budgetUsage(task).activeMinutesLeft*60000, this.chainBudget(task.chain.rootTaskId).activeMinutesLeft*60000)));
    const lock = this.deps.locks.tryAcquire(task.workdir ? [workspaceLockKey(task.workdir)] : [], { taskId: task.id, agentId: `acceptor:${task.id}` });
    if (!lock.ok) { clearTimeout(deadline); this.verifying.delete(task.id); task.nextAttemptAt = this.retryAt(task); await this.setState(task, "awaiting_verification", "Приёмщик ждёт блокировку рабочей папки."); return; }
    try {
      for (const run of task.reviewRuns ?? []) if (!run.endedAt && run.pid && await this.alive(run.pid, run.pidImage)) { if (run.leaseId) this.deps.dispatcher.heartbeat(run.leaseId); task.nextAttemptAt = this.retryAt(task); await this.setState(task, "awaiting_verification", `Проверяющий процесс ${run.pid} ещё работает после потери связи; второй не запускается.`); return; }
      for (const run of task.reviewRuns ?? []) if (!run.endedAt && (run.pid || !run.leaseId || !this.deps.dispatcher.get(run.leaseId))) { if (run.leaseId) this.deps.dispatcher.release(run.leaseId); run.endedAt = this.iso(); run.outcome = "unknown"; }
      if (task.reviewRuns?.some(run => !run.endedAt && !run.pid && run.leaseId && this.deps.dispatcher.get(run.leaseId))) { task.nextAttemptAt = this.retryAt(task, 30000); await this.setState(task, "awaiting_verification", "После потери связи проверяющей модели исход генерации ещё сверяется по ресурсу; второй запуск запрещён."); return; }
      const checks = task.spec.checks ?? [];
      await this.setState(task, "awaiting_verification", `Приёмщик: независимо проверяю ${checks.length} условий и ${task.contract.criteria.length} критериев.`, "verification");
      const results = [];
      const admission = await this.deps.dispatcher.acquire({ class: "light", cpuSlots: 1, ramMiB: 256, holder: task.id, agentId: `acceptor:${task.id}`, origin: "agent", purpose: `Приёмщик · ${task.id} · независимые проверки`, ttlMs: 300000 });
      if (!admission.granted) { task.nextAttemptAt = this.retryAt(task, 30000); await this.saveReview(task, makeReview(task, [], "wait_resource", admission.reason, "Дождаться ресурсов для независимой проверки.", this.iso())); return; }
      const verificationHeartbeat = setInterval(() => this.deps.dispatcher.heartbeat(admission.lease.id), 30000); verificationHeartbeat.unref?.();
      try { for (const check of checks) { if (controller.signal.aborted) return; results.push(await this.check(task, check, controller.signal)); } }
      finally { clearInterval(verificationHeartbeat); this.deps.dispatcher.release(admission.lease.id); }
      if (task.result) task.result.checks = results;
      else task.result = { summary: "Исход восстановлен по независимым проверкам.", executor: task.executor ?? "unknown", changedFiles: task.attempts.at(-1)?.changedFiles ?? [], checks: results, workdir: task.workdir, cost: { tier: this.adapter(task.executor)?.profile.costTier ?? "local", providerCost: 0, note: "" } };
      const evidence = evidenceFor(task, results, this.iso());
      (task.evidence ??= []).push(...evidence);
      let verdicts = machineVerdicts(task, evidence, this.now());
      const required = (id: string) => task.contract!.criteria.find(c => c.id === id)?.required !== false;
      const missing = () => verdicts.filter(v => required(v.criterionId) && v.status === "missing");
      let modelDecision: "accept" | "continue" | "escalate" | "blocked" | "owner_action" | undefined;
      let reason = "", nextStep = "", reviewer: import("./types").AcceptanceReview["reviewer"];
      // Deterministic failure is decisive; an LLM cannot override it or waive a criterion.
      if (!missing().length && (task.contract.criteria.some(c => c.review === "model") || task.spec.review?.forceStrong)) {
        const level = task.spec.review?.forceStrong || task.reviews?.some(r => r.decision === "change_approach") ? "strong" : "local";
        const subscriptionRunsLeft = () => { const budget = this.budgetUsage(task); return Math.min(this.chainBudget(task.chain.rootTaskId).subscriptionRunsLeft, budget.subscriptionRunsLimit - budget.subscriptionRunsUsed); };
        let assessment = this.deps.reviewer ? await this.deps.reviewer.review({ task, evidence, verdicts, level, signal: controller.signal, save: () => this.deps.store.saveTask(task), subscriptionRunsLeft }) : { status: "waiting" as const, reason: "Проверяющая модель не подключена; задача сохранена, требуется доступная модель или независимая проверка владельцем." };
        if (controller.signal.aborted) return;
        if (level === "local" && (assessment.status === "error" || assessment.status === "reviewed" && assessment.review.decision === "escalate")) {
          await this.event(task, "review_escalation", assessment.status === "error" ? assessment.reason : assessment.review.reason);
          assessment = this.deps.reviewer ? await this.deps.reviewer.review({ task, evidence, verdicts, level: "strong", signal: controller.signal, save: () => this.deps.store.saveTask(task), subscriptionRunsLeft }) : assessment;
        }
        if (controller.signal.aborted) return;
        if (assessment.status !== "reviewed") {
          if(assessment.status==="waiting" && subscriptionRunsLeft()<=0 && /бюджет подписочных/i.test(assessment.reason)) {
            await this.saveReview(task,makeReview(task,verdicts,"blocked",assessment.reason,"Сохранить результат; поручитель должен пересмотреть распределение бюджета. Новое исполнение или повторная отправка не разрешены.",this.iso()));
            await this.blockBudget(task,"Исчерпан бюджет подписочных шагов для обязательной независимой проверки; результат не принят.");return;
          }
          const decision = makeReview(task, verdicts, "wait_resource", assessment.reason, "Дождаться разрешённой проверяющей модели; исполнитель повторно не запускается.", this.iso());
          await this.saveReview(task, decision); task.nextAttemptAt = this.retryAt(task, 30000);
          await this.setState(task, "awaiting_verification", assessment.reason, "review_waiting", {waitingFor:"resourceWait" in assessment && assessment.resourceWait ? "resource":"executor"}); return;
        }
        verdicts = mergeModelVerdicts(task, verdicts, assessment.review, evidence);
        reviewer = assessment.reviewer; modelDecision = assessment.review.decision; reason = assessment.review.reason; nextStep = assessment.review.nextStep;
      }
      if (controller.signal.aborted || task.cancelRequestedAt) return;
      const unconfirmed = verdicts.filter(v => required(v.criterionId) && v.status !== "confirmed");
      if (!unconfirmed.length && (!modelDecision || modelDecision === "accept")) {
        if (!(await this.reconcileEffects(task))) { await this.saveReview(task, makeReview(task, verdicts, "blocked", "Критерии прошли, но исход внешнего действия ещё неизвестен.", "Восстановить журнал внешних действий.", this.iso())); await this.setState(task, "unknown_outcome", "Исход внешнего действия неизвестен."); return; }
        const review = makeReview(task, verdicts, "accept", reason || `Все обязательные критерии независимо подтверждены (${verdicts.length}); все проверки прошли.`, "Задача принята.", this.iso()); review.reviewer = reviewer;
        await this.saveReview(task, review); task.reviewPending = false;
        if (task.executor) this.deps.ledger.recordSuccess(task.executor, { verified: true });
        await this.finish(task, "verified", review.reason); return;
      }
      reason ||= unconfirmed.map(v => `${v.criterionId}: ${v.reason}`).join("; ").slice(0, 3000);
      nextStep ||= `Продолжить исходное поручение. Исправить и подтвердить: ${unconfirmed.map(v => `${v.criterionId} — ${v.reason}`).join("; ")}`;
      let decision: import("./types").AcceptorDecision = modelDecision === "blocked" || modelDecision === "owner_action" ? modelDecision
        : unconfirmed.some(v => v.status === "unverifiable" && task.contract!.criteria.find(c => c.id === v.criterionId)?.review === "unverifiable") ? "owner_action" : "continue";
      const review = makeReview(task, verdicts, decision, reason, nextStep, this.iso()); review.reviewer = reviewer;
      const previous = (task.reviews ?? []).filter(r => r.decision === "continue" || r.decision === "change_approach");
      const unchanged = previous.filter(r => r.failureSignature === review.failureSignature && r.resultFingerprint === review.resultFingerprint).length;
      if (unchanged + 1 >= (task.spec.retry?.sameFailureLimit ?? 2) && decision === "continue") {
        decision = "change_approach"; review.decision = decision;
        task.strategy = `strategy-${previous.filter(r => r.decision === "change_approach").length + 1}`;
        review.nextStep = `Изменить стратегию (${task.strategy}): повтор без новых данных или изменения результата запрещён. Сначала выяснить причину и получить новое доказательство. ${nextStep}`;
        // Prefer another suitable executor if one exists; one controlled strategy change is still allowed with a single executor.
        if (this.rank(task).some(c => c.suitable && c.executorId !== task.executor)) { task.excludedExecutors[task.executor!] = "Повтор без прогресса; требуется другой исполнитель"; task.spec.executor = "auto"; }
      }
      if (task.attempts.length >= (task.spec.retry?.maxAttempts ?? 4) && !["blocked", "owner_action"].includes(decision)) { review.decision = "blocked"; review.nextStep = "Исчерпан бюджет попыток; поручителю нужно пересмотреть подход или бюджет. Невыполненные критерии сохранены."; }
      if (!(await this.reconcileEffects(task)) || task.spec.permissions?.network && !task.effects?.length) { review.decision = "blocked"; review.nextStep = "Сначала восстановить исход внешних действий; неизвестный результат запрещает повтор."; await this.saveReview(task, review); await this.setState(task, "unknown_outcome", review.nextStep); return; }
      await this.saveReview(task, review);
      if (["blocked", "owner_action"].includes(review.decision)) { task.reviewPending = false; await this.setState(task, "blocked", `${review.reason} ${review.nextStep}`, "acceptor_blocked"); return; }
      task.reviewPending = false; task.spec.onPartial = "continue"; task.nextAttemptAt = this.retryAt(task);
      await this.setState(task, "queued", `Приёмщик вернул в работу: ${review.nextStep}`, "acceptor_continue");
      this.kick();
    } finally {
      clearTimeout(deadline);
      this.verifying.delete(task.id); this.deps.locks.releaseOwner(task.id); task.lockKeys = [];
      if (task.pauseRequestedAt && !task.cancelRequestedAt) await this.setState(task, "paused", "Приостановлена между этапами проверки.");
      else if (controller.signal.aborted && !task.cancelRequestedAt && !this.closed) await this.blockBudget(task, "Истёк общий бюджет времени Приёмщика; результат не принят.");
    }
  }

  private async check(task: AgentTask, check: NonNullable<TaskSpec["checks"]>[number], signal?: AbortSignal) {
    if (check.type === "acceptor_cycle") {
      const current = task.attempts.at(-1)!, prior = task.reviews?.find(review => ["continue", "change_approach"].includes(review.decision) && review.attempt < current.n && review.criteria.some(c => c.status !== "confirmed"));
      const ok = Boolean(prior && Date.parse(current.startedAt) >= Date.parse(prior.at));
      return { check, ok, detail: ok ? "Сервер сохранил отклонение неполного результата и последующую автоматически запущенную попытку." : "Предыдущего отклонения с новым исполнением пока нет.", content: JSON.stringify({ previousDecision: prior, currentAttempt: { n: current.n, startedAt: current.startedAt, executor: current.executor } }), source: "SnarkRoute:durable-task-history", observedAt: this.iso(), durationMs: 0 };
    }
    if (check.type === "tool_scope") {
      const calls = task.attempts.flatMap(a => a.toolCalls ?? []), unexpected = calls.filter(call => !check.allowed.includes(call.tool));
      const boundedBuzha = task.agentId === "app:buzha" && task.spec.actor === "buzha" && task.attempts.every(a => a.executor.startsWith("buzha_"));
      return { check, ok: unexpected.length === 0, detail: unexpected.length ? "Есть вызов вне заявленной области." : "Серверный журнал подтверждает имена всех действий внутри инструментального контура; проверка не утверждает состояние других процессов.", content: JSON.stringify({ allowed: check.allowed, boundary: boundedBuzha ? "Buzha structured actions are mediated by trusted server code. Model transport is text-only without native tools. Browser actions use the paired Profile 13 and the existing central SnarkBridge work policy. Protected actions remain refused centrally. A delivered click/upload is not proof of publication or sending. workspace_write only writes this task's local directory. This receipt is generated from server state, not the model report." : "Only the named mediated tools are audited; native executor activity is not covered by this check.", calls: calls.map(c => ({ id: c.id, at: c.at, tool: c.tool, arguments: c.arguments, ok: c.ok })) }), source: "SnarkRoute:server-mediated-tool-receipts", observedAt: this.iso(), durationMs: 0 };
    }
    if (check.type === "tool_observations") return this.deps.toolObservations ? this.deps.toolObservations(task) : { check, ok: false, detail: "Транспорт независимого наблюдения инструментов не подключён.", source: "actor-tool-observations", durationMs: 0, observedAt: this.iso() };
    if (check.type === "tool" || check.type === "tool_used") {
      const observedAt = this.iso(), source = `agent-tool:${check.tool}`;
      if (!task.spec.tools?.includes(check.tool)) return { check, ok: false, detail: "Инструмент не разрешён контрактом.", durationMs: 0, observedAt, source };
      if (check.type === "tool_used") {
        const candidates = check.effectKey ? task.attempts.flatMap(attempt => attempt.toolCalls ?? []) : task.attempts.at(-1)?.toolCalls ?? [];
        const calls = candidates.filter(call => call.tool === check.tool && call.ok && (!check.effectKey || call.effectKey === check.effectKey));
        return { check, ok: calls.length > 0, detail: calls.length ? "Фактический вызов и ответ инструмента сохранены сервером." : "В этой попытке нет успешного вызова инструмента.", content: JSON.stringify(calls), durationMs: 0, observedAt, source };
      }
      return this.deps.toolCheck ? this.deps.toolCheck(task, check) : { check, ok: false, detail: "Разрешённый транспорт проверки инструмента недоступен.", durationMs: 0, observedAt, source };
    }
    if (check.type === "command" && task.spec.permissions?.shell === "none" || check.type === "http" && !task.spec.permissions?.network) return { check, ok: false, detail: "Проверка требует полномочий, отсутствующих в контракте.", durationMs: 0, observedAt: this.iso(), source: JSON.stringify(check) };
    return runCheck(check, task.workdir, signal);
  }
  private retryAt(task: AgentTask, minimum = 0): string { return new Date(this.now() + Math.max(minimum, Math.min((task.spec.retry?.delayMs ?? 2000) * 2 ** Math.min(task.attempts.length - 1, 8), task.spec.retry?.maxDelayMs ?? 60000))).toISOString(); }
  private async saveReview(task: AgentTask, review: import("./types").AcceptanceReview): Promise<void> {
    (task.reviews ??= []).push(review); task.nextStep = review.nextStep;
    await this.persist(task, "acceptor_decision", `Приёмщик: ${review.decision} — ${review.reason}`, { review });
  }
  private async blockBudget(task: AgentTask, reason: string): Promise<void> { task.reviewPending = false; await this.saveReview(task, makeReview(task, task.reviews?.at(-1)?.criteria ?? [], "blocked", reason, "Поручителю нужно пересмотреть бюджет или подход; задача не выполнена.", this.iso())); await this.setState(task, "blocked", reason, "budget"); }
  private async recordWaiting(task: AgentTask): Promise<void> { if (task.reviews?.at(-1)?.decision !== "wait_resource" || task.reviews.at(-1)?.reason !== task.reason) await this.saveReview(task, makeReview(task, task.reviews?.at(-1)?.criteria ?? [], "wait_resource", task.reason, "Дождаться разрешённого исполнителя или ресурса; исходные требования сохранены.", this.iso())); }
  private async recoverVerificationError(task: AgentTask, error: unknown): Promise<void> { if (this.closed || task.cancelRequestedAt || task.state === "verified") return; task.reviewPending = true; task.nextAttemptAt = this.retryAt(task, 30000); await this.setState(task, task.pauseRequestedAt ? "paused" : "awaiting_verification", `Сбой Приёмщика; результат сохранён без приёмки: ${String(error)}`); }

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
      } else if (task.pauseRequestedAt && task.state !== "cancelled") {
        await this.setState(task, "paused", "Пауза восстановлена после перезапуска.");
      } else if (task.state === "awaiting_verification") {
        task.reviewPending = true;
        // Scheduling starts only after all tasks and locks have been restored.
        task.nextAttemptAt = undefined;
      } else if (task.state === "unknown_outcome" || task.state === "blocked") {
        this.deps.locks.confirm(task.id);
      } else if (TERMINAL_STATES.has(task.state) || WAITING_STATES.has(task.state)) {
        this.deps.locks.releaseOwner(task.id);
      }
      if (task.leaseId && task.state !== "unknown_outcome") { this.deps.dispatcher.release(task.leaseId); task.leaseId = undefined; }
    }
    // Locks and leases whose owner task is gone entirely are released.
    for (const lock of this.deps.locks.list()) if (!this.tasks.has(lock.ownerTaskId)) this.deps.locks.releaseOwner(lock.ownerTaskId);
    for (const lease of this.deps.dispatcher.list()) if (this.tasks.has(lease.holder) && this.tasks.get(lease.holder)!.state !== "unknown_outcome"
      && !this.tasks.get(lease.holder)!.reviewRuns?.some(run => !run.endedAt && run.leaseId === lease.id)) this.deps.dispatcher.release(lease.id, { measured: false });
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
    if (task.cancelRequestedAt) { await this.finish(task, "cancelled", "Отмена восстановлена после потери связи."); return; }
    if (task.pauseRequestedAt) { task.reviewPending = true; await this.setState(task, "paused", "Пауза восстановлена после потери связи."); return; }
    task.reviewPending = true;
    // Even if nothing changed on disk, an external result may exist. Read it before any retry.
    await this.setState(task, "awaiting_verification", `${reason}; исход передан независимому Приёмщику. Повтор возможен только после проверки результата и журнала действий.`, "restart");
    await this.runVerification(task).catch(error => this.recoverVerificationError(task, error));
  }

  // ---------------------------------------------------------------- state helpers

  private async wait(task: AgentTask, state: TaskState, reason: string): Promise<void> {
    if (task.state === state && task.reason === reason) return;
    await this.setState(task, state, reason, "waiting");
    await this.recordWaiting(task);
  }

  private async setState(task: AgentTask, state: TaskState, reason: string, eventType = "state", data?: Record<string, unknown>): Promise<void> {
    if (!task.waiting) task.waiting={since:this.iso(),minutes:0,resourceMinutes:0,pausedMinutes:0};
    const elapsed=Math.max(0,(this.now()-Date.parse(task.waiting.since))/60000);
    if (WAITING_STATES.has(task.state)||task.waiting.reason) task.waiting.minutes+=elapsed;
    if (task.state==="waiting_resources"||task.waiting.reason==="resource") task.waiting.resourceMinutes+=elapsed;
    if (task.state==="paused") task.waiting.pausedMinutes+=elapsed;
    task.waiting.since=this.iso();
    task.waiting.reason=data?.waitingFor as "resource"|"executor"|undefined;
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
  if (input.criteria && (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.length > 30)) throw new AgentOpsError("BAD_SPEC", "Нужны 1–30 критериев.", {}, 400);
  if (input.checks && (!Array.isArray(input.checks) || input.checks.length > 30)) throw new AgentOpsError("BAD_SPEC", "Слишком много проверок (максимум 30).", {}, 400);
  const checks = structuredClone(input.checks ?? []);
  for (const check of checks) {
    if (check.type === "command" && (!check.command?.trim() || /[\r\n]/.test(check.command))) throw new AgentOpsError("BAD_SPEC", "Команда проверки должна быть одной программой без переводов строк.", {}, 400);
    if (!["command", "file_exists", "file_contains", "file_content", "http", "process", "tool", "tool_used", "tool_observations", "acceptor_cycle", "tool_scope"].includes(check.type)) throw new AgentOpsError("BAD_SPEC", "Неизвестный тип проверки.", {}, 400);
    if (check.type === "http") { const url = new URL(check.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new AgentOpsError("BAD_SPEC", "HTTP проверка требует URL без учётных данных.", {}, 400); }
  }
  const ids = new Set<string>();
  for (const criterion of input.criteria ?? []) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(criterion.id) || ids.has(criterion.id) || !criterion.description?.trim() || !["machine", "model", "unverifiable"].includes(criterion.review)) throw new AgentOpsError("BAD_SPEC", "Критерий требует уникальный id, описание и способ проверки.", {}, 400);
    ids.add(criterion.id);
    if (criterion.checkIndexes?.some(i => !Number.isInteger(i) || i < 0 || i >= checks.length) || new Set(criterion.checkIndexes).size !== criterion.checkIndexes?.length && criterion.checkIndexes !== undefined) throw new AgentOpsError("BAD_SPEC", "Критерий ссылается на отсутствующую или повторную проверку.", {}, 400);
    if (criterion.review === "machine" && !criterion.checkIndexes?.length) throw new AgentOpsError("BAD_SPEC", "Машинный критерий требует проверку; иначе укажите unverifiable.", {}, 400);
  }
  const positive = (value: number | undefined, min: number, max: number) => value === undefined || Number.isFinite(value) && value >= min && value <= max;
  if (!positive(input.retry?.maxAttempts, 1, 100) || !positive(input.retry?.sameFailureLimit, 1, 20) || !positive(input.retry?.delayMs, 10, 3600000) || !positive(input.retry?.maxDelayMs, 10, 3600000)
    || !positive(input.budget?.wallMinutes, 1, 600) || !positive(input.budget?.activeMinutes, 1, 600) || !positive(input.budget?.subscriptionRuns, 0, 24) || !positive(input.budget?.maxTurns, 1, 200) || !positive(input.review?.maxRuns, 1, 100) || !positive(input.review?.timeoutMs, 1000, 900000)) throw new AgentOpsError("BAD_SPEC", "Некорректный бюджет или настройка повторов.", {}, 400);
  if (input.budget?.providerCost !== undefined && input.budget.providerCost !== 0) throw new AgentOpsError("BAD_SPEC", "Приёмщик не разрешает платные API; providerCost должен быть 0.", {}, 400);
  if (Object.values(input.resourceLimits ?? {}).some(value => !positive(value, 0, 1000000))) throw new AgentOpsError("BAD_SPEC", "Некорректные ограничения ресурсов.", {}, 400);
  if (input.effects && (input.effects.length > 30 || new Set(input.effects.map(e => e.key)).size !== input.effects.length || input.effects.some(e => !/^[a-zA-Z0-9_.-]{1,80}$/.test(e.key) || !e.description?.trim() || !e.check))) throw new AgentOpsError("BAD_SPEC", "Некорректный журнал внешних действий.", {}, 400);
  return {
    ...structuredClone(input),
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
    section("Immutable acceptance contract (you cannot waive, delete or weaken any item)", task.contract?.criteria.map(c => `${c.id} [${c.required === false ? "optional" : "required"}]: ${c.description}`)),
    `Expected result: ${task.contract?.expectedResult ?? spec.expectedResult ?? spec.goal}`,
    section("Inputs", spec.inputs),
    section("Constraints", spec.constraints),
    task.workdir ? `Working folder: ${task.workdir}. Stay inside it.${task.worktree ? ` It is a separate git worktree on branch ${task.worktree.branch}; commit there if the goal asks for a commit.` : ""}` : "No working folder: answer in text only.",
    section("Checks SnarkRoute will run itself after you finish (your report does not replace them)", spec.checks?.map(describeCheck)),
    partial ? `\nA previous attempt (${partial.executor}) stopped (${partial.failureClass ?? partial.outcome}) and left changes in: ${partial.changedFiles?.slice(0, 30).join(", ")}. Continue from the current state; do not redo finished work.` : "",
    task.nextStep ? `\nAcceptor continuation (${task.strategy ?? "original strategy"}): ${task.nextStep}` : "",
    task.effects?.length ? `\nExternal effects require a write-ahead reservation using POST /api/agent-ops/tasks/${task.id}/effects/{key} {action:"begin"}, with your agent token. Execute ONLY if execute=true. Reconcile afterward with {action:"reconcile"}. Never repeat confirmed/started/unknown actions. Journal: ${JSON.stringify(task.effects)}` : "",
    "\nWhen done, reply with a short summary: what you changed, how you checked it, and anything left undone. Do not claim checks passed unless you ran them."
  ].filter(part => part !== undefined).join("\n");
}

export function describeCheck(check: NonNullable<TaskSpec["checks"]>[number]): string {
  if (check.type === "command") return `run \`${[check.command, ...(check.args ?? [])].join(" ")}\` (exit code 0)`;
  if (check.type === "file_exists") return `file exists: ${check.path}`;
  if (check.type === "file_contains") return `file ${check.path} contains "${check.text.slice(0, 80)}"`;
  if (check.type === "file_content") return `read file content for independent review: ${check.path}`;
  if (check.type === "http") return `read ${check.url}: HTTP ${check.status ?? 200}${check.json ? `; ${check.json.path} = ${JSON.stringify(check.json.equals)}` : ""}${check.text ? `; contains ${check.text}` : ""}`;
  if (check.type === "tool") return `independent tool ${check.tool}: ${check.json ? `${check.json.path} = ${JSON.stringify(check.json.equals)}` : ""}${check.text ? ` contains ${check.text}` : ""}`;
  if (check.type === "tool_used") return `actual model tool call and response recorded: ${check.tool}`;
  if (check.type === "tool_observations") return "independently repeat permitted read tools and observe their current results";
  if (check.type === "acceptor_cycle") return "server-recorded rejection followed by actual automatic continuation";
  if (check.type === "tool_scope") return `actual tools stayed within ${check.allowed.join(", ")}`;
  return `process alive: ${check.pid} ${check.image ?? ""}`;
}

function failureLabel(failure: FailureClass): string {
  return ({ quota_exhausted: "лимит подписки исчерпан", rate_limited: "временное ограничение частоты", auth: "ошибка авторизации", network: "сеть или сервис недоступны",
    process: "сбой процесса", timeout: "превышено время", model_unavailable: "модель недоступна", cancelled: "отменено", verification: "проверка не прошла", budget: "исчерпан бюджет задачи" } as Record<FailureClass, string>)[failure];
}
