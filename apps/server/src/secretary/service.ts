import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRegistry } from "../agent-ops/agents";
import { goalProgress, type GoalService, type GoalSource } from "../agent-ops/goals";
import type { AgentOpsStore } from "../agent-ops/store";
import { AgentOpsError, type AgentTaskService } from "../agent-ops/tasks";
import type { AgentIdentity, TaskKind } from "../agent-ops/types";

/**
 * D2: the Secretary as a persistent agent of the queue (app:secretary). It takes goals from the
 * Workshop, ChatGPT (MCP) and Telegram, registers them, has one executor plan the stages, hands the
 * stages to the queue in order, and writes reports on events that matter. It never asks the owner a
 * technical question: a bad plan is re-planned, a lost stage is the queue's business (D-03).
 */
export type SecretaryMessage = {
  id: string; requestKey: string; source: GoalSource; sender: string; text: string; createdAt: string;
  goalId?: string; planTaskId?: string; planAttempts: number; stageIds?: Record<string, string>;
  state: "received" | "planning" | "dispatched" | "closed"; note?: string; resolved?: string[];
};
export type SecretaryReport = { id: string; at: string; goalId?: string; kind: "goal_received" | "plan_ready" | "stage_accepted" | "needs_owner" | "goal_accepted" | "goal_stalled" | "replanned" | "daily_digest"; text: string };
export type PlannedStage = { key: string; title: string; goal: string; acceptance: string[]; after: string[]; kind: TaskKind; network: boolean };
type State = { messages: SecretaryMessage[]; reports: SecretaryReport[]; seen: string[]; lastDigest?: string };

const SECRETARY = { id: "secretary", label: "Секретарь" } as const;
const MAX_STAGES = 12;
const MAX_PLAN_ATTEMPTS = 3;
const KINDS: TaskKind[] = ["analysis", "text", "code_edit", "code_review", "agent_tool"];
const SOURCES: GoalSource[] = ["workshop", "chatgpt", "telegram", "agent", "mcp"];

/** Validates an executor's plan.json; anything malformed is a reason to re-plan, never to guess. */
export function parsePlan(raw: string): PlannedStage[] {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^﻿/, "")); } catch { throw new Error("plan.json не является JSON."); }
  const stages = (value as { stages?: unknown })?.stages;
  if (!Array.isArray(stages) || !stages.length || stages.length > MAX_STAGES) throw new Error(`Нужно от 1 до ${MAX_STAGES} этапов в stages.`);
  const keys = new Set<string>();
  const result = stages.map((item: any, index) => {
    const key = typeof item?.key === "string" && /^[a-z0-9_-]{1,32}$/i.test(item.key) ? item.key : `s${index + 1}`;
    if (keys.has(key)) throw new Error(`Повторный ключ этапа ${key}.`);
    keys.add(key);
    const goal = typeof item?.goal === "string" ? item.goal.trim() : "";
    if (goal.length < 20 || goal.length > 20_000) throw new Error(`Этап ${key}: нужна самодостаточная постановка (goal) от 20 символов.`);
    const title = typeof item?.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : goal.split(/\r?\n/)[0].slice(0, 120);
    const acceptance = Array.isArray(item?.acceptance) ? item.acceptance.filter((line: unknown): line is string => typeof line === "string" && line.trim().length > 0).map((line: string) => line.slice(0, 2000)).slice(0, 15) : [];
    if (!acceptance.length) throw new Error(`Этап ${key}: нужен хотя бы один критерий приёмки (acceptance).`);
    const after: string[] = Array.isArray(item?.after) ? item.after.filter((k: unknown): k is string => typeof k === "string") : [];
    return { key, title, goal, acceptance, after, kind: KINDS.includes(item?.kind) ? item.kind as TaskKind : "analysis", network: item?.network === true };
  });
  // Stages are submitted in order, so a dependency must come earlier: this also rules out cycles.
  result.forEach((stage, index) => {
    for (const dependency of stage.after) {
      const at = result.findIndex(other => other.key === dependency);
      if (at < 0) throw new Error(`Этап ${stage.key}: after ссылается на неизвестный этап ${dependency}.`);
      if (at >= index) throw new Error(`Этап ${stage.key} зависит от себя или от более позднего этапа.`);
    }
  });
  return result;
}

export class SecretaryService {
  private state: State = { messages: [], reports: [], seen: [] };
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private lastError = "";

  constructor(private readonly deps: { store: AgentOpsStore; tasks: AgentTaskService; goals: GoalService; registry: AgentRegistry; sandbox: string; now?: () => number; onReport?: (report: SecretaryReport) => void; workSummary?: () => Promise<{ needsOwner: number; stalled: number; active: number }>; dailyDigest?: boolean }) {}

  private iso(): string { return new Date(this.deps.now?.() ?? Date.now()).toISOString(); }
  private identity(): AgentIdentity { return this.deps.registry.app(SECRETARY.id, SECRETARY.label); }
  private save(): Promise<void> { return this.deps.store.writeState("secretary", this.state); }

  async init(): Promise<void> {
    const saved = await this.deps.store.readState<Partial<State>>("secretary", {});
    this.state = { messages: saved.messages ?? [], reports: saved.reports ?? [], seen: saved.seen ?? [], lastDigest: saved.lastDigest };
    this.identity();
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }

  /** One pass of the event loop; overlapping calls share the running one. */
  tick(): Promise<void> {
    this.ticking ??= this.advanceAll().then(() => { this.lastError = ""; }, error => { this.lastError = error instanceof Error ? error.message : String(error); }).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  status() {
    return { id: `app:${SECRETARY.id}`, error: this.lastError || null, messages: this.state.messages.slice(-50).reverse(), reports: this.state.reports.slice(-100).reverse() };
  }

  /** A goal said to the Secretary. Idempotent by requestKey (a dropped connection may resend). */
  async receive(sender: AgentIdentity, input: { text?: unknown; source?: unknown; requestKey?: unknown }): Promise<SecretaryMessage> {
    if (sender.kind === "anonymous") throw new AgentOpsError("IDENTITY_REQUIRED", "Секретарь принимает цели от владельца или агента с токеном.", {}, 401);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 20_000) throw new AgentOpsError("BAD_REQUEST", "Нужна цель текстом (до 20 000 символов).", {}, 400);
    const source = SOURCES.includes(input.source as GoalSource) ? input.source as GoalSource : sender.kind === "owner" ? "workshop" : "mcp";
    const key = typeof input.requestKey === "string" && input.requestKey.trim() ? input.requestKey.trim().slice(0, 200) : createHash("sha256").update(text).digest("hex").slice(0, 16);
    const requestKey = `${sender.id}:${key}`;
    const existing = this.state.messages.find(message => message.requestKey === requestKey);
    if (existing) return existing;
    const at = this.iso();
    const message: SecretaryMessage = { id: `m-${at.slice(0, 10).replace(/-/g, "")}-${createHash("sha256").update(requestKey + at).digest("hex").slice(0, 8)}`, requestKey, source, sender: sender.id, text, createdAt: at, planAttempts: 0, state: "received" };
    this.state.messages.push(message);
    if (this.state.messages.length > 1000) this.state.messages.splice(0, this.state.messages.length - 1000);
    await this.advance(message);
    await this.save();
    return message;
  }

  private report(kind: SecretaryReport["kind"], text: string, goalId?: string, dedupe?: string): void {
    const key = dedupe ?? `${kind}:${goalId ?? ""}`;
    if (this.state.seen.includes(key)) return;
    this.state.seen.push(key);
    if (this.state.seen.length > 5000) this.state.seen.splice(0, this.state.seen.length - 5000);
    const report: SecretaryReport = { id: `r-${this.iso().replace(/\D/g, "").slice(0, 14)}-${this.state.reports.length}`, at: this.iso(), goalId, kind, text };
    this.state.reports.push(report);
    if (this.state.reports.length > 2000) this.state.reports.splice(0, this.state.reports.length - 2000);
    this.deps.onReport?.(report);
  }

  /** A short morning report once a day (09:00 Moscow): goals in work, what waits for the owner, what is stuck elsewhere. */
  async maybeDigest(force = false): Promise<SecretaryReport | undefined> {
    const moscow = new Date((this.deps.now?.() ?? Date.now()) + 3 * 3600_000);
    const day = moscow.toISOString().slice(0, 10);
    if (!force && (!this.deps.dailyDigest || moscow.getUTCHours() < 9 || this.state.lastDigest === day)) return undefined;
    const goals = this.deps.goals.list(this.identity(), { states: ["active"], limit: 50 });
    const lines = goals.map(goal => `• ${goal.title} — ${goal.progress.percent}%${goal.progress.needsOwner ? ", нужен ты" : goal.progress.status === "stalled" ? ", застряла" : ""}`);
    const elsewhere = this.deps.workSummary ? await this.deps.workSummary().catch(() => undefined) : undefined;
    const text = [`Сводка на ${day}: целей в работе ${goals.length}.`, ...lines,
      elsewhere ? `У других агентов: нужен ты — ${elsewhere.needsOwner}, застряло — ${elsewhere.stalled}, в работе — ${elsewhere.active}.` : ""].filter(Boolean).join("\n");
    this.state.lastDigest = day;
    this.report("daily_digest", text, undefined, `digest:${day}:${force ? Date.now() : ""}`);
    await this.save();
    return this.state.reports.at(-1);
  }

  private async advanceAll(): Promise<void> {
    await this.maybeDigest();
    const open = this.state.messages.filter(item => item.state !== "closed");
    if (!open.length) return;
    for (const message of open) {
      try { await this.advance(message); }
      catch (error) { message.note = `Ошибка шага: ${error instanceof Error ? error.message : String(error)}`; }
    }
    await this.save();
  }

  private async advance(message: SecretaryMessage): Promise<void> {
    const me = this.identity();
    if (!message.goalId) {
      const goal = await this.deps.goals.create(me, { title: message.text.split(/\r?\n/)[0].slice(0, 200), description: message.text, source: message.source, assignee: me.id });
      message.goalId = goal.id;
      this.report("goal_received", `Цель принята: «${goal.title}». Раскладываю на этапы.`, goal.id);
    }
    const goal = this.deps.goals.require(message.goalId, me);
    if (goal.state !== "active") { message.state = "closed"; return; }
    if (!message.planTaskId) { await this.submitPlan(message, goal.id); return; }
    if (message.state === "planning") {
      const plan = this.deps.tasks.get(message.planTaskId);
      if (!plan || plan.state === "failed" || plan.state === "cancelled") { await this.replan(message, goal.id, `план не получен (${plan?.reason ?? "задача потеряна"})`); return; }
      if (plan.state !== "verified") return;
      let stages: PlannedStage[];
      try { stages = parsePlan(await readFile(join(plan.workdir ?? "", "plan.json"), "utf8")); }
      catch (error) { await this.replan(message, goal.id, error instanceof Error ? error.message : String(error)); return; }
      await this.dispatch(message, goal.id, stages);
      return;
    }
    if (message.state === "dispatched") await this.watch(message, goal.id);
  }

  private async submitPlan(message: SecretaryMessage, goalId: string, problem?: string): Promise<void> {
    const attempt = message.planAttempts + 1;
    const workspace = join(this.deps.sandbox, "secretary", goalId, `plan-${attempt}`);
    await mkdir(workspace, { recursive: true });
    const { task } = await this.deps.tasks.submit(this.identity(), {
      title: `План цели: ${message.text.split(/\r?\n/)[0].slice(0, 80)}`, goalId, workspace,
      goal: [
        `Владелец поставил цель:\n"""\n${message.text}\n"""`,
        "Разложи её на 1–12 последовательных проверяемых этапов и запиши plan.json в рабочей папке. Сами этапы не выполняй.",
        "Формат: {\"stages\":[{\"key\":\"s1\",\"title\":\"кратко\",\"goal\":\"самодостаточная постановка: исполнитель не увидит ничего, кроме неё\",\"acceptance\":[\"проверяемый критерий\"],\"after\":[\"ключи этапов, которые должны быть приняты раньше\"],\"kind\":\"analysis|text|code_edit|code_review|agent_tool\"}]}.",
        "Этап может зависеть только от более ранних этапов. Каждый этап даёт результат, который можно проверить независимо: answer.md с фактами, ссылками и ограничениями. Не планируй оплату, ввод паролей, юридические согласия и удаление аккаунтов: это остаётся за владельцем.",
        "acceptance — только то, что видно в самом answer.md (содержание, полнота, источники). Запреты и рамки («ничего не менять», «никуда не отправлять») пиши в goal, а не в acceptance: отсутствие действия доказать нельзя. Поле \"network\": true ставь только этапу, которому нужен интернет.",
        problem ? `Предыдущий план отклонён: ${problem}. Исправь это.` : ""
      ].filter(Boolean).join("\n\n"),
      expectedResult: "plan.json с этапами в описанном формате.",
      acceptance: ["plan.json — корректный JSON в описанном формате", "этапы вместе ведут к цели владельца, и каждый можно проверить независимо"],
      checks: [{ type: "file_content", path: "plan.json" }],
      criteria: [{ id: "plan", description: "План разбивает цель владельца на проверяемые этапы в нужном формате", review: "model", checkIndexes: [0] }],
      requirements: { kind: "analysis", quality: "high" }, permissions: { fileWrite: true, shell: "none", network: false },
      budget: { wallMinutes: 30, subscriptionRuns: 4 }, idempotencyKey: `secretary:plan:${message.id}:${attempt}`, allowDuplicate: true
    });
    message.planTaskId = task.id; message.planAttempts = attempt; message.state = "planning";
  }

  private async replan(message: SecretaryMessage, goalId: string, problem: string): Promise<void> {
    if (message.planAttempts >= MAX_PLAN_ATTEMPTS) {
      message.state = "closed"; message.note = `План не сложился за ${MAX_PLAN_ATTEMPTS} попытки: ${problem}`;
      await this.deps.goals.close(goalId, this.identity(), "cancelled", message.note);
      this.report("goal_stalled", `Не получилось разложить цель на этапы за ${MAX_PLAN_ATTEMPTS} попытки. Последняя причина: ${problem}`, goalId);
      return;
    }
    this.report("replanned", `План пересобирается: ${problem}`, goalId, `replan:${message.id}:${message.planAttempts}`);
    await this.submitPlan(message, goalId, problem);
  }

  private async dispatch(message: SecretaryMessage, goalId: string, stages: PlannedStage[]): Promise<void> {
    const ids: Record<string, string> = { ...(message.stageIds ?? {}) };
    for (const stage of stages) {
      if (ids[stage.key]) continue;
      const workspace = join(this.deps.sandbox, "secretary", goalId, `p${message.planAttempts}-${stage.key}`);
      await mkdir(workspace, { recursive: true });
      const { task } = await this.deps.tasks.submit(this.identity(), {
        title: stage.title, goal: stage.goal, goalId, workspace, after: stage.after.map(key => ids[key]).filter(Boolean),
        inputs: [`Цель владельца: ${message.text.slice(0, 4000)}`],
        acceptance: stage.acceptance, expectedResult: "answer.md с проверяемым результатом этапа: факты, ссылки, что не удалось и почему.",
        checks: [{ type: "file_content", path: "answer.md" }],
        criteria: [{ id: "stage", description: `answer.md показывает: ${stage.acceptance.join("; ")}`, review: "model", checkIndexes: [0] }],
        requirements: { kind: stage.kind, quality: "normal" }, permissions: { fileWrite: true, shell: "tests", network: stage.network },
        budget: { wallMinutes: 60, subscriptionRuns: 6 }, idempotencyKey: `secretary:stage:${goalId}:p${message.planAttempts}:${stage.key}`, allowDuplicate: true
      });
      ids[stage.key] = task.id;
      message.stageIds = { ...ids };
    }
    message.state = "dispatched";
    this.report("plan_ready", `План готов, ${stages.length} этап(ов): ${stages.map(stage => stage.title).join("; ")}.`, goalId);
  }

  /** Reports only what changes the owner's picture: an accepted stage, a question for him, the end of the goal. */
  private async watch(message: SecretaryMessage, goalId: string): Promise<void> {
    const stageIds = new Set(Object.values(message.stageIds ?? {}));
    const own = this.deps.goals.stages(goalId).filter(task => stageIds.has(task.id));
    for (const stage of own) {
      // A stage with no declared external actions has nothing to reconcile: continue it once from its
      // current result; stuck again, it is a failed approach and the goal is re-planned around it.
      if (stage.state === "unknown_outcome" && !stage.effects?.length) {
        if (!message.resolved?.includes(stage.id)) {
          message.resolved = [...(message.resolved ?? []), stage.id];
          await this.deps.tasks.resolve(stage.id, this.identity(), "continue", "Этап Секретаря без внешних действий: продолжить с текущего результата.");
        } else await this.deps.tasks.resolve(stage.id, this.identity(), "mark_failed", "Этап снова застрял без исхода; цель пойдёт другим планом.");
      }
      if (stage.state === "verified") this.report("stage_accepted", `Этап принят: «${stage.title}».${stage.result?.summary ? ` ${stage.result.summary.slice(0, 600)}` : ""}`, goalId, `accepted:${stage.id}`);
      if (stage.state === "blocked") this.report("needs_owner", `Нужен ты: «${stage.title}» — ${stage.reason}`, goalId, `blocked:${stage.id}:${stage.updatedAt}`);
    }
    const progress = goalProgress(own);
    if (progress.status === "all_accepted") {
      // Sub-tasks still running keep the goal open; the next pass closes it.
      await this.deps.goals.close(goalId, this.identity(), "done", "Все этапы приняты Приёмщиком.");
      message.state = "closed";
      this.report("goal_accepted", `Цель достигнута: все этапы (${progress.verified}) приняты.`, goalId);
    } else if (progress.status === "stalled") {
      // D-03: failed stages are a failed plan, not a question to the owner. Accepted results are kept.
      const failed = own.filter(task => task.state === "failed" || task.state === "cancelled");
      const accepted = own.filter(task => task.state === "verified");
      const problem = [`не вышли этапы: ${failed.map(task => `«${task.title}» — ${task.reason}`).join("; ")}`.slice(0, 3000),
        accepted.length ? `уже приняты (не повторять): ${accepted.map(task => `«${task.title}»: ${task.result?.summary ?? ""}`).join("; ")}`.slice(0, 3000) : ""].filter(Boolean).join(". ");
      message.stageIds = {}; message.resolved = [];
      await this.replan(message, goalId, problem);
    }
  }
}
