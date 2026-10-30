import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findCodexCliExecutable } from "./codex-desktop";
import { redactSecrets } from "./errors";

/**
 * Transport to the official Codex CLI (`codex exec`) signed in with ChatGPT
 * (Plus/Pro). Codex keeps and refreshes its own credentials in CODEX_HOME;
 * SnarkRoute never reads or copies them. Every OpenAI API-key variable is removed
 * from the child environment and the CLI is forced to the ChatGPT login.
 *
 * What the CLI gives (checked against `codex exec --help`, codex-cli 0.149):
 * `--json` events with the final agent message (no text deltas), `exec resume <id>`,
 * `-m <model>`, `codex debug models` (live model list), and its own session file
 * with the resolved model and the plan's rate-limit windows.
 */

export type CodexCliErrorCode =
  | "CLI_NOT_INSTALLED"
  | "NOT_LOGGED_IN"
  | "NOT_SUBSCRIPTION"
  | "SUBSCRIPTION_LIMIT_REACHED"
  | "MODEL_UNAVAILABLE"
  | "CANCELLED"
  | "TIMEOUT"
  | "CLI_ERROR";

export class CodexCliError extends Error {
  readonly origin = "chatgpt_subscription";
  constructor(readonly code: CodexCliErrorCode, message: string, readonly details: { resetsAt?: string; retryable?: boolean; sessionId?: string } = {}) {
    super(message);
    this.name = "CodexCliError";
  }
  get retryable(): boolean { return this.details.retryable ?? false; }
}

export type CodexAuthStatus = {
  installed: boolean;
  command: string;
  version?: string;
  loggedIn: boolean;
  /** "chatgpt" or "api_key", as `codex login status` reports it. */
  authMode?: string;
  /** True only for a ChatGPT login, never for an API key or access token. */
  subscription: boolean;
  reason?: string;
  checkedAt: string;
};

export type CodexRateLimitWindow = { usedPercent: number; windowMinutes?: number; resetsAt?: string };

export type CodexRateLimitInfo = {
  planType?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  /** Paid ChatGPT credits Codex may draw on once the plan's windows are used up. */
  hasCredits?: boolean;
  reachedType?: string;
  spendControlReached?: boolean;
  raw: Record<string, unknown>;
};

export type CodexUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };

export type CodexExecResult = {
  text: string;
  sessionId: string;
  /** Model the CLI actually used (from its session file); the alias when unknown. */
  model: string;
  usage: CodexUsage;
  durationMs: number;
  rateLimit?: CodexRateLimitInfo;
  warnings: string[];
};

export type CodexStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "warning"; message: string }
  | { type: "rate_limit"; info: CodexRateLimitInfo }
  | { type: "item"; itemType: string; summary: string }
  | { type: "result"; result: CodexExecResult };

/** A coding run in an owner-approved folder: workspace-write sandbox, no MCP, no web, Codex's own base instructions. */
export type CodexAgentMode = {
  workdir: string;
  network?: boolean;
  readOnly?: boolean;
  shell?: boolean;
  /** Windows sandbox implementation (`elevated` / `unelevated`); without it workspace-write silently degrades to read-only. */
  windowsSandbox?: string;
  extraEnv?: Record<string, string>;
};

export type CodexExecRequest = {
  /** Trusted, prevalidated local image inputs; never executable tools. */
  images?:string[];
  /** Model slug from `codex debug models`; undefined lets the CLI pick its default. */
  model?: string;
  prompt: string;
  systemPrompt?: string;
  /** Continue an existing Codex session. */
  resumeSessionId?: string;
  /** One-shot turns are removed from Codex's session list after the quota is read. */
  persist?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: CodexStreamEvent) => void;
  agent?: CodexAgentMode;
};

export type CodexCliOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Empty working directory, apart from the owner's own projects. */
  workspace?: string;
  spawnImpl?: typeof spawn;
  /** Receives the CLI's process id, so a supervisor can tell later whether the run is still alive. */
  onSpawn?: (pid: number) => void;
};

export const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_SYSTEM_PROMPT = "You are ChatGPT, answering a request routed through SnarkRoute. Reply with the answer text only.";

/**
 * Agent features switched off for plain text. `-c features.<name>=false` is used
 * instead of `--disable` because the CLI ignores names it no longer has, while
 * `--disable` fails on them after an update.
 */
const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "in_app_browser",
  "image_generation", "multi_agent", "view_image", "tool_suggest", "goals", "hooks", "memories", "workspace_dependencies",
  "skill_mcp_dependency_install"
];

export async function codexCliCommand(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env.SNARKROUTE_CODEX_COMMAND?.trim();
  if (configured) return configured;
  try { return await findCodexCliExecutable(); }
  catch { return "codex"; }
}

export function codexWorkspaceDirectory(): string {
  return join(process.cwd(), "data", "chatgpt-subscription", "workspace");
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** API-key, endpoint and host-session variables would move Codex off the ChatGPT plan. */
export function codexCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("OPENAI_") || upper.startsWith("AZURE_OPENAI") || upper.startsWith("CODEX_") && upper !== "CODEX_HOME" || upper === "RUST_LOG") continue;
    env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

/** Plain text generation: user config, rules, MCP, skills, web search, shell and other tools off; read-only sandbox. */
export function codexExecArgs(request: Pick<CodexExecRequest, "model" | "resumeSessionId" | "images">, instructionsFile: string, workspace: string): string[] {
  const config = [
    `model_instructions_file=${JSON.stringify(instructionsFile.replace(/\\/g, "/"))}`,
    'forced_login_method="chatgpt"',
    'model_provider="openai"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    "mcp_servers={}",
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    'history.persistence="none"',
    ...DISABLED_FEATURES.map(feature => `features.${feature}=false`)
  ];
  const common = ["--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", ...(request.model ? ["-m", request.model] : []), ...(request.images??[]).flatMap(path=>["--image",path]), ...config.flatMap(value => ["-c", value])];
  // `exec resume` has no --sandbox/--cd/--color: the sandbox comes from the config above, the cwd from the process.
  return request.resumeSessionId
    ? ["exec", "resume", ...common, request.resumeSessionId, "-"]
    : ["exec", ...common, "--color", "never", "-s", "read-only", "-C", workspace, "-"];
}

/** Agent features that stay off even for coding: apps, browsers, computer use, image generation, sub-agents, memories, hooks. */
const AGENT_DISABLED_FEATURES = [
  "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation",
  "multi_agent", "tool_suggest", "goals", "hooks", "memories", "skill_mcp_dependency_install"
];

export function codexAgentExecArgs(request: Pick<CodexExecRequest, "model">, agent: CodexAgentMode): string[] {
  const sandbox = agent.readOnly ? "read-only" : "workspace-write";
  const config = [
    'forced_login_method="chatgpt"',
    'model_provider="openai"',
    'approval_policy="never"',
    `sandbox_mode="${sandbox}"`,
    `sandbox_workspace_write.network_access=${agent.network === true}`,
    'web_search="disabled"',
    "mcp_servers={}",
    'history.persistence="none"',
    ...AGENT_DISABLED_FEATURES.map(feature => `features.${feature}=false`),
    ...(agent.shell === false ? ["features.shell_tool=false", "features.unified_exec=false"] : []),
    ...(agent.windowsSandbox && /^[a-z_-]+$/.test(agent.windowsSandbox) ? [`windows.sandbox="${agent.windowsSandbox}"`] : [])
  ];
  return ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", ...(request.model ? ["-m", request.model] : []),
    ...config.flatMap(value => ["-c", value]), "--color", "never", "-s", sandbox, "-C", agent.workdir, "-"];
}

/**
 * The Windows sandbox mode the owner configured for Codex (`[windows] sandbox`).
 * Only this one non-secret value is read; the rest of the user config stays ignored.
 */
export async function codexWindowsSandboxMode(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const override = env.AGENT_OPS_CODEX_WINDOWS_SANDBOX?.trim();
  if (override) return override;
  if (process.platform !== "win32") return undefined;
  try {
    const text = await readFile(join(codexHome(env), "config.toml"), "utf8");
    const section = /^\[windows\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
    return /^\s*sandbox\s*=\s*"([a-z_-]+)"/m.exec(section)?.[1];
  } catch { return undefined; }
}

export async function codexAuthStatus(options: CodexCliOptions = {}): Promise<CodexAuthStatus> {
  const command = options.command ?? await codexCliCommand(options.env);
  const env = codexCliEnv(options.env);
  const spawnImpl = options.spawnImpl ?? spawn;
  const checkedAt = new Date().toISOString();
  const version = await runShort(spawnImpl, command, ["--version"], env).catch(() => undefined);
  if (!version || version.exitCode !== 0) {
    return { installed: false, command, loggedIn: false, subscription: false, checkedAt,
      reason: "Codex CLI не найден. Установите или обновите Codex (приложение Codex или npm i -g @openai/codex)." };
  }
  const status = await runShort(spawnImpl, command, ["login", "status"], env).catch(() => undefined);
  return interpretLoginStatus(`${status?.stdout ?? ""}\n${status?.stderr ?? ""}`, status?.exitCode ?? null, { command, version: version.stdout.trim().replace(/^codex-cli\s+/i, ""), checkedAt });
}

export function interpretLoginStatus(text: string, exitCode: number | null, base: { command: string; version?: string; checkedAt: string }): CodexAuthStatus {
  const chatgpt = /logged in using chatgpt/i.test(text);
  const apiKey = /api.?key|access.?token/i.test(text) && /logged in/i.test(text);
  const loggedIn = exitCode === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  const authMode = chatgpt ? "chatgpt" : apiKey ? "api_key" : undefined;
  const subscription = loggedIn && chatgpt && !apiKey;
  const reason = !loggedIn ? "Codex не авторизован. Выполните вход через ChatGPT: codex login"
    : !chatgpt ? "Codex вошёл по API-ключу. Для подписки нужен вход через ChatGPT: codex logout, затем codex login." : undefined;
  return { installed: true, command: base.command, version: base.version, loggedIn, authMode, subscription, reason, checkedAt: base.checkedAt };
}

/** Live model list of the signed-in account, as the CLI itself sees it. */
export async function codexListModels(options: CodexCliOptions = {}): Promise<Array<{ slug: string; displayName: string; description?: string; priority: number }>> {
  const command = options.command ?? await codexCliCommand(options.env);
  const result = await runShort(options.spawnImpl ?? spawn, command, ["debug", "models"], codexCliEnv(options.env));
  if (result.exitCode !== 0) throw new CodexCliError("CLI_ERROR", "codex debug models завершился с ошибкой.");
  const parsed = record(JSON.parse(result.stdout));
  return (Array.isArray(parsed.models) ? parsed.models : []).map(record)
    .filter(model => typeof model.slug === "string" && model.visibility === "list")
    .map(model => ({ slug: String(model.slug), displayName: str(model.display_name) ?? String(model.slug), description: str(model.description), priority: typeof model.priority === "number" ? model.priority : 50 }))
    .sort((a, b) => a.priority - b.priority);
}

/** One `codex exec` turn. Resolves with the final agent message. */
export async function runCodexExec(request: CodexExecRequest, options: CodexCliOptions = {}): Promise<CodexExecResult> {
  if (request.signal?.aborted) throw new CodexCliError("CANCELLED", "Запрос к ChatGPT отменён.");
  const command = options.command ?? await codexCliCommand(options.env);
  const agent = request.agent;
  const workspace = agent?.workdir ?? options.workspace ?? codexWorkspaceDirectory();
  const spawnImpl = options.spawnImpl ?? spawn;
  const env = { ...codexCliEnv(options.env), ...(agent?.extraEnv ?? {}) };
  await mkdir(workspace, { recursive: true });
  let instructionsFile: string | undefined;
  if (!agent) {
    const promptDirectory = join(workspace, "..", "prompts");
    await mkdir(promptDirectory, { recursive: true });
    // Replaces Codex's coding-agent base instructions; a file keeps them off the Windows command line.
    instructionsFile = join(promptDirectory, `${randomUUID()}.txt`);
    await writeFile(instructionsFile, request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, "utf8");
  }
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    const args = agent ? codexAgentExecArgs(request, agent) : codexExecArgs(request, instructionsFile!, workspace);
    child = spawnImpl(command, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch {
    if (instructionsFile) await rm(instructionsFile, { force: true });
    throw new CodexCliError("CLI_NOT_INSTALLED", "Codex CLI не запускается. Установите или обновите Codex.");
  }
  if (child.pid) options.onSpawn?.(child.pid);

  const state: { sessionId?: string; messages: string[]; warnings: string[]; errors: string[]; usage?: Record<string, unknown>; completed: boolean; stderr: string; failure?: CodexCliError } =
    { messages: [], warnings: [], errors: [], completed: false, stderr: "" };
  const emit = (event: CodexStreamEvent) => { try { request.onEvent?.(event); } catch { /* a slow client must not break the turn */ } };
  const stop = (failure: CodexCliError) => { state.failure ??= failure; if (child.exitCode === null) child.kill(); };

  child.stdin?.on("error", () => undefined);
  // Agent mode keeps Codex's own coding instructions; SnarkRoute's brief travels with the prompt.
  child.stdin?.end(agent && request.systemPrompt?.trim() ? `${request.systemPrompt.trim()}\n\n---\n\n${request.prompt}` : request.prompt);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { if (state.stderr.length < 8_000) state.stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", line => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const type = str(event.type);
    if (agent && type === "item.completed") {
      const item = record(event.item);
      if (item.type === "agent_message" && typeof item.text === "string") state.messages.push(item.text);
      else if (item.type && item.type !== "reasoning") emit({ type: "item", itemType: String(item.type), summary: summarizeCodexItem(item) });
      return;
    }
    if (type === "thread.started") {
      state.sessionId = str(event.thread_id);
      emit({ type: "session", sessionId: state.sessionId ?? "" });
    } else if (type === "item.completed") {
      const item = record(event.item);
      if (item.type === "agent_message" && typeof item.text === "string") state.messages.push(item.text);
      // Non-fatal notices (model switch on resume, missing model metadata) arrive as error items.
      else if (item.type === "error" && typeof item.message === "string") { state.warnings.push(item.message); emit({ type: "warning", message: item.message }); }
      else if (item.type && item.type !== "reasoning") stop(new CodexCliError("CLI_ERROR", `Codex попытался выполнить действие (${String(item.type)}) в режиме простого текста. Запрос остановлен.`));
    } else if (type === "turn.completed") {
      state.usage = record(event.usage);
      state.completed = true;
    } else if (type === "error") {
      if (typeof event.message === "string") state.errors.push(event.message);
    } else if (type === "turn.failed") {
      const message = str(record(event.error).message);
      if (message) state.errors.push(message);
    }
  });

  const onAbort = () => stop(new CodexCliError("CANCELLED", "Запрос к ChatGPT отменён."));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = request.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const timer = setTimeout(() => stop(new CodexCliError("TIMEOUT", `ChatGPT не ответил за ${Math.round(timeoutMs / 1000)} с.`, { retryable: true })), timeoutMs);
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", error => reject(new CodexCliError("CLI_NOT_INSTALLED", `Codex CLI не запускается (${(error as NodeJS.ErrnoException).code ?? error.message}). Установите или обновите Codex.`)));
      child.once("close", code => resolve(code));
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    lines.close();
    if (instructionsFile) await rm(instructionsFile, { force: true });
  }

  // Codex records the resolved model and the plan's windows in its own session file.
  const session = state.sessionId ? await readCodexSession(state.sessionId, options.env).catch(() => undefined) : undefined;
  if (session?.rateLimit) emit({ type: "rate_limit", info: session.rateLimit });
  // Awaited (~0.3 s) so a server shutdown right after the turn cannot leave the session behind.
  if (state.sessionId && !request.persist && !request.resumeSessionId) await deleteCodexSession(spawnImpl, command, env, state.sessionId);
  if (state.failure) throw withSession(state.failure, state.sessionId);
  const text = state.messages.at(-1) ?? "";
  if (!state.completed || exitCode !== 0 || !text.trim()) {
    throw withSession(classifyCodexFailure(state.errors.join("\n") || state.stderr, session?.rateLimit, exitCode), state.sessionId);
  }
  const usage = state.usage ?? {};
  const final: CodexExecResult = {
    text,
    sessionId: state.sessionId ?? "",
    model: session?.model ?? request.model ?? "default",
    usage: {
      inputTokens: num(usage.input_tokens),
      cachedInputTokens: num(usage.cached_input_tokens),
      outputTokens: num(usage.output_tokens),
      reasoningOutputTokens: num(usage.reasoning_output_tokens)
    },
    durationMs: Date.now() - startedAt,
    rateLimit: session?.rateLimit,
    warnings: state.warnings
  };
  emit({ type: "result", result: final });
  return final;
}

export function classifyCodexFailure(text: string, rateLimit: CodexRateLimitInfo | undefined, exitCode: number | null): CodexCliError {
  const message = redactSecrets(extractErrorMessage(text).trim()).slice(0, 500);
  const resetsAt = limitResetsAt(rateLimit);
  if (/\b401\b|unauthori[sz]ed|not logged in|please (log ?in|sign in)|codex login|refresh token|token (has )?expired|authentication/i.test(text)) {
    return new CodexCliError("NOT_LOGGED_IN", `Codex не авторизован через ChatGPT. Выполните codex login. ${message}`.trim());
  }
  if (/usage limit|hit your (usage )?limit|rate.?limit|\b429\b|too many requests|quota|usage_limit_reached|limit reached/i.test(text)) {
    return new CodexCliError("SUBSCRIPTION_LIMIT_REACHED", `Лимит подписки ChatGPT исчерпан.${resetsAt ? ` Сброс: ${resetsAt}.` : ""} ${message}`.trim(), { resetsAt, retryable: true });
  }
  if (/model_not_found|model .*not supported|not supported when using codex|does not exist|unknown model/i.test(text)) {
    return new CodexCliError("MODEL_UNAVAILABLE", `Модель недоступна для этой подписки ChatGPT. ${message}`.trim());
  }
  if (/\b5\d\d\b|overloaded|internal server error|service unavailable|stream disconnected|timed out/i.test(text)) {
    return new CodexCliError("CLI_ERROR", `ChatGPT временно недоступен. ${message}`.trim(), { retryable: true });
  }
  return new CodexCliError("CLI_ERROR", `Codex завершился с ошибкой${exitCode === null ? "" : ` (код ${exitCode})`}. ${message}`.trim());
}

/** Codex nests API errors as JSON inside the message string. */
function extractErrorMessage(text: string): string {
  try {
    const parsed = record(JSON.parse(text.trim()));
    return str(record(parsed.error).message) ?? str(parsed.message) ?? text;
  } catch { return text; }
}

export function parseCodexRateLimits(raw: Record<string, unknown>): CodexRateLimitInfo {
  const window = (value: unknown): CodexRateLimitWindow | undefined => {
    const item = record(value);
    if (typeof item.used_percent !== "number") return undefined;
    const resets = item.resets_at;
    return {
      usedPercent: item.used_percent,
      windowMinutes: typeof item.window_minutes === "number" ? item.window_minutes : undefined,
      resetsAt: typeof resets === "number" && Number.isFinite(resets) ? new Date(resets < 1e12 ? resets * 1000 : resets).toISOString()
        : typeof resets === "string" && Number.isFinite(Date.parse(resets)) ? new Date(resets).toISOString() : undefined
    };
  };
  const credits = record(raw.credits);
  return {
    planType: str(raw.plan_type),
    primary: window(raw.primary),
    secondary: window(raw.secondary),
    hasCredits: credits.has_credits === true || credits.unlimited === true,
    reachedType: str(raw.rate_limit_reached_type),
    spendControlReached: raw.spend_control_reached === true,
    raw
  };
}

/** True when a plan window is used up; the next turn would fail or draw paid credits. */
export function codexLimitReached(info: CodexRateLimitInfo): boolean {
  return Boolean(info.reachedType) || info.spendControlReached === true
    || [info.primary, info.secondary].some(window => window && window.usedPercent >= 100);
}

export function limitResetsAt(info: CodexRateLimitInfo | undefined): string | undefined {
  if (!info) return undefined;
  const exhausted = [info.primary, info.secondary].filter(window => window && window.usedPercent >= 100 && window.resetsAt).map(window => window!.resetsAt!);
  return exhausted.sort().at(-1);
}

/** Reads the session file Codex itself wrote: last resolved model and the plan's rate-limit snapshot. Holds no credentials. */
export async function readCodexSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ model?: string; rateLimit?: CodexRateLimitInfo; path: string } | undefined> {
  const path = await findCodexSessionFile(sessionId, env);
  if (!path) return undefined;
  let model: string | undefined;
  let rateLimits: Record<string, unknown> | undefined;
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.includes('"turn_context"') && !line.includes('"rate_limits"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const payload = record(entry.payload);
    if (entry.type === "turn_context" && typeof payload.model === "string") model = payload.model;
    if (payload.type === "token_count" && payload.rate_limits && typeof payload.rate_limits === "object") rateLimits = record(payload.rate_limits);
  }
  return { path, model, rateLimit: rateLimits ? parseCodexRateLimits(rateLimits) : undefined };
}

async function findCodexSessionFile(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return undefined;
  const root = join(codexHome(env), "sessions");
  const suffix = `${sessionId}.jsonl`;
  const pad = (value: number) => String(value).padStart(2, "0");
  // Files live in sessions/YYYY/MM/DD by local creation date; check the recent days first.
  for (let offset = 0; offset < 3; offset += 1) {
    const day = new Date(Date.now() - offset * 86_400_000);
    const directory = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    const match = (await readdir(directory).catch(() => [] as string[])).find(name => name.endsWith(suffix));
    if (match) return join(directory, match);
  }
  for (const year of (await readdir(root).catch(() => [] as string[])).sort().reverse()) {
    for (const month of (await readdir(join(root, year)).catch(() => [] as string[])).sort().reverse()) {
      for (const date of (await readdir(join(root, year, month)).catch(() => [] as string[])).sort().reverse()) {
        const match = (await readdir(join(root, year, month, date)).catch(() => [] as string[])).find(name => name.endsWith(suffix));
        if (match) return join(root, year, month, date, match);
      }
    }
  }
  return undefined;
}

/** `codex delete --force <uuid>`: removes a SnarkRoute session from the owner's Codex session list. */
export async function deleteCodexSession(spawnImpl: typeof spawn, command: string, env: NodeJS.ProcessEnv, sessionId: string): Promise<boolean> {
  const result = await runShort(spawnImpl, command, ["delete", "--force", sessionId], env).catch(() => undefined);
  return result?.exitCode === 0;
}

function summarizeCodexItem(item: Record<string, unknown>): string {
  if(item.type==="image_view"&&typeof item.path==="string")return item.path.slice(0,1000);
  if (typeof item.command === "string") return `${item.command}${typeof item.exit_code === "number" ? ` → ${item.exit_code}` : ""}`.slice(0, 400);
  if (Array.isArray(item.changes)) return item.changes.map(change => `${str(record(change).kind) ?? "edit"} ${str(record(change).path) ?? ""}`).join(", ").slice(0, 400);
  if (typeof item.message === "string") return item.message.slice(0, 400);
  if (typeof item.text === "string") return item.text.slice(0, 400);
  return "";
}

function withSession(error: CodexCliError, sessionId: string | undefined): CodexCliError {
  return sessionId && !error.details.sessionId ? new CodexCliError(error.code, error.message, { ...error.details, sessionId }) : error;
}

function runShort(spawnImpl: typeof spawn, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { reject(error); return; }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { if (stderr.length < 8_000) stderr += String(chunk); });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", exitCode => { clearTimeout(timer); resolve({ stdout, stderr, exitCode }); });
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
