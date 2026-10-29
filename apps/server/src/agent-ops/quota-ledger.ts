import type { FailureClass } from "./types";

/**
 * What SnarkRoute knows about each executor's login and subscription quota,
 * with the source and time of every fact. Remaining quota is never invented:
 * without a provider report it stays "unknown", and old reports go stale.
 */

export type AuthState = "ok" | "not_logged_in" | "not_subscription" | "not_installed" | "unknown";
export type QuotaState = "unknown" | "reported" | "exhausted" | "rate_limited";

export type ExecutorLedgerEntry = {
  executorId: string;
  auth: { state: AuthState; detail?: string; checkedAt?: string; source?: string };
  quota: { state: QuotaState; usedPercent?: number; resetsAt?: string; source?: string; observedAt?: string; detail?: string; simulated?: boolean };
  nextAttemptAt?: string;
  lastFailure?: { class: FailureClass; at: string; message: string; simulated?: boolean };
  lastSuccessAt?: string;
  lastVerifiedAt?: string;
  day: string;
  runsToday: number;
  /** Everything SnarkRoute itself sent to this executor today (delegated runs and chat turns). */
  measured?: { day: string; delegatedRuns: number; chatTurns: number; inputTokens: number; outputTokens: number; lastAt?: string };
};

/**
 * What a ledger entry does and does not know. Provider reports (Codex session
 * windows, Claude rate-limit events) are plan-wide and include use outside
 * SnarkRoute; SnarkRoute's own counts cover only what went through it.
 */
export type LedgerCoverage = {
  measuredBySnarkRoute: { day: string; delegatedRuns: number; chatTurns: number; inputTokens: number; outputTokens: number; lastAt?: string; scope: string };
  providerReport: { state: QuotaState; usedPercent?: number; resetsAt?: string; source?: string; observedAt?: string; stale: boolean; scope: string } | null;
  externalUsage: { observed: false; note: string };
  ourLimits: { concurrent: number; sharedSubscriptionConcurrent: number; dailyRuns: number | null; activeRuns: number };
};

export type LedgerLimits = {
  maxConcurrentSubscriptionRuns: number;
  maxConcurrentPerExecutor: Record<string, number>;
  dailyRunsPerExecutor: Record<string, number>;
  dailyTasksPerAgent: number;
};

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
  maxConcurrentSubscriptionRuns: 2,
  maxConcurrentPerExecutor: { codex_cli: 1, claude_code: 1, local_route: 1 },
  dailyRunsPerExecutor: { codex_cli: 40, claude_code: 40 },
  dailyTasksPerAgent: 30
};

export type Availability = { usable: boolean; reason?: string; retryAt?: string; permanent?: boolean };

const QUOTA_STALE_MS = 30 * 60_000;
const UNKNOWN_RESET_BACKOFF_MS = 15 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
const NETWORK_BACKOFF_MS = 60_000;

export class QuotaLedger {
  private entries = new Map<string, ExecutorLedgerEntry>();
  private active = new Map<string, number>();
  private externalActivity = new Map<string, () => number>();
  limits: LedgerLimits = structuredClone(DEFAULT_LEDGER_LIMITS);

  constructor(private readonly options: { persist?: (state: { entries: ExecutorLedgerEntry[]; limits: LedgerLimits }) => Promise<void>; now?: () => number; day?: (now: number) => string } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private today(): string { return this.options.day?.(this.now()) ?? moscowDay(this.now()); }

  restore(state: { entries?: ExecutorLedgerEntry[]; limits?: Partial<LedgerLimits> }): void {
    for (const entry of state.entries ?? []) this.entries.set(entry.executorId, entry);
    if (state.limits) this.limits = { ...this.limits, ...state.limits };
  }

  entry(executorId: string): ExecutorLedgerEntry {
    let entry = this.entries.get(executorId);
    if (!entry) {
      entry = { executorId, auth: { state: "unknown" }, quota: { state: "unknown" }, day: this.today(), runsToday: 0 };
      this.entries.set(executorId, entry);
    }
    if (entry.day !== this.today()) { entry.day = this.today(); entry.runsToday = 0; }
    return entry;
  }

  list(): ExecutorLedgerEntry[] { return [...this.entries.keys()].map(id => this.view(id)); }

  /** The entry as callers should read it: expired limits cleared, stale reports downgraded to unknown. */
  coverage(executorId: string, tier: "local" | "subscription"): LedgerCoverage {
    const view = this.view(executorId);
    const today = this.today();
    const measured = view.measured?.day === today ? view.measured : { day: today, delegatedRuns: 0, chatTurns: 0, inputTokens: 0, outputTokens: 0 };
    const raw = this.entry(executorId).quota;
    return {
      measuredBySnarkRoute: { ...measured, scope: "только запросы через SnarkRoute (поручения и чаты по подписке)" },
      providerReport: tier === "subscription" && raw.observedAt ? { state: raw.state, usedPercent: raw.usedPercent, resetsAt: raw.resetsAt, source: raw.source, observedAt: raw.observedAt,
        stale: view.quotaStale || view.quota.state === "unknown" && raw.state === "reported", scope: "сведения провайдера о всём тарифе, включая использование вне SnarkRoute" } : null,
      externalUsage: { observed: false, note: tier === "subscription"
        ? "Сессии Codex/Claude вне SnarkRoute (приложения, терминал) не наблюдаются; их расход виден только в отчёте провайдера и только на момент последнего запуска через SnarkRoute."
        : "Локальный исполнитель: внешнего расхода квоты нет." },
      ourLimits: { concurrent: this.limits.maxConcurrentPerExecutor[executorId] ?? 1, sharedSubscriptionConcurrent: this.limits.maxConcurrentSubscriptionRuns,
        dailyRuns: this.limits.dailyRunsPerExecutor[executorId] ?? null, activeRuns: this.activeRuns(executorId) }
    };
  }

  /** A run SnarkRoute itself made (counted whatever its outcome). */
  recordMeasuredRun(executorId: string, run: { kind: "delegated" | "chat"; inputTokens?: number; outputTokens?: number }): void {
    const entry = this.entry(executorId);
    const day = this.today();
    if (entry.measured?.day !== day) entry.measured = { day, delegatedRuns: 0, chatTurns: 0, inputTokens: 0, outputTokens: 0 };
    if (run.kind === "delegated") entry.measured.delegatedRuns += 1; else entry.measured.chatTurns += 1;
    entry.measured.inputTokens += Math.max(0, Math.round(run.inputTokens ?? 0));
    entry.measured.outputTokens += Math.max(0, Math.round(run.outputTokens ?? 0));
    entry.measured.lastAt = new Date(this.now()).toISOString();
    void this.save();
  }

  view(executorId: string): ExecutorLedgerEntry & { activeRuns: number; quotaStale: boolean } {
    const entry = this.entry(executorId);
    const now = this.now();
    if ((entry.quota.state === "exhausted" || entry.quota.state === "rate_limited") && entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) <= now) {
      entry.quota = { state: "unknown", source: "expired-limit", observedAt: new Date(now).toISOString(), detail: `Предыдущее ограничение истекло ${entry.nextAttemptAt}` };
      entry.nextAttemptAt = undefined;
    }
    const quotaStale = entry.quota.state === "reported" && Boolean(entry.quota.observedAt) && now - Date.parse(entry.quota.observedAt!) > QUOTA_STALE_MS;
    return { ...structuredClone(entry), ...(quotaStale ? { quota: { ...entry.quota, state: "unknown" as const, detail: `Данные устарели (получены ${entry.quota.observedAt})` } } : {}), activeRuns: this.activeRuns(executorId), quotaStale };
  }

  registerExternalActivity(executorId: string, count: () => number): void { this.externalActivity.set(executorId, count); }

  activeRuns(executorId: string): number {
    return (this.active.get(executorId) ?? 0) + (this.externalActivity.get(executorId)?.() ?? 0);
  }

  availability(executorId: string, tier: "local" | "subscription"): Availability {
    const entry = this.view(executorId);
    if (entry.auth.state === "not_installed") return { usable: false, permanent: true, reason: `не установлен${entry.auth.detail ? `: ${entry.auth.detail}` : ""}` };
    if (entry.auth.state === "not_logged_in" || entry.auth.state === "not_subscription") return { usable: false, permanent: true, reason: `нет входа по подписке${entry.auth.detail ? `: ${entry.auth.detail}` : ""}` };
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > this.now()) {
      const label = entry.quota.state === "exhausted" ? "лимит подписки исчерпан" : entry.quota.state === "rate_limited" ? "временное ограничение частоты" : `пауза после ошибки (${entry.lastFailure?.class ?? "?"})`;
      return { usable: false, retryAt: entry.nextAttemptAt, reason: `${label} до ${entry.nextAttemptAt}${entry.quota.simulated || entry.lastFailure?.simulated ? " (симуляция)" : ""}` };
    }
    const perExecutor = this.limits.maxConcurrentPerExecutor[executorId] ?? 1;
    if (this.activeRuns(executorId) >= perExecutor) return { usable: false, reason: `занят: ${this.activeRuns(executorId)} из ${perExecutor} параллельных запусков` };
    if (tier === "subscription") {
      const total = [...new Set([...this.active.keys(), ...this.externalActivity.keys()])].filter(id => id !== "local_route").reduce((sum, id) => sum + this.activeRuns(id), 0);
      if (total >= this.limits.maxConcurrentSubscriptionRuns) return { usable: false, reason: `общий лимит одновременных подписочных запусков: ${this.limits.maxConcurrentSubscriptionRuns}` };
      const daily = this.limits.dailyRunsPerExecutor[executorId];
      if (daily !== undefined && entry.runsToday >= daily) return { usable: false, retryAt: nextMoscowMidnight(this.now()), reason: `дневной лимит запусков SnarkRoute (${daily}) исчерпан` };
    }
    return { usable: true };
  }

  begin(executorId: string): () => void {
    const entry = this.entry(executorId);
    entry.runsToday += 1;
    this.active.set(executorId, (this.active.get(executorId) ?? 0) + 1);
    void this.save();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active.set(executorId, Math.max(0, (this.active.get(executorId) ?? 1) - 1));
    };
  }

  recordAuth(executorId: string, state: AuthState, source: string, detail?: string): void {
    const entry = this.entry(executorId);
    entry.auth = { state, source, detail, checkedAt: new Date(this.now()).toISOString() };
    void this.save();
  }

  /** A provider-reported rate-limit window (e.g. Codex session file, Claude rate_limit_event). */
  recordQuotaReport(executorId: string, report: { usedPercent?: number; resetsAt?: string; exhausted?: boolean; source: string; detail?: string }): void {
    const entry = this.entry(executorId);
    const at = new Date(this.now()).toISOString();
    if (report.exhausted) {
      entry.quota = { state: "exhausted", usedPercent: report.usedPercent, resetsAt: report.resetsAt, source: report.source, observedAt: at, detail: report.detail };
      entry.nextAttemptAt = report.resetsAt ?? new Date(this.now() + UNKNOWN_RESET_BACKOFF_MS).toISOString();
    } else {
      entry.quota = { state: "reported", usedPercent: report.usedPercent, resetsAt: report.resetsAt, source: report.source, observedAt: at, detail: report.detail };
    }
    void this.save();
  }

  recordSuccess(executorId: string, options: { verified?: boolean } = {}): void {
    const entry = this.entry(executorId);
    const at = new Date(this.now()).toISOString();
    entry.lastSuccessAt = at;
    if (options.verified) entry.lastVerifiedAt = at;
    if (!["exhausted", "rate_limited"].includes(entry.quota.state)) entry.nextAttemptAt = undefined;
    if (entry.auth.state === "unknown") entry.auth = { state: "ok", source: "successful-run", checkedAt: at };
    void this.save();
  }

  recordFailure(executorId: string, failure: { class: FailureClass; message: string; resetsAt?: string; source: string; simulated?: boolean }): void {
    const entry = this.entry(executorId);
    const now = this.now();
    const at = new Date(now).toISOString();
    entry.lastFailure = { class: failure.class, at, message: failure.message.slice(0, 500), simulated: failure.simulated };
    if (failure.class === "quota_exhausted") {
      entry.quota = { state: "exhausted", resetsAt: failure.resetsAt, source: failure.source, observedAt: at, detail: failure.message.slice(0, 300), simulated: failure.simulated };
      entry.nextAttemptAt = failure.resetsAt ?? new Date(now + UNKNOWN_RESET_BACKOFF_MS).toISOString();
    } else if (failure.class === "rate_limited") {
      entry.quota = { state: "rate_limited", resetsAt: failure.resetsAt, source: failure.source, observedAt: at, detail: failure.message.slice(0, 300), simulated: failure.simulated };
      entry.nextAttemptAt = failure.resetsAt ?? new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString();
    } else if (failure.class === "auth") {
      entry.auth = { state: "not_logged_in", source: failure.source, detail: failure.message.slice(0, 300), checkedAt: at };
    } else if (failure.class === "network") {
      entry.nextAttemptAt = new Date(now + NETWORK_BACKOFF_MS).toISOString();
    }
    void this.save();
  }

  /** Clears a simulated limit (live tests must never leave a fake block behind). */
  correctTaskBudgetFailure(executorId: string): boolean {
    // Narrow upgrade repair for an internal task-budget stop, never a provider report.
    const entry = this.entry(executorId);
    if (!executorId.startsWith("buzha_") || !entry.quota.source?.startsWith("delegated run ") || !entry.lastFailure?.message.startsWith("Бюджет подписочных модельных шагов задачи исчерпан")) return false;
    entry.quota = { state: "unknown", source: "task-budget-correction", observedAt: new Date(this.now()).toISOString(), detail: "Исчерпался бюджет задачи; состояние провайдерской квоты неизвестно." };
    entry.nextAttemptAt = undefined; entry.lastFailure = { ...entry.lastFailure, class: "budget" }; void this.save(); return true;
  }

  /** Clears a simulated limit (live tests must never leave a fake block behind). */
  clearSimulation(executorId: string): void {
    const entry = this.entry(executorId);
    if (entry.quota.simulated) { entry.quota = { state: "unknown" }; entry.nextAttemptAt = undefined; }
    if (entry.lastFailure?.simulated) { entry.lastFailure = undefined; entry.nextAttemptAt = undefined; }
    void this.save();
  }

  private async save(): Promise<void> {
    await this.options.persist?.({ entries: [...this.entries.values()], limits: this.limits }).catch(() => undefined);
  }
}

export function moscowDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function nextMoscowMidnight(now: number): string {
  // Moscow has no DST: UTC+3 all year.
  const shifted = new Date(now + 3 * 3_600_000);
  shifted.setUTCHours(24, 0, 0, 0);
  return new Date(shifted.getTime() - 3 * 3_600_000).toISOString();
}
