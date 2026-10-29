import { randomUUID } from "node:crypto";
import { sharedQuotaLedger } from "../agent-ops/ledger-instance";
import { join } from "node:path";
import {
  claudeAuthStatus,
  ClaudeCliError,
  runClaudeCode,
  type ClaudeAuthStatus,
  type ClaudeCliOptions,
  type ClaudeCodeResult,
  type ClaudeRateLimitInfo,
  type ClaudeStreamEvent
} from "./claude-code-cli";
import { boundedConcurrency, ConcurrencyGate, JsonConversationFile, JsonHistoryFile, KeyedSerializer } from "./subscription-common";

/**
 * Claude Subscription: the owner's Pro/Max plan used through the official
 * Claude Code CLI on this computer, for the owner's own tasks. Quota is the
 * subscription's usage window, not money; the API-equivalent cost the CLI
 * reports is kept for information and never booked as spending.
 */

export const CLAUDE_SUBSCRIPTION_PROVIDER = "claude_subscription";
export const CLAUDE_SUBSCRIPTION_MODEL_PREFIX = "subscriptions/anthropic/";
/** CLI aliases always point at the current model of each family, so no versioned id is pinned here. */
export const DEFAULT_CLAUDE_SUBSCRIPTION_ALIASES = ["opus", "sonnet", "haiku"] as const;
const AUTH_CACHE_MS = 60_000;
const UNKNOWN_RESET_BACKOFF_MS = 15 * 60_000;
const MODEL_UNAVAILABLE_BACKOFF_MS = 6 * 60 * 60_000;
const HISTORY_LIMIT = 500;

export type ClaudeSubscriptionHistoryEntry = {
  at: string;
  model: string;
  resolvedModel?: string;
  status: "succeeded" | "failed" | "cancelled";
  errorCode?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  apiEquivalentCostUsd?: number;
  conversation: boolean;
  caller?: string;
};

export type ClaudeSubscriptionQuota = {
  exhausted: boolean;
  exhaustedUntil?: string;
  lastRateLimit?: ClaudeRateLimitInfo;
  lastLimitMessage?: string;
  simulated?: boolean;
};

export type ClaudeConversation = { id: string; sessionId: string; model: string; createdAt: string; updatedAt: string; turns: number };

export type ClaudeSubscriptionChatRequest = {
  modelRef: string;
  prompt: string;
  systemPrompt?: string;
  /** Opaque id of a SnarkRoute conversation; each maps to its own Claude Code session. */
  conversationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  caller?: string;
  onEvent?: (event: ClaudeStreamEvent) => void;
};

export type ClaudeSubscriptionChatResult = ClaudeCodeResult & { conversationId?: string; modelRef: string; alias: string };

type Deps = { cli?: ClaudeCliOptions; run?: typeof runClaudeCode; authStatus?: typeof claudeAuthStatus; dataDirectory?: string; now?: () => number };

export class ClaudeSubscriptionService {
  private authCache?: { value: ClaudeAuthStatus; at: number };
  private quota: ClaudeSubscriptionQuota = { exhausted: false };
  private unavailableModels = new Map<string, { until: number; reason: string }>();
  private resolvedModels = new Map<string, string>();
  private readonly gate = new ConcurrencyGate(maxConcurrency, () => new ClaudeCliError("CANCELLED", "Запрос к Claude отменён в очереди."));
  private readonly serializer = new KeyedSerializer();
  private readonly history = new JsonHistoryFile<ClaudeSubscriptionHistoryEntry>(() => join(this.dataDirectory(), "history.json"), HISTORY_LIMIT);
  private readonly conversations = new JsonConversationFile<ClaudeConversation>(() => join(this.dataDirectory(), "conversations.json"));

  constructor(private readonly deps: Deps = {}) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private dataDirectory(): string { return this.deps.dataDirectory ?? join(process.cwd(), "data", "claude-subscription"); }

  aliases(env: NodeJS.ProcessEnv = process.env): string[] {
    const configured = env.CLAUDE_SUBSCRIPTION_MODELS?.split(",").map(item => item.trim().toLowerCase()).filter(item => /^[a-z0-9][a-z0-9.\-[\]]*$/.test(item));
    return configured?.length ? [...new Set(configured)] : [...DEFAULT_CLAUDE_SUBSCRIPTION_ALIASES];
  }

  async auth(force = false): Promise<ClaudeAuthStatus> {
    if (!force && this.authCache && this.now() - this.authCache.at < AUTH_CACHE_MS) return this.authCache.value;
    const value = await (this.deps.authStatus ?? claudeAuthStatus)(this.deps.cli);
    this.authCache = { value, at: this.now() };
    return value;
  }

  quotaState(): ClaudeSubscriptionQuota {
    if (this.quota.exhausted && this.quota.exhaustedUntil && Date.parse(this.quota.exhaustedUntil) <= this.now()) {
      this.quota = { exhausted: false, lastRateLimit: this.quota.lastRateLimit };
    }
    // A limit seen by a delegated coding run (or any other SnarkRoute path) applies to chat as well.
    const shared = sharedQuotaLedger().view("claude_code");
    if (!this.quota.exhausted && (shared.quota.state === "exhausted" || shared.quota.state === "rate_limited") && shared.nextAttemptAt && Date.parse(shared.nextAttemptAt) > this.now()) {
      return { ...this.quota, exhausted: true, exhaustedUntil: shared.nextAttemptAt, lastLimitMessage: shared.quota.detail ?? "Лимит зафиксирован общим учётом SnarkRoute.", ...(shared.quota.simulated ? { simulated: true } : {}) };
    }
    return { ...this.quota };
  }

  /** Turns running right now; the shared ledger counts them against the plan's concurrency. */
  get activeTurns(): number { return this.gate.active; }

  /** Live check of limit handling and fallback without spending the real quota. */
  simulateQuotaExhausted(seconds: number): ClaudeSubscriptionQuota {
    this.quota = { ...this.quota, exhausted: true, simulated: true, exhaustedUntil: new Date(this.now() + Math.min(600, Math.max(1, seconds)) * 1000).toISOString(), lastLimitMessage: "Simulated limit (smoke test)." };
    return this.quotaState();
  }

  clearSimulatedQuota(): ClaudeSubscriptionQuota {
    if (this.quota.simulated) this.quota = { exhausted: false, lastRateLimit: this.quota.lastRateLimit };
    return this.quotaState();
  }

  modelState(alias: string): { available: boolean; reason?: string; resolvedModel?: string } {
    const blocked = this.unavailableModels.get(alias);
    if (blocked && blocked.until > this.now()) return { available: false, reason: blocked.reason, resolvedModel: this.resolvedModels.get(alias) };
    if (blocked) this.unavailableModels.delete(alias);
    return { available: true, resolvedModel: this.resolvedModels.get(alias) };
  }

  async status() {
    const [auth, history] = await Promise.all([this.auth(), this.history.load()]);
    const day = this.now() - 24 * 60 * 60_000;
    const recent = history.filter(entry => Date.parse(entry.at) >= day);
    return {
      provider: CLAUDE_SUBSCRIPTION_PROVIDER,
      transport: "claude-code-cli",
      auth,
      quota: this.quotaState(),
      models: this.aliases().map(alias => ({ id: modelRefForAlias(alias), alias, ...this.modelState(alias) })),
      concurrency: { active: this.gate.active, queued: this.gate.queued, limit: maxConcurrency() },
      usage24h: {
        requests: recent.length,
        succeeded: recent.filter(entry => entry.status === "succeeded").length,
        limited: recent.filter(entry => entry.errorCode === "SUBSCRIPTION_LIMIT_REACHED").length,
        inputTokens: recent.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
        outputTokens: recent.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
        apiEquivalentCostUsd: Number(recent.reduce((sum, entry) => sum + (entry.apiEquivalentCostUsd ?? 0), 0).toFixed(4)),
        note: "apiEquivalentCostUsd is what the paid API would have charged; the subscription is not billed per request."
      },
      recent: history.slice(-20).reverse()
    };
  }

  async chat(request: ClaudeSubscriptionChatRequest): Promise<ClaudeSubscriptionChatResult> {
    const alias = aliasForModelRef(request.modelRef);
    if (!this.aliases().includes(alias)) {
      throw new ClaudeCliError("MODEL_UNAVAILABLE", `Модель ${request.modelRef} не входит в подписочный список Claude.`);
    }
    const quota = this.quotaState();
    if (quota.exhausted) {
      throw new ClaudeCliError("SUBSCRIPTION_LIMIT_REACHED", `Лимит подписки Claude исчерпан${quota.exhaustedUntil ? ` до ${quota.exhaustedUntil}` : ""}.`, { resetsAt: quota.exhaustedUntil, retryable: true });
    }
    const model = this.modelState(alias);
    if (!model.available) throw new ClaudeCliError("MODEL_UNAVAILABLE", model.reason ?? `Модель ${alias} недоступна.`);
    const auth = await this.auth();
    if (!auth.installed) throw new ClaudeCliError("CLI_NOT_INSTALLED", auth.reason ?? "Claude Code CLI не установлен.");
    if (!auth.subscription) {
      // A login may have happened since the cached check.
      const fresh = await this.auth(true);
      if (!fresh.subscription) throw new ClaudeCliError(fresh.loggedIn ? "NOT_SUBSCRIPTION" : "NOT_LOGGED_IN", fresh.reason ?? "Подписка Claude не подтверждена.");
    }
    // Turns of one conversation never interleave; different conversations run independently.
    return this.serializer.run(request.conversationId, () => this.gate.run(request.signal, () => this.runTurn(request, alias)));
  }

  async listConversations(): Promise<ClaudeConversation[]> {
    return this.conversations.list();
  }

  async forgetConversation(id: string): Promise<boolean> {
    const conversations = await this.conversations.load();
    const removed = conversations.delete(id);
    if (removed) await this.conversations.save();
    return removed;
  }

  private async runTurn(request: ClaudeSubscriptionChatRequest, alias: string): Promise<ClaudeSubscriptionChatResult> {
    const startedAt = this.now();
    const conversations = request.conversationId ? await this.conversations.load() : undefined;
    const existing = request.conversationId ? conversations?.get(request.conversationId) : undefined;
    const newSessionId = request.conversationId && !existing ? randomUUID() : undefined;
    try {
      const result = await (this.deps.run ?? runClaudeCode)({
        model: alias,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        sessionId: newSessionId,
        resumeSessionId: existing?.sessionId,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        onEvent: event => {
          if (event.type === "rate_limit") this.observeRateLimit(event.info);
          request.onEvent?.(event);
        }
      }, this.deps.cli);
      if (result.model && !result.model.startsWith("<")) this.resolvedModels.set(alias, result.model);
      if (result.rateLimit) this.observeRateLimit(result.rateLimit);
      if (request.conversationId && conversations) {
        const at = new Date(this.now()).toISOString();
        conversations.set(request.conversationId, {
          id: request.conversationId,
          sessionId: result.sessionId || existing?.sessionId || newSessionId!,
          model: alias,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          turns: (existing?.turns ?? 0) + 1
        });
        await this.conversations.save();
      }
      await this.history.record({ at: new Date(startedAt).toISOString(), model: alias, resolvedModel: result.model, status: "succeeded", durationMs: result.durationMs,
        inputTokens: result.usage.inputTokens + result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens, outputTokens: result.usage.outputTokens,
        apiEquivalentCostUsd: result.apiEquivalentCostUsd, conversation: Boolean(request.conversationId), caller: request.caller });
      return { ...result, conversationId: request.conversationId, modelRef: modelRefForAlias(alias), alias };
    } catch (error) {
      const code = error instanceof ClaudeCliError ? error.code : "CLI_ERROR";
      if (error instanceof ClaudeCliError) this.observeFailure(error, alias);
      await this.history.record({ at: new Date(startedAt).toISOString(), model: alias, status: code === "CANCELLED" ? "cancelled" : "failed", errorCode: code,
        durationMs: this.now() - startedAt, conversation: Boolean(request.conversationId), caller: request.caller });
      throw error;
    }
  }

  private observeRateLimit(info: ClaudeRateLimitInfo): void {
    this.quota = { ...this.quota, lastRateLimit: info };
    const exhausted = info.status === "rejected" || info.usingExtraUsage === true && process.env.CLAUDE_SUBSCRIPTION_ALLOW_EXTRA_USAGE !== "1";
    if (exhausted) {
      this.quota = { ...this.quota, exhausted: true, exhaustedUntil: info.resetsAt ?? new Date(this.now() + UNKNOWN_RESET_BACKOFF_MS).toISOString() };
    }
    sharedQuotaLedger().recordQuotaReport("claude_code", { exhausted, resetsAt: info.resetsAt, source: "claude rate_limit_event (chat)", detail: info.rateLimitType,
      usedPercent: info.utilization === undefined ? undefined : Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization) });
  }

  private observeFailure(error: ClaudeCliError, alias: string): void {
    if (error.code === "SUBSCRIPTION_LIMIT_REACHED") sharedQuotaLedger().recordFailure("claude_code", { class: "quota_exhausted", message: error.message, resetsAt: error.details.resetsAt, source: "claude chat" });
    if (error.code === "NOT_LOGGED_IN" || error.code === "NOT_SUBSCRIPTION") sharedQuotaLedger().recordFailure("claude_code", { class: "auth", message: error.message, source: "claude chat" });
    if (error.code === "SUBSCRIPTION_LIMIT_REACHED") {
      this.quota = { ...this.quota, exhausted: true, lastLimitMessage: error.message,
        exhaustedUntil: error.details.resetsAt ?? this.quota.exhaustedUntil ?? new Date(this.now() + UNKNOWN_RESET_BACKOFF_MS).toISOString() };
    } else if (error.code === "MODEL_UNAVAILABLE") {
      this.unavailableModels.set(alias, { until: this.now() + MODEL_UNAVAILABLE_BACKOFF_MS, reason: error.message });
    } else if (error.code === "NOT_LOGGED_IN" || error.code === "NOT_SUBSCRIPTION") {
      this.authCache = undefined;
    }
  }
}

export function modelRefForAlias(alias: string): string {
  return `${CLAUDE_SUBSCRIPTION_MODEL_PREFIX}${alias}`;
}

export function aliasForModelRef(modelRef: string): string {
  const trimmed = modelRef.trim();
  const tail = trimmed.startsWith(CLAUDE_SUBSCRIPTION_MODEL_PREFIX) ? trimmed.slice(CLAUDE_SUBSCRIPTION_MODEL_PREFIX.length) : trimmed.replace(/^claude_subscription:/, "");
  return tail.toLowerCase();
}

export function isClaudeSubscriptionModelRef(value: string | undefined): boolean {
  return Boolean(value && (value.startsWith(CLAUDE_SUBSCRIPTION_MODEL_PREFIX) || value.startsWith(`${CLAUDE_SUBSCRIPTION_PROVIDER}:`)));
}

function maxConcurrency(): number {
  return boundedConcurrency(process.env.CLAUDE_SUBSCRIPTION_MAX_CONCURRENCY);
}

let shared: ClaudeSubscriptionService | undefined;
export function claudeSubscription(): ClaudeSubscriptionService {
  return shared ??= new ClaudeSubscriptionService();
}

export function isClaudeSubscriptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_SUBSCRIPTION_ENABLED === "1";
}
