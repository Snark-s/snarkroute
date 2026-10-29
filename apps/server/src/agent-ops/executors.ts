import { CodexCliError, runCodexExec, type CodexExecResult } from "../services/codex-cli";
import { ClaudeCliError, runClaudeCode, type ClaudeCodeResult } from "../services/claude-code-cli";
import type { ResourceRequest } from "./resources";
import type { AgentTask, FailureClass, TaskKind } from "./types";

/**
 * Executor adapters: one transport each, no routing or queue logic. Any new
 * executor (another CLI, a specialised agent) registers the same interface.
 */

export type ExecutorProfile = {
  kinds: TaskKind[];
  editsFiles: boolean;
  shell: boolean;
  maxContextTokens: number;
  quality: "basic" | "normal" | "high";
  /** Where a run can stop early when the owner needs the computer back. */
  pause: "none" | "stage_boundary";
  costTier: "local" | "subscription";
  /** Lower runs first among equally suitable executors of one tier. */
  order: number;
};

export type ExecutorProbe = { installed: boolean; authenticated: boolean | null; detail?: string; checkedAt: string; source: string; model?: string; runtimeId?: string };

export type ExecutorRunContext = {
  task: AgentTask;
  workdir?: string;
  prompt: string;
  brief: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  maxTurns: number;
  log: (line: string) => void;
  onPid: (pid: number) => void;
};

export type ExecutorOutcome = {
  ok: boolean;
  failureClass?: FailureClass;
  message: string;
  summary?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, number>;
  resetsAt?: string;
  quotaReport?: { usedPercent?: number; resetsAt?: string; exhausted?: boolean; source: string; detail?: string };
  artifactText?: string;
};

export interface ExecutorAdapter {
  readonly id: string;
  readonly label: string;
  readonly profile: ExecutorProfile;
  probe(force?: boolean): Promise<ExecutorProbe>;
  resourceRequest(task: AgentTask, probe?: ExecutorProbe): Pick<ResourceRequest, "class" | "runtimeId" | "modelId" | "cpuSlots" | "contextTokens" | "vramMiB" | "ramMiB">;
  run(context: ExecutorRunContext): Promise<ExecutorOutcome>;
}

type AuthReader = (force?: boolean) => Promise<{ installed: boolean; loggedIn: boolean; subscription: boolean; reason?: string; checkedAt: string; version?: string }>;

export class CodexExecutor implements ExecutorAdapter {
  readonly id = "codex_cli";
  readonly label = "Codex CLI (подписка ChatGPT)";
  readonly profile: ExecutorProfile = { kinds: ["code_edit", "code_review", "analysis", "text"], editsFiles: true, shell: true, maxContextTokens: 200_000, quality: "high", pause: "none", costTier: "subscription", order: 1 };

  constructor(private readonly deps: { auth: AuthReader; run?: typeof runCodexExec; model?: () => string | undefined }) {}

  async probe(force = false): Promise<ExecutorProbe> {
    const auth = await this.deps.auth(force);
    return { installed: auth.installed, authenticated: auth.installed ? auth.subscription : false, detail: auth.reason ?? (auth.version ? `codex-cli ${auth.version}` : undefined), checkedAt: auth.checkedAt, source: "codex login status" };
  }

  resourceRequest(task: AgentTask): ReturnType<ExecutorAdapter["resourceRequest"]> {
    // The model runs in the cloud; tools, tests and the CLI itself use this computer's CPU and disk.
    return { class: "light", cpuSlots: 1, ramMiB: 512, contextTokens: task.spec.requirements?.contextTokens };
  }

  async run(context: ExecutorRunContext): Promise<ExecutorOutcome> {
    const permissions = context.task.spec.permissions ?? {};
    try {
      const result: CodexExecResult = await (this.deps.run ?? runCodexExec)({
        model: this.deps.model?.(),
        prompt: context.prompt,
        systemPrompt: context.brief,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        agent: { workdir: context.workdir!, network: permissions.network === true, readOnly: permissions.fileWrite === false, shell: permissions.shell !== "none", extraEnv: context.env },
        onEvent: event => {
          if (event.type === "item") context.log(`[codex ${event.itemType}] ${event.summary}`);
          else if (event.type === "warning") context.log(`[codex warning] ${event.message}`);
          else if (event.type === "session") context.log(`[codex session] ${event.sessionId}`);
        }
      }, { onSpawn: context.onPid });
      const windows = [result.rateLimit?.primary, result.rateLimit?.secondary].filter(Boolean);
      const used = windows.length ? Math.max(...windows.map(window => window!.usedPercent)) : undefined;
      return {
        ok: true, message: "Codex завершил работу.", summary: result.text, sessionId: result.sessionId, model: result.model,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, reasoningTokens: result.usage.reasoningOutputTokens },
        ...(used !== undefined ? { quotaReport: { usedPercent: used, resetsAt: windows.find(window => window!.usedPercent === used)?.resetsAt, source: "codex session file", detail: result.rateLimit?.planType } } : {})
      };
    } catch (error) {
      if (!(error instanceof CodexCliError)) return { ok: false, failureClass: "process", message: String(error instanceof Error ? error.message : error) };
      return { ok: false, failureClass: failureFromCli(error.code, error.message, error.retryable), message: error.message, resetsAt: error.details.resetsAt, sessionId: error.details.sessionId };
    }
  }
}

export const CLAUDE_TEST_TOOLS = [
  "Bash(node:*)", "Bash(npm test:*)", "Bash(npm run test:*)", "Bash(pnpm test:*)", "Bash(pnpm vitest:*)", "Bash(npx vitest:*)",
  "Bash(python -m pytest:*)", "Bash(pytest:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"
];

export function claudeAllowedTools(task: AgentTask): string[] {
  const permissions = task.spec.permissions ?? {};
  const tools = ["Read", "Glob", "Grep", "LS"];
  if (permissions.fileWrite !== false) tools.push("Edit", "MultiEdit", "Write");
  const shell = permissions.shell ?? "tests";
  if (shell === "workspace") tools.push("Bash");
  else if (shell === "tests") {
    tools.push(...CLAUDE_TEST_TOOLS);
    for (const check of task.spec.checks ?? []) {
      if (check.type === "command" && /^[\w.-]+$/.test(check.command)) tools.push(`Bash(${check.command}:*)`);
    }
  }
  return [...new Set(tools)];
}

export class ClaudeCodeExecutor implements ExecutorAdapter {
  readonly id = "claude_code";
  readonly label = "Claude Code (подписка Claude)";
  readonly profile: ExecutorProfile = { kinds: ["code_edit", "code_review", "analysis", "text"], editsFiles: true, shell: true, maxContextTokens: 200_000, quality: "high", pause: "none", costTier: "subscription", order: 2 };

  constructor(private readonly deps: { auth: AuthReader; run?: typeof runClaudeCode; model?: () => string }) {}

  async probe(force = false): Promise<ExecutorProbe> {
    const auth = await this.deps.auth(force);
    return { installed: auth.installed, authenticated: auth.installed ? auth.subscription : false, detail: auth.reason ?? (auth.version ? `claude ${auth.version}` : undefined), checkedAt: auth.checkedAt, source: "claude auth status" };
  }

  resourceRequest(task: AgentTask): ReturnType<ExecutorAdapter["resourceRequest"]> {
    return { class: "light", cpuSlots: 1, ramMiB: 512, contextTokens: task.spec.requirements?.contextTokens };
  }

  async run(context: ExecutorRunContext): Promise<ExecutorOutcome> {
    try {
      const result: ClaudeCodeResult = await (this.deps.run ?? runClaudeCode)({
        model: this.deps.model?.() ?? "sonnet",
        prompt: context.prompt,
        systemPrompt: context.brief,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        agent: { workdir: context.workdir!, allowedTools: claudeAllowedTools(context.task), maxTurns: context.maxTurns, extraEnv: context.env },
        onEvent: event => {
          if (event.type === "tool") context.log(`[claude ${event.name}] ${event.summary}`);
          else if (event.type === "session") context.log(`[claude session] ${event.sessionId} ${event.model}`);
          else if (event.type === "rate_limit") context.log(`[claude rate_limit] ${event.info.status ?? ""} ${event.info.rateLimitType ?? ""} resets ${event.info.resetsAt ?? "?"}`);
        }
      }, { onSpawn: context.onPid });
      const limit = result.rateLimit;
      return {
        ok: true, message: "Claude Code завершил работу.", summary: result.text, sessionId: result.sessionId, model: result.model,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, turns: result.numTurns ?? 0 },
        ...(limit ? { quotaReport: { usedPercent: limit.utilization !== undefined ? Math.round(limit.utilization * (limit.utilization <= 1 ? 100 : 1)) : undefined, resetsAt: limit.resetsAt, exhausted: limit.status === "rejected", source: "claude rate_limit_event", detail: limit.rateLimitType } } : {})
      };
    } catch (error) {
      if (!(error instanceof ClaudeCliError)) return { ok: false, failureClass: "process", message: String(error instanceof Error ? error.message : error) };
      return { ok: false, failureClass: failureFromCli(error.code, error.message, error.retryable), message: error.message, resetsAt: error.details.resetsAt, sessionId: error.details.sessionId };
    }
  }
}

export type LocalTextModel = { provider: string; providerModelId: string; displayName: string; runtimeId: string; contextTokens: number };

/** A local text model through SnarkRoute's own route executor: answers, summaries, analysis; it cannot edit files. */
export class LocalRouteExecutor implements ExecutorAdapter {
  readonly id = "local_route";
  readonly label = "Локальный маршрут SnarkRoute (ai.text)";
  readonly profile: ExecutorProfile = { kinds: ["text", "analysis"], editsFiles: false, shell: false, maxContextTokens: 8192, quality: "normal", pause: "stage_boundary", costTier: "local", order: 0 };

  constructor(private readonly deps: {
    pickModel: (prompt: string) => Promise<LocalTextModel | undefined>;
    runText: (model: LocalTextModel, prompt: string, signal: AbortSignal) => Promise<{ ok: boolean; text?: string; error?: string; usage?: Record<string, number> }>;
  }) {}

  async probe(): Promise<ExecutorProbe> {
    const model = await this.deps.pickModel("probe").catch(() => undefined);
    return { installed: Boolean(model), authenticated: null, checkedAt: new Date().toISOString(), source: "model catalog + semantic routing",
      detail: model ? `${model.displayName} (${model.provider}, ${model.runtimeId})` : "Нет доступной локальной текстовой модели в каталоге.", model: model?.providerModelId, runtimeId: model?.runtimeId };
  }

  resourceRequest(task: AgentTask, probe?: ExecutorProbe): ReturnType<ExecutorAdapter["resourceRequest"]> {
    return { class: "heavy", runtimeId: probe?.runtimeId ?? "ollama", modelId: probe?.model, contextTokens: task.spec.requirements?.contextTokens, cpuSlots: 2 };
  }

  async run(context: ExecutorRunContext): Promise<ExecutorOutcome> {
    const model = await this.deps.pickModel(context.prompt);
    if (!model) return { ok: false, failureClass: "model_unavailable", message: "Локальная текстовая модель недоступна." };
    context.log(`[local] ${model.displayName} via ${model.provider}`);
    const result = await this.deps.runText(model, `${context.brief}\n\n---\n\n${context.prompt}`, context.signal);
    if (context.signal.aborted) return { ok: false, failureClass: "cancelled", message: "Отменено." };
    if (!result.ok || !result.text?.trim()) return { ok: false, failureClass: "process", message: result.error ?? "Локальная модель не вернула текст." };
    return { ok: true, message: "Локальная модель ответила.", summary: result.text, model: model.providerModelId, usage: result.usage, artifactText: result.text };
  }
}

export function failureFromCli(code: string, message: string, retryable: boolean): FailureClass {
  if (code === "SUBSCRIPTION_LIMIT_REACHED") return /\b429\b|too many requests|rate.?limit/i.test(message) && !/usage limit|limit reached|исчерпан/i.test(message) ? "rate_limited" : "quota_exhausted";
  if (code === "NOT_LOGGED_IN" || code === "NOT_SUBSCRIPTION") return "auth";
  if (code === "MODEL_UNAVAILABLE") return "model_unavailable";
  if (code === "CANCELLED") return "cancelled";
  if (code === "TIMEOUT") return "timeout";
  if (code === "CLI_ERROR" && retryable) return "network";
  return "process";
}
