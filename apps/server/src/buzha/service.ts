import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRegistry } from "../agent-ops/agents";
import type { AgentTaskService } from "../agent-ops/tasks";
import type { AgentIdentity, AgentTask, TaskSpec } from "../agent-ops/types";
import { AgentOpsError } from "../agent-ops/tasks";
import { buzhaHome, buzhaMemory, buzhaWorkspace } from "./memory";
import { BUZHA_TOOLS } from "./tools";
import { BUZHA_EXTERNAL_SCHEDULES, buzhaSchedules } from "./schedules";

export class BuzhaAgentService {
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private lastError = "";
  private pending = new Map<string, { content: string; run: Promise<any> }>();
  constructor(private readonly deps: { tasks: AgentTaskService; registry: AgentRegistry; memory?: typeof buzhaMemory; workspace?: (id: number) => string }) {}
  private memory(path?: string, body?: unknown) { return (this.deps.memory ?? buzhaMemory)(path, body); }
  start() { this.deps.registry.app("buzha", "Бужа"); this.timer = setInterval(() => { if (!this.polling) this.polling = this.poll().catch(e => { this.lastError = String(e); }).finally(() => { this.polling = undefined; }); }, 3000); this.timer.unref?.(); }
  close() { if (this.timer) clearInterval(this.timer); }

  async status(identity?: AgentIdentity) {
    let memory: any;
    try { memory = await this.memory(); this.lastError = ""; } catch (error) { this.lastError = String(error); }
    const canSeeAll = !identity || identity.kind === "owner" || identity.id === "app:buzha";
    const tasks = this.deps.tasks.list({ agentId: "app:buzha", limit: 60 }).filter(task => canSeeAll || task.spec.inputs?.includes(`requested-by:${identity!.id}`));
    const executors = [...this.deps.tasks.probeSnapshot()].filter(([id]) => id.startsWith("buzha_")).map(([id, probe]) => ({ id, ...probe }));
    const current = tasks.find(task => !["verified", "failed", "cancelled", "blocked"].includes(task.state)) ?? tasks[0];
    const actual = current?.attempts.flatMap(attempt => attempt.modelCalls ?? []).filter(call => call.ok).at(-1);
    const settings = buzhaSchedules(memory?.agent_schedule);
    const routingReason = current && Object.keys(current.excludedExecutors).length ? `Предыдущий подход недоступен: ${Object.entries(current.excludedExecutors).map(([executor, reason]) => `${executor}: ${reason}`).join("; ")}. ${current.reason}` : current?.reason;
    return { id: "buzha", name: "Бужа", persistentIdentity: true, memory: join(buzhaHome(), "data", "buzha.sqlite3"), identitySource: join(buzhaHome(), "identity.md"),
      connected: Boolean(memory), configuredModel: memory?.model || "auto · локальная подходящая модель, затем разрешённые подписки", actualModel: actual?.model ?? null, actualProvider: actual?.provider ?? null,
      configuredModelNote: memory?.model?.startsWith("openrouter:") ? "Исторический выбор OpenRouter сохранён. Постоянный исполнитель сейчас использует подходящие локальные модели и разрешённые подписки; этот API не включён в его роли. Платный API автоматически не используется." : "Маршрутизатор учитывает сложность, доступность и права. Локальная подходящая модель имеет приоритет; фактическая модель показана отдельно.",
      executor: current?.executor ?? null, reason: routingReason ?? (this.lastError || "Ожидает поручение"), executors, tools: BUZHA_TOOLS, browser: { sessionId: "default", profile: "Profile 13", policy: "existing-owner-policy; read-only tools" },
      limitations: ["Текстовый провайдер управляет проверенным структурированным циклом инструментов; native tool calling не объявляется.", "Отправка коммерческих сообщений, смена профилей, регистрация и платежи не разрешены этим набором инструментов.", "Локальная модель может ожидать GPU/RAM; неизвестная квота не считается свободной, платные API не используются."],
      messages: canSeeAll ? memory?.messages?.slice(-100) ?? [] : [], schedules: settings, tasks: tasks.map(task => this.view(task)), error: this.lastError || null };
  }
  task(id: string, identity: AgentIdentity): AgentTask { const task = this.deps.tasks.get(id); if (!task || task.agentId !== "app:buzha") throw new AgentOpsError("TASK_NOT_FOUND", "Задача Бужи не найдена.", {}, 404); if (identity.kind !== "owner" && identity.id !== "app:buzha" && !task.spec.inputs?.includes(`requested-by:${identity.id}`)) throw new AgentOpsError("NOT_OWNER", "Это поручение другого отправителя.", {}, 403); return task; }
  view(task: AgentTask) { return { ...task, taskBudget: this.deps.tasks.budgetUsage(task), chainBudget: this.deps.tasks.chainBudget(task.chain.rootTaskId) }; }
  private memoryTask(task: AgentTask) { return { id: task.id, state: task.state, reason: task.reason.slice(0, 3000), nextStep: task.nextStep?.slice(0, 3000), attempts: task.attempts.slice(-1).map(a => ({ model: a.model, provider: a.provider, executor: a.executor })), result: { summary: task.result?.summary.slice(0, 12000) }, reviews: task.reviews?.slice(-1).map(r => ({ decision: r.decision, criteria: r.criteria.map(c => ({ criterionId: c.criterionId, status: c.status })) })), evidence: task.evidence?.slice(-10).map(e => ({ id: e.id })) }; }

  async submit(identity: AgentIdentity, input: { content: string; requestKey: string; quality?: "normal" | "high"; demo?: boolean; contract?: Partial<TaskSpec>; existingMessageId?: number }) {
    if (!input.requestKey?.trim() || !input.content?.trim() || input.content.length > 40000) throw new AgentOpsError("BAD_REQUEST", "Нужны поручение и устойчивый requestKey.");
    const key = `${identity.id}:${input.requestKey}`, active = this.pending.get(key); if (active) { if (active.content !== input.content) throw new AgentOpsError("IDEMPOTENCY_CONFLICT", "Один requestKey нельзя использовать для другого поручения."); return active.run; }
    const run = this.submitOnce(identity, input).finally(() => this.pending.delete(key)); this.pending.set(key, { content: input.content, run }); return run;
  }
  private async submitOnce(identity: AgentIdentity, input: { content: string; requestKey: string; quality?: "normal" | "high"; demo?: boolean; contract?: Partial<TaskSpec>; existingMessageId?: number }) {
    // Never accept another agent's proposed permission expansion as an owner's setting.
    if (input.contract && identity.kind !== "owner") throw new AgentOpsError("OWNER_ONLY", "Произвольный контракт Бужи задаёт только владелец; другим агентам доступен ограниченный рабочий контур.", {}, 403);
    if (input.existingMessageId && identity.kind !== "owner" && identity.id !== "app:buzha") throw new AgentOpsError("NOT_OWNER", "Привязка существующей переписки разрешена только Буже и владельцу.", {}, 403);
    const record = await this.memory("/api/agent/inbox", { ...input, requesterId: identity.id });
    const requester = JSON.parse(record.payload).requesterId;
    if (requester && requester !== identity.id && identity.kind !== "owner" && identity.id !== "app:buzha") throw new AgentOpsError("IDEMPOTENCY_CONFLICT", "Этот requestKey принадлежит другому отправителю.", {}, 403);
    if (record.task_id) { const task = this.deps.tasks.get(record.task_id); if (task) return { task: this.view(task), deduplicated: true }; throw new AgentOpsError("TASK_NOT_FOUND", "Память ссылается на отсутствующую задачу; требуется восстановление, повторное действие не запускается."); }
    const workspace = (this.deps.workspace ?? buzhaWorkspace)(record.user_message_id); await mkdir(workspace, { recursive: true });
    const quality = input.quality === "high" || input.demo ? "high" : "normal";
    const spec: TaskSpec = {
      title: input.content.split(/\r?\n/)[0].slice(0, 100), actor: "buzha", goal: input.content,
      inputs: [`requested-by:${JSON.parse(record.payload).requesterId ?? identity.id}`],
      expectedResult: "Проверяемый ответ на исходное поручение с фактическими наблюдениями, источниками и явно указанными ограничениями в answer.md.",
      tools: BUZHA_TOOLS, workspace, permissions: { fileWrite: true, shell: "tests", network: false },
      requirements: { kind: "agent_tool", quality }, allowedExecutors: ["buzha_local", "buzha_codex", "buzha_claude", "codex_cli", "claude_code"], executor: quality === "normal" ? "buzha_local" : "buzha_codex",
      checks: [{ type: "file_content", path: "answer.md" }, { type: "tool_observations" }, { type: "tool_scope", allowed: BUZHA_TOOLS }], criteria: [{ id: "answer", description: input.content, review: "model", checkIndexes: [0, 1, 2] }],
      review: { forceStrong: quality === "high", maxRuns: 8 }, retry: { maxAttempts: 4, sameFailureLimit: 2, delayMs: 2000, maxDelayMs: 30000 }, budget: { wallMinutes: 30, subscriptionRuns: 6, maxTurns: 8, providerCost: 0 }
    };
    if (input.demo) {
      spec.review = { forceStrong: false, maxRuns: 8 };
      spec.goal += "\nControlled acceptance demonstration only. FIRST work attempt: call bridge_status and browser_sessions (batch the independent reads), then write answer.md containing only `SnarkBridge: ok` and stop with done:true. Intentionally omit Profile 13 and Проверено so the Acceptor detects the gap. On a continuation from the Acceptor, call the same real read tools, process their actual results, and write a complete answer.md containing `SnarkBridge: ok`, `Profile 13`, and `Проверено`. Do not send messages, navigate, modify accounts or contact commercial sites. Batch reads on the first model turn, write answer.md and done:true on the second turn.";
      spec.expectedResult = "Реальный вызов инструментов, подтверждённые SnarkBridge и Chrome Profile 13, полный answer.md после исправления предусмотренного недочёта.";
      spec.checks = [{ type: "tool", tool: "bridge_status", json: { path: "status", equals: "ok" } }, { type: "tool", tool: "browser_sessions", json: { path: "sessions.0.profile_directory", equals: "Profile 13" } },
        { type: "tool_used", tool: "bridge_status" }, { type: "tool_used", tool: "browser_sessions" }, { type: "file_contains", path: "answer.md", text: "SnarkBridge: ok" }, { type: "file_contains", path: "answer.md", text: "Profile 13" }, { type: "file_contains", path: "answer.md", text: "Проверено" },
        { type: "acceptor_cycle" }, { type: "tool_scope", allowed: ["bridge_status", "browser_sessions", "workspace_write"] }];
      spec.criteria = [{ id: "bridge", description: "Приёмщик независимо подтвердил ответ SnarkBridge", review: "machine", checkIndexes: [0] }, { id: "profile", description: "Независимо подтверждён именно Profile 13", review: "machine", checkIndexes: [1] },
        { id: "tool_cycle", description: "Настоящая модель вызвала инструменты и получила ответы", review: "machine", checkIndexes: [2, 3] }, { id: "complete_answer", description: "Полный ответ после продолжения", review: "machine", checkIndexes: [4, 5, 6] },
        { id: "automatic_continuation", description: "Сервер отклонил недочёт и автоматически запустил продолжение", review: "machine", checkIndexes: [7] }, { id: "safe_scope", description: "Не было отправок, навигации и изменений аккаунтов", review: "machine", checkIndexes: [8] }];
    }
    if (input.contract) { const allowed = new Set(["expectedResult", "checks", "criteria", "budget", "review"]); if (Object.keys(input.contract).some(key => !allowed.has(key))) throw new AgentOpsError("BAD_REQUEST", "Настраиваются только критерии, проверки и бюджет; личность, папка и инструменты остаются фиксированными."); Object.assign(spec, input.contract); }
    spec.idempotencyKey = `buzha:message:${record.user_message_id}`;
    const { task, deduplicated } = await this.deps.tasks.submit(this.deps.registry.app("buzha", "Бужа"), spec);
    await this.memory("/api/agent/bind", { requestKey: input.requestKey, taskId: task.id });
    await this.memory("/api/agent/update", { task: this.memoryTask(task) }); return { task: this.view(task), deduplicated };
  }
  async control(id: string, identity: AgentIdentity, action: "pause" | "resume" | "cancel" | "continue") {
    const task = this.deps.tasks.get(id); if (!task || task.agentId !== "app:buzha") throw new AgentOpsError("TASK_NOT_FOUND", "Задача Бужи не найдена.", {}, 404);
    if (identity.kind !== "owner" && identity.id !== "app:buzha" && !task.spec.inputs?.includes(`requested-by:${identity.id}`)) throw new AgentOpsError("NOT_OWNER", "Управлять этим поручением может отправитель или владелец.", {}, 403);
    // The public Buzha facade may manage only its own task; it never changes executor rights.
    const owner = identity.kind === "owner" ? identity : this.deps.registry.app("buzha", "Бужа");
    const result = action === "continue" ? await this.deps.tasks.resolve(id, owner, "continue", "Продолжить из интерфейса Бужи") : await this.deps.tasks[action](id, owner);
    await this.memory("/api/agent/update", { task: this.memoryTask(result) }); return this.view(result);
  }
  private async poll() {
    const memory = await this.memory();
    if (!memory.agent_schedule) await this.memory("/api/agent/schedules", BUZHA_EXTERNAL_SCHEDULES);
    for (const work of (memory.agent_work ?? []).slice(0, 100)) {
      if (!work.task_id) { const input = JSON.parse(work.payload); await this.submit(this.deps.registry.owner("recover canonical Buzha inbox"), { ...input, requestKey: work.request_key }); }
      else { const task = this.deps.tasks.get(work.task_id); if (task) await this.memory("/api/agent/update", { task: this.memoryTask(task) }); }
    }
  }
}
