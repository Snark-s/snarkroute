import { spawn } from "node:child_process";
import { sharedQuotaLedger } from "../agent-ops/ledger-instance";
import { join } from "node:path";
import {
  codexAuthStatus,
  codexCliCommand,
  codexCliEnv,
  CodexCliError,
  codexLimitReached,
  codexListModels,
  deleteCodexSession,
  limitResetsAt,
  runCodexExec,
  type CodexAuthStatus,
  type CodexCliOptions,
  type CodexExecResult,
  type CodexRateLimitInfo,
  type CodexStreamEvent
} from "./codex-cli";
import { boundedConcurrency, ConcurrencyGate, JsonConversationFile, JsonHistoryFile, KeyedSerializer } from "./subscription-common";
import { readCodexQuota } from "./codex-quota";

/**
 * ChatGPT Subscription: the owner's ChatGPT Plus/Pro plan used through the
 * official Codex CLI on this computer, for the owner's own tasks. Quota is the
 * plan's usage windows, not money. The CLI reports no API-equivalent price, so
 * none is invented; booked cost is always 0.
 */

export const CHATGPT_SUBSCRIPTION_PROVIDER = "chatgpt_subscription";
export const CHATGPT_SUBSCRIPTION_MODEL_PREFIX = "subscriptions/openai/";
/** No -m flag: the CLI uses its current default model. Other aliases come live from `codex debug models`. */
export const CHATGPT_DEFAULT_ALIAS = "default";
const AUTH_CACHE_MS = 60_000;
const MODELS_CACHE_MS = 10 * 60_000;
const UNKNOWN_RESET_BACKOFF_MS = 15 * 60_000;
const MODEL_UNAVAILABLE_BACKOFF_MS = 6 * 60 * 60_000;
const HISTORY_LIMIT = 500;

export type ChatGptSubscriptionHistoryEntry = {
  at: string;
  model: string;
  resolvedModel?: string;
  status: "succeeded" | "failed" | "cancelled";
  errorCode?: string;
  durationMs: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  conversation: boolean;
  caller?: string;
};

export type ChatGptSubscriptionQuota = {
  exhausted: boolean;
  exhaustedUntil?: string;
  lastRateLimit?: CodexRateLimitInfo;
  lastLimitMessage?: string;
  simulated?: boolean;
};

export type ChatGptConversation = { id: string; sessionId: string; model: string; createdAt: string; updatedAt: string; turns: number };

export type ChatGptModelInfo = { alias: string; displayName: string; description?: string; priority: number };

export type ChatGptSubscriptionChatRequest = {
  modelRef: string;
  prompt: string;
  systemPrompt?: string;
  /** Opaque id of a SnarkRoute conversation; each maps to its own Codex session. */
  conversationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  caller?: string;
  onEvent?: (event: CodexStreamEvent) => void;
};

export type ChatGptSubscriptionChatResult = CodexExecResult & { conversationId?: string; modelRef: string; alias: string };

type Deps = {
  cli?: CodexCliOptions;
  run?: typeof runCodexExec;
  authStatus?: typeof codexAuthStatus;
  listModels?: typeof codexListModels;
  readQuota?: typeof readCodexQuota;
  deleteSession?: (sessionId: string) => Promise<boolean>;
  dataDirectory?: string;
  now?: () => number;
};

export class ChatGptSubscriptionService {
  private authCache?: { value: CodexAuthStatus; at: number };
  private modelsCache?: { value: ChatGptModelInfo[]; at: number };
  private quota: ChatGptSubscriptionQuota = { exhausted: false };
  private quotaCheckedAt = -Infinity;
  private quotaRefresh?: Promise<void>;
  private unavailableModels = new Map<string, { until: number; reason: string }>();
  private resolvedModels = new Map<string, string>();
  private readonly gate = new ConcurrencyGate(maxConcurrency, () => new CodexCliError("CANCELLED", "Запрос к ChatGPT отменён в очереди."));
  private readonly serializer = new KeyedSerializer();
  private readonly history = new JsonHistoryFile<ChatGptSubscriptionHistoryEntry>(() => join(this.dataDirectory(), "history.json"), HISTORY_LIMIT);
  private readonly conversations = new JsonConversationFile<ChatGptConversation>(() => join(this.dataDirectory(), "conversations.json"));

  constructor(private readonly deps: Deps = {}) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private dataDirectory(): string { return this.deps.dataDirectory ?? join(process.cwd(), "data", "chatgpt-subscription"); }

  /** `default` plus the account's live model list (or CHATGPT_SUBSCRIPTION_MODELS when set). */
  async models(env: NodeJS.ProcessEnv = process.env): Promise<ChatGptModelInfo[]> {
    const configured = env.CHATGPT_SUBSCRIPTION_MODELS?.split(",").map(item => item.trim().toLowerCase()).filter(item => /^[a-z0-9][a-z0-9.\-_]*$/.test(item));
    const defaultModel: ChatGptModelInfo = { alias: CHATGPT_DEFAULT_ALIAS, displayName: "ChatGPT (модель Codex по умолчанию)", priority: 0 };
    if (configured?.length) {
      return [...new Set(configured)].map((alias, index) => alias === CHATGPT_DEFAULT_ALIAS ? defaultModel : { alias, displayName: alias, priority: index + 1 });
    }
    if (!this.modelsCache || this.now() - this.modelsCache.at >= MODELS_CACHE_MS) {
      const live = await (this.deps.listModels ?? codexListModels)(this.deps.cli).catch(() => undefined);
      if (live) this.modelsCache = { value: live.map(model => ({ alias: model.slug.toLowerCase(), displayName: model.displayName, description: model.description, priority: model.priority })), at: this.now() };
    }
    return [defaultModel, ...(this.modelsCache?.value ?? []).filter(model => model.alias !== CHATGPT_DEFAULT_ALIAS)];
  }

  async auth(force = false): Promise<CodexAuthStatus> {
    if (!force && this.authCache && this.now() - this.authCache.at < AUTH_CACHE_MS) return this.authCache.value;
    const value = await (this.deps.authStatus ?? codexAuthStatus)(this.deps.cli);
    this.authCache = { value, at: this.now() };
    return value;
  }

  quotaState(): ChatGptSubscriptionQuota {
    if (this.quota.exhausted && this.quota.exhaustedUntil && Date.parse(this.quota.exhaustedUntil) <= this.now()) {
      this.quota = { exhausted: false, lastRateLimit: this.quota.lastRateLimit };
    }
    // A limit seen by a delegated coding run (or any other SnarkRoute path) applies to chat as well.
    const shared = sharedQuotaLedger().view("codex_cli");
    if (!this.quota.exhausted && (shared.quota.state === "exhausted" || shared.quota.state === "rate_limited") && shared.nextAttemptAt && Date.parse(shared.nextAttemptAt) > this.now()) {
      return { ...this.quota, exhausted: true, exhaustedUntil: shared.nextAttemptAt, lastLimitMessage: shared.quota.detail ?? "Лимит зафиксирован общим учётом SnarkRoute.", ...(shared.quota.simulated ? { simulated: true } : {}) };
    }
    return { ...this.quota };
  }

  /** Recheck the plan without spending a model step. Failed reads remain unknown;
   * concurrent status/reviewer calls share one request, at most once per minute. */
  async refreshQuota(): Promise<void> {
    if (this.quotaState().simulated || sharedQuotaLedger().view("codex_cli").quota.simulated) return;
    if (this.quotaRefresh) return this.quotaRefresh;
    if (this.now() - this.quotaCheckedAt < AUTH_CACHE_MS) return;
    this.quotaCheckedAt = this.now();
    this.quotaRefresh = (async () => {
      try {
        const info = await (this.deps.readQuota ?? readCodexQuota)(this.deps.cli);
        if (info) this.observeRateLimit(info, "codex app-server account/rateLimits/read");
      } catch { /* No quota report is preferable to fabricated availability. */ }
    })().finally(() => { this.quotaRefresh = undefined; });
    return this.quotaRefresh;
  }

  /** Turns running right now; the shared ledger counts them against the plan's concurrency. */
  get activeTurns(): number { return this.gate.active; }

  /** Live check of limit handling and fallback without spending the real quota. */
  simulateQuotaExhausted(seconds: number): ChatGptSubscriptionQuota {
    this.quota = { ...this.quota, exhausted: true, simulated: true, exhaustedUntil: new Date(this.now() + Math.min(600, Math.max(1, seconds)) * 1000).toISOString(), lastLimitMessage: "Simulated limit (smoke test)." };
    return this.quotaState();
  }

  clearSimulatedQuota(): ChatGptSubscriptionQuota {
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
    const [auth, history, models] = await Promise.all([this.auth(), this.history.load(), this.models()]);
    const day = this.now() - 24 * 60 * 60_000;
    const recent = history.filter(entry => Date.parse(entry.at) >= day);
    const quota = this.quotaState();
    return {
      provider: CHATGPT_SUBSCRIPTION_PROVIDER,
      transport: "codex-cli",
      auth,
      planType: quota.lastRateLimit?.planType,
      quota,
      models: models.map(model => ({ id: modelRefForAlias(model.alias), ...model, ...this.modelState(model.alias) })),
      capabilities: { streaming: false, conversations: true, cancellation: true, tools: false, note: "codex exec --json emits only the final message; stream:true sends session and done events, no text deltas." },
      concurrency: { active: this.gate.active, queued: this.gate.queued, limit: maxConcurrency() },
      usage24h: {
        requests: recent.length,
        succeeded: recent.filter(entry => entry.status === "succeeded").length,
        limited: recent.filter(entry => entry.errorCode === "SUBSCRIPTION_LIMIT_REACHED").length,
        inputTokens: recent.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
        outputTokens: recent.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
        note: "Covered by the ChatGPT plan; Codex CLI reports no per-request price and nothing is booked as spending."
      },
      recent: history.slice(-20).reverse()
    };
  }

  async chat(request: ChatGptSubscriptionChatRequest): Promise<ChatGptSubscriptionChatResult> {
    const alias = aliasForModelRef(request.modelRef);
    if (!(await this.models()).some(model => model.alias === alias)) {
      throw new CodexCliError("MODEL_UNAVAILABLE", `Модель ${request.modelRef} не входит в подписочный список ChatGPT (codex debug models).`);
    }
    const quota = this.quotaState();
    if (quota.exhausted) {
      throw new CodexCliError("SUBSCRIPTION_LIMIT_REACHED", `Лимит подписки ChatGPT исчерпан${quota.exhaustedUntil ? ` до ${quota.exhaustedUntil}` : ""}.`, { resetsAt: quota.exhaustedUntil, retryable: true });
    }
    const model = this.modelState(alias);
    if (!model.available) throw new CodexCliError("MODEL_UNAVAILABLE", model.reason ?? `Модель ${alias} недоступна.`);
    const auth = await this.auth();
    if (!auth.installed) throw new CodexCliError("CLI_NOT_INSTALLED", auth.reason ?? "Codex CLI не установлен.");
    if (!auth.subscription) {
      // A login may have happened since the cached check.
      const fresh = await this.auth(true);
      if (!fresh.subscription) throw new CodexCliError(fresh.loggedIn ? "NOT_SUBSCRIPTION" : "NOT_LOGGED_IN", fresh.reason ?? "Подписка ChatGPT не подтверждена.");
    }
    // Turns of one conversation never interleave; different conversations run independently.
    return this.serializer.run(request.conversationId, () => this.gate.run(request.signal, () => this.runTurn(request, alias)));
  }

  async listConversations(): Promise<ChatGptConversation[]> {
    return this.conversations.list();
  }

  /** Forgets the mapping and removes the Codex session from the owner's Codex session list. */
  async forgetConversation(id: string): Promise<boolean> {
    const conversations = await this.conversations.load();
    const existing = conversations.get(id);
    if (!existing) return false;
    conversations.delete(id);
    await this.conversations.save();
    await this.deleteSession(existing.sessionId).catch(() => false);
    return true;
  }

  private async deleteSession(sessionId: string): Promise<boolean> {
    if (this.deps.deleteSession) return this.deps.deleteSession(sessionId);
    const command = this.deps.cli?.command ?? await codexCliCommand(this.deps.cli?.env);
    return deleteCodexSession(this.deps.cli?.spawnImpl ?? spawn, command, codexCliEnv(this.deps.cli?.env), sessionId);
  }

  private async runTurn(request: ChatGptSubscriptionChatRequest, alias: string): Promise<ChatGptSubscriptionChatResult> {
    const startedAt = this.now();
    const conversations = request.conversationId ? await this.conversations.load() : undefined;
    const existing = request.conversationId ? conversations?.get(request.conversationId) : undefined;
    try {
      const result = await (this.deps.run ?? runCodexExec)({
        model: alias === CHATGPT_DEFAULT_ALIAS ? undefined : alias,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        resumeSessionId: existing?.sessionId,
        persist: Boolean(request.conversationId),
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        onEvent: event => {
          if (event.type === "rate_limit") this.observeRateLimit(event.info);
          request.onEvent?.(event);
        }
      }, this.deps.cli);
      if (result.model) this.resolvedModels.set(alias, result.model);
      if (result.rateLimit) this.observeRateLimit(result.rateLimit);
      if (request.conversationId && conversations) {
        const at = new Date(this.now()).toISOString();
        conversations.set(request.conversationId, {
          id: request.conversationId,
          sessionId: result.sessionId || existing!.sessionId,
          model: alias,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          turns: (existing?.turns ?? 0) + 1
        });
        await this.conversations.save();
      }
      sharedQuotaLedger().recordMeasuredRun("codex_cli", { kind: "chat", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
      await this.history.record({ at: new Date(startedAt).toISOString(), model: alias, resolvedModel: result.model, status: "succeeded", durationMs: result.durationMs,
        inputTokens: result.usage.inputTokens, cachedInputTokens: result.usage.cachedInputTokens, outputTokens: result.usage.outputTokens + result.usage.reasoningOutputTokens,
        conversation: Boolean(request.conversationId), caller: request.caller });
      return { ...result, conversationId: request.conversationId, modelRef: modelRefForAlias(alias), alias };
    } catch (error) {
      const code = error instanceof CodexCliError ? error.code : "CLI_ERROR";
      if (error instanceof CodexCliError) this.observeFailure(error, alias);
      if (code !== "CANCELLED") sharedQuotaLedger().recordMeasuredRun("codex_cli", { kind: "chat" });
      await this.history.record({ at: new Date(startedAt).toISOString(), model: alias, status: code === "CANCELLED" ? "cancelled" : "failed", errorCode: code,
        durationMs: this.now() - startedAt, conversation: Boolean(request.conversationId), caller: request.caller });
      throw error;
    }
  }

  private observeRateLimit(info: CodexRateLimitInfo, source = "codex session file (chat)"): void {
    this.quota = { ...this.quota, lastRateLimit: info };
    // Once a window is used up Codex would fail or draw on paid ChatGPT credits; neither is wanted unless allowed.
    const exhausted = codexLimitReached(info) && !(info.hasCredits && process.env.CHATGPT_SUBSCRIPTION_ALLOW_CREDITS === "1");
    if (exhausted) {
      this.quota = { ...this.quota, exhausted: true, exhaustedUntil: limitResetsAt(info) ?? new Date(this.now() + UNKNOWN_RESET_BACKOFF_MS).toISOString() };
    } else if (!this.quota.simulated) {
      this.quota = { exhausted: false, lastRateLimit: info };
    }
    const windows = [info.primary, info.secondary].filter(window => window !== undefined);
    const used = windows.length ? Math.max(...windows.map(window => window.usedPercent)) : undefined;
    sharedQuotaLedger().recordQuotaReport("codex_cli", { exhausted, usedPercent: used, resetsAt: limitResetsAt(info) ?? windows.find(window => window.usedPercent === used)?.resetsAt,
      source, detail: info.planType });
  }

  private observeFailure(error: CodexCliError, alias: string): void {
    if (error.code === "SUBSCRIPTION_LIMIT_REACHED") sharedQuotaLedger().recordFailure("codex_cli", { class: "quota_exhausted", message: error.message, resetsAt: error.details.resetsAt, source: "chatgpt chat" });
    if (error.code === "NOT_LOGGED_IN" || error.code === "NOT_SUBSCRIPTION") sharedQuotaLedger().recordFailure("codex_cli", { class: "auth", message: error.message, source: "chatgpt chat" });
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
  return `${CHATGPT_SUBSCRIPTION_MODEL_PREFIX}${alias}`;
}

export function aliasForModelRef(modelRef: string): string {
  const trimmed = modelRef.trim();
  const tail = trimmed.startsWith(CHATGPT_SUBSCRIPTION_MODEL_PREFIX) ? trimmed.slice(CHATGPT_SUBSCRIPTION_MODEL_PREFIX.length) : trimmed.replace(/^chatgpt_subscription:/, "");
  return tail.toLowerCase();
}

export function isChatGptSubscriptionModelRef(value: string | undefined): boolean {
  return Boolean(value && (value.startsWith(CHATGPT_SUBSCRIPTION_MODEL_PREFIX) || value.startsWith(`${CHATGPT_SUBSCRIPTION_PROVIDER}:`)));
}

function maxConcurrency(): number {
  return boundedConcurrency(process.env.CHATGPT_SUBSCRIPTION_MAX_CONCURRENCY);
}

let shared: ChatGptSubscriptionService | undefined;
export function chatGptSubscription(): ChatGptSubscriptionService {
  return shared ??= new ChatGptSubscriptionService();
}

export function isChatGptSubscriptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHATGPT_SUBSCRIPTION_ENABLED === "1";
}
