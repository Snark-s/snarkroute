import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { redactSecrets } from "./errors";

/**
 * Transport to the official Claude Code CLI (`claude -p`). It only uses the
 * login Claude Code manages itself (`claude auth login`, Pro/Max): no OAuth
 * token is read or copied, no undocumented endpoint is called, and every
 * Anthropic API-key variable is removed from the child environment.
 */

export type ClaudeCliErrorCode =
  | "CLI_NOT_INSTALLED"
  | "NOT_LOGGED_IN"
  | "NOT_SUBSCRIPTION"
  | "SUBSCRIPTION_LIMIT_REACHED"
  | "MODEL_UNAVAILABLE"
  | "CANCELLED"
  | "TIMEOUT"
  | "CLI_ERROR";

export class ClaudeCliError extends Error {
  readonly origin = "claude_subscription";
  constructor(readonly code: ClaudeCliErrorCode, message: string, readonly details: { resetsAt?: string; retryable?: boolean; sessionId?: string } = {}) {
    super(message);
    this.name = "ClaudeCliError";
  }
  get retryable(): boolean { return this.details.retryable ?? false; }
}

export type ClaudeAuthStatus = {
  installed: boolean;
  command: string;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  /** True only for a first-party claude.ai login (Pro/Max/Team), never for an API key or Console login. */
  subscription: boolean;
  reason?: string;
  checkedAt: string;
};

export type ClaudeRateLimitInfo = {
  status?: string;
  rateLimitType?: string;
  resetsAt?: string;
  utilization?: number;
  usingExtraUsage?: boolean;
  raw: Record<string, unknown>;
};

export type ClaudeUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };

export type ClaudeCodeResult = {
  text: string;
  sessionId: string;
  /** Model id the CLI actually resolved the alias to (from its init event). */
  model: string;
  usage: ClaudeUsage;
  /** What the same tokens would cost on the paid API. Informational only: the subscription is not billed per call. */
  apiEquivalentCostUsd?: number;
  durationMs: number;
  numTurns?: number;
  stopReason?: string;
  rateLimit?: ClaudeRateLimitInfo;
};

export type ClaudeStreamEvent =
  | { type: "session"; sessionId: string; model: string; apiKeySource?: string }
  | { type: "delta"; text: string }
  | { type: "rate_limit"; info: ClaudeRateLimitInfo }
  | { type: "tool"; name: string; summary: string }
  | { type: "result"; result: ClaudeCodeResult };

/**
 * A coding run in an owner-approved folder. Only the listed tools are allowed
 * (edits auto-accepted, everything else denied in print mode); user/project
 * settings, MCP and web tools stay off. No bypass-permissions mode.
 */
export type ClaudeAgentMode = { workdir: string; allowedTools: string[]; disallowedTools?: string[]; maxTurns?: number; extraEnv?: Record<string, string> };

export type ClaudeCodeRequest = {
  /** CLI alias (`opus`, `sonnet`, `haiku`, ...) or a full model id. */
  model: string;
  prompt: string;
  systemPrompt?: string;
  /** Start a new persisted conversation with this id. */
  sessionId?: string;
  /** Continue an existing persisted conversation. */
  resumeSessionId?: string;
  /** Without a session id the call is one-shot and not written to disk. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: ClaudeStreamEvent) => void;
  agent?: ClaudeAgentMode;
};

export type ClaudeCliOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Empty working directory: sessions of SnarkRoute stay apart from the owner's own Claude Code projects. */
  workspace?: string;
  spawnImpl?: typeof spawn;
  onSpawn?: (pid: number) => void;
};

export const DEFAULT_CLAUDE_TIMEOUT_MS = 600_000;
const DEFAULT_SYSTEM_PROMPT = "You are Claude, answering a request routed through SnarkRoute. Reply with the answer text only.";

export function claudeCliCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.SNARKROUTE_CLAUDE_COMMAND?.trim() || "claude";
}

export function claudeWorkspaceDirectory(): string {
  return join(process.cwd(), "data", "claude-subscription", "workspace");
}

/** API-key, gateway and host-session variables would switch Claude Code off the subscription. */
export function claudeCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key.startsWith("AWS_BEARER_TOKEN_BEDROCK")) continue;
    env[key] = value;
  }
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/** Plain text generation: no tools, no MCP, no skills, no user/project settings or CLAUDE.md. */
export function claudeCodeArgs(request: Pick<ClaudeCodeRequest, "model" | "sessionId" | "resumeSessionId">, systemPromptFile: string): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", request.model,
    "--system-prompt-file", systemPromptFile,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands"
  ];
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  else if (request.sessionId) args.push("--session-id", request.sessionId);
  else args.push("--no-session-persistence");
  return args;
}

/** `systemPromptFile` is appended to Claude Code's own coding prompt instead of replacing it. */
export function claudeAgentArgs(request: Pick<ClaudeCodeRequest, "model">, agent: ClaudeAgentMode, systemPromptFile: string): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", request.model,
    "--append-system-prompt-file", systemPromptFile,
    "--permission-mode", "acceptEdits",
    "--allowedTools", agent.allowedTools.join(","),
    "--disallowedTools", (agent.disallowedTools ?? ["WebFetch", "WebSearch", "Task"]).join(","),
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--max-turns", String(agent.maxTurns ?? 30),
    "--no-session-persistence"
  ];
}

export async function claudeAuthStatus(options: ClaudeCliOptions = {}): Promise<ClaudeAuthStatus> {
  const command = options.command ?? claudeCliCommand(options.env);
  const env = claudeCliEnv(options.env);
  const spawnImpl = options.spawnImpl ?? spawn;
  const checkedAt = new Date().toISOString();
  const version = await runShort(spawnImpl, command, ["--version"], env).catch(() => undefined);
  if (!version || version.exitCode !== 0) {
    return { installed: false, command, loggedIn: false, subscription: false, checkedAt,
      reason: "Claude Code CLI не найден. Установите его официальным установщиком: irm https://claude.ai/install.ps1 | iex" };
  }
  const status = await runShort(spawnImpl, command, ["auth", "status", "--json"], env).catch(() => undefined);
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(status?.stdout ?? "") as Record<string, unknown>; } catch { /* reported below */ }
  return interpretAuthStatus(parsed, { command, version: version.stdout.trim().split(/\s+/)[0], checkedAt });
}

export function interpretAuthStatus(parsed: Record<string, unknown>, base: { command: string; version?: string; checkedAt: string }): ClaudeAuthStatus {
  const loggedIn = parsed.loggedIn === true;
  const authMethod = str(parsed.authMethod);
  const apiProvider = str(parsed.apiProvider);
  const subscriptionType = str(parsed.subscriptionType);
  const firstParty = !apiProvider || apiProvider === "firstParty";
  const apiKeyLogin = /api.?key|console/i.test(authMethod ?? "") || /api.?key/i.test(str(parsed.apiKeySource) ?? "");
  const subscriptionLogin = /claude\.?ai|oauth|subscription/i.test(authMethod ?? "") || Boolean(subscriptionType && /pro|max|team|enterprise/i.test(subscriptionType));
  const subscription = loggedIn && firstParty && !apiKeyLogin && subscriptionLogin;
  const reason = !loggedIn ? "Claude Code не авторизован. Выполните вход через подписку: claude auth login"
    : !firstParty ? `Claude Code настроен на стороннего провайдера (${apiProvider}); подписка не используется.`
      : apiKeyLogin ? "Claude Code вошёл с API-ключом или через Console. Для подписки нужен вход claude auth login --claudeai."
        : !subscriptionLogin ? `Не удалось подтвердить подписку (authMethod=${authMethod ?? "нет"}).` : undefined;
  return { installed: true, command: base.command, version: base.version, loggedIn, authMethod, apiProvider, subscriptionType, subscription, reason, checkedAt: base.checkedAt };
}

/** One `claude -p` turn. Resolves with the final text; streams deltas through onEvent. */
export async function runClaudeCode(request: ClaudeCodeRequest, options: ClaudeCliOptions = {}): Promise<ClaudeCodeResult> {
  if (request.signal?.aborted) throw new ClaudeCliError("CANCELLED", "Запрос к Claude отменён.");
  const command = options.command ?? claudeCliCommand(options.env);
  const agent = request.agent;
  const workspace = agent?.workdir ?? options.workspace ?? claudeWorkspaceDirectory();
  const spawnImpl = options.spawnImpl ?? spawn;
  await mkdir(workspace, { recursive: true });
  // Prompt files live with SnarkRoute's own data, never inside the folder an agent works in.
  const promptDirectory = join(agent ? claudeWorkspaceDirectory() : workspace, "..", "prompts");
  await mkdir(promptDirectory, { recursive: true });
  // A file keeps long instructions out of the Windows command line (32K limit) and its quoting rules.
  const systemPromptFile = join(promptDirectory, `${randomUUID()}.txt`);
  await writeFile(systemPromptFile, request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, "utf8");
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawnImpl(command, agent ? claudeAgentArgs(request, agent, systemPromptFile) : claudeCodeArgs(request, systemPromptFile), {
      cwd: workspace, env: { ...claudeCliEnv(options.env), ...(agent?.extraEnv ?? {}) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
  } catch {
    await rm(systemPromptFile, { force: true });
    throw new ClaudeCliError("CLI_NOT_INSTALLED", "Claude Code CLI не запускается. Установите его: irm https://claude.ai/install.ps1 | iex");
  }
  if (child.pid) options.onSpawn?.(child.pid);

  const state: { sessionId?: string; model?: string; text: string; assistantText: string; error?: string; errorText?: string; rateLimit?: ClaudeRateLimitInfo; result?: Record<string, unknown>; stderr: string; failure?: ClaudeCliError } = { text: "", assistantText: "", stderr: "" };
  const emit = (event: ClaudeStreamEvent) => { try { request.onEvent?.(event); } catch { /* a slow client must not break the turn */ } };
  const stop = (failure: ClaudeCliError) => { state.failure ??= failure; if (child.exitCode === null) child.kill(); };

  child.stdin?.on("error", () => undefined);
  child.stdin?.end(request.prompt);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { if (state.stderr.length < 8_000) state.stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", line => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const type = str(event.type);
    if (type === "system" && event.subtype === "init") {
      const apiKeySource = str(event.apiKeySource);
      state.sessionId = str(event.session_id);
      state.model = str(event.model);
      if (apiKeySource && apiKeySource !== "none") {
        stop(new ClaudeCliError("NOT_SUBSCRIPTION", `Claude Code собирался использовать API-ключ (${apiKeySource}). Запрос остановлен, платный API не используется.`));
        return;
      }
      emit({ type: "session", sessionId: state.sessionId ?? "", model: state.model ?? request.model, apiKeySource });
    } else if (type === "stream_event") {
      const inner = record(event.event);
      const delta = record(inner.delta);
      if (inner.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        state.text += delta.text;
        emit({ type: "delta", text: delta.text });
      }
    } else if (type === "assistant") {
      const message = record(event.message);
      const text = (Array.isArray(message.content) ? message.content : [])
        .map(block => record(block)).filter(block => block.type === "text").map(block => str(block.text) ?? "").join("");
      if (event.error) { state.error = str(event.error); state.errorText = text; }
      else state.assistantText += text;
      for (const block of (Array.isArray(message.content) ? message.content : []).map(item => record(item)).filter(item => item.type === "tool_use")) {
        emit({ type: "tool", name: str(block.name) ?? "tool", summary: JSON.stringify(block.input ?? {}).slice(0, 400) });
      }
    } else if (type === "rate_limit_event") {
      const info = parseRateLimit(record(event.rate_limit_info));
      state.rateLimit = info;
      emit({ type: "rate_limit", info });
      if (info.usingExtraUsage && process.env.CLAUDE_SUBSCRIPTION_ALLOW_EXTRA_USAGE !== "1") {
        stop(new ClaudeCliError("SUBSCRIPTION_LIMIT_REACHED", "Лимит подписки исчерпан, дальше Claude Code списывал бы платное дополнительное использование. Запрос остановлен.", { resetsAt: info.resetsAt }));
      }
    } else if (type === "result") {
      state.result = event;
    }
  });

  const onAbort = () => stop(new ClaudeCliError("CANCELLED", "Запрос к Claude отменён."));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = request.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
  const timer = setTimeout(() => stop(new ClaudeCliError("TIMEOUT", `Claude не ответил за ${Math.round(timeoutMs / 1000)} с.`, { retryable: true })), timeoutMs);
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", error => reject(new ClaudeCliError("CLI_NOT_INSTALLED", `Claude Code CLI не запускается (${(error as NodeJS.ErrnoException).code ?? error.message}). Установите его: irm https://claude.ai/install.ps1 | iex`)));
      child.once("close", code => resolve(code));
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    lines.close();
    await rm(systemPromptFile, { force: true });
  }
  if (state.failure) throw withSession(state.failure, state.sessionId);

  const result = state.result ?? {};
  const resultText = str(result.result) ?? "";
  if (state.error || result.is_error === true || !state.result) {
    throw withSession(classifyFailure(state.error, state.errorText || resultText || state.stderr, state.rateLimit, exitCode), str(result.session_id) ?? state.sessionId);
  }
  const text = resultText || state.text || state.assistantText;
  const usage = record(result.usage);
  const final: ClaudeCodeResult = {
    text,
    sessionId: str(result.session_id) ?? state.sessionId ?? "",
    model: state.model ?? request.model,
    usage: {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadInputTokens: num(usage.cache_read_input_tokens),
      cacheCreationInputTokens: num(usage.cache_creation_input_tokens)
    },
    apiEquivalentCostUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    durationMs: Date.now() - startedAt,
    numTurns: typeof result.num_turns === "number" ? result.num_turns : undefined,
    stopReason: str(result.stop_reason),
    rateLimit: state.rateLimit
  };
  emit({ type: "result", result: final });
  return final;
}

export function classifyFailure(error: string | undefined, text: string, rateLimit: ClaudeRateLimitInfo | undefined, exitCode: number | null): ClaudeCliError {
  const message = redactSecrets(text.trim()).slice(0, 500);
  if (error === "authentication_failed" || /not logged in|please run \/login|invalid api key|oauth token/i.test(text)) {
    return new ClaudeCliError("NOT_LOGGED_IN", `Claude Code не авторизован через подписку. Выполните claude auth login. ${message}`.trim());
  }
  if (error === "rate_limit" || error === "billing_error" || rateLimit?.status === "rejected" || /usage limit|limit reached|rate limit|out of (extra )?usage|resets? (at|in)/i.test(text)) {
    return new ClaudeCliError("SUBSCRIPTION_LIMIT_REACHED", `Лимит подписки Claude исчерпан.${rateLimit?.resetsAt ? ` Сброс: ${rateLimit.resetsAt}.` : ""} ${message}`.trim(), { resetsAt: rateLimit?.resetsAt, retryable: true });
  }
  if (/model.*(not (found|available|supported)|does not exist|invalid)|not_found_error|issue with the selected model/i.test(text)) {
    return new ClaudeCliError("MODEL_UNAVAILABLE", `Модель недоступна для этой подписки. ${message}`.trim());
  }
  if (error === "server_error" || error === "overloaded" || /overloaded|529|internal server error/i.test(text)) {
    return new ClaudeCliError("CLI_ERROR", `Claude временно недоступен. ${message}`.trim(), { retryable: true });
  }
  return new ClaudeCliError("CLI_ERROR", `Claude Code завершился с ошибкой${exitCode === null ? "" : ` (код ${exitCode})`}. ${message}`.trim());
}

export function parseRateLimit(raw: Record<string, unknown>): ClaudeRateLimitInfo {
  const resets = raw.resetsAt ?? raw.resets_at;
  const resetsAt = typeof resets === "number" && Number.isFinite(resets)
    ? new Date(resets < 1e12 ? resets * 1000 : resets).toISOString()
    : typeof resets === "string" && Number.isFinite(Date.parse(resets)) ? new Date(resets).toISOString() : undefined;
  const utilization = typeof raw.utilization === "number" ? raw.utilization : undefined;
  return {
    status: str(raw.status),
    rateLimitType: str(raw.rateLimitType ?? raw.rate_limit_type),
    resetsAt,
    utilization,
    usingExtraUsage: raw.isUsingOverage === true || raw.isUsingExtraUsage === true,
    raw
  };
}

function withSession(error: ClaudeCliError, sessionId: string | undefined): ClaudeCliError {
  return sessionId && !error.details.sessionId ? new ClaudeCliError(error.code, error.message, { ...error.details, sessionId }) : error;
}

function runShort(spawnImpl: typeof spawn, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { reject(error); return; }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", exitCode => { clearTimeout(timer); resolve({ stdout, exitCode }); });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
