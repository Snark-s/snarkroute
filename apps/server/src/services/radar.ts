import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGeminiClient } from "@snarkroute/gemini";
import { createOpenRouterClient } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { repoRoot } from "../server-paths";
import { configuredRadars, RADAR_SYSTEM_PROMPT, type RadarDefinition, type RadarProvider } from "./radar-config";

export type RadarPulse = {
  agent: "snarkroute-radar";
  where: "SnarkRoute";
  radarId: string;
  schedule: string;
  lastPulse: string;
  result: "ok" | "ждёт" | "застрял";
  status: "ok" | "ждёт" | "застрял";
  enabled: boolean;
  provider: RadarProvider;
  model: string;
  fallback: boolean;
  fallbackRuns: number;
  outputPath?: string;
  reason?: string;
};

export type RadarModelRequest = {
  provider: RadarProvider;
  model: string;
  systemPrompt: string;
  prompt: string;
};

export type RadarModelResult = {
  text: string;
  provider: RadarProvider;
  model: string;
  fallback?: boolean;
  reason?: string;
  webSearch?: boolean;
};
export type RadarModelInvoker = (request: RadarModelRequest) => Promise<RadarModelResult>;
export type RadarPolzaInvoker = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type RadarClaudeCli = (request: RadarModelRequest) => Promise<RadarClaudeCliResult>;
export type RadarClaudeCliResult = { text: string; model: string; webSearch: boolean };
export type RadarInvokerOptions = {
  claudeCli?: RadarClaudeCli;
  polzaInvoker?: RadarPolzaInvoker;
  polzaTimeoutMs?: number;
  claudeTokenPath?: string;
  claudeCommand?: string;
};

export type RadarClaudeCliOptions = {
  tokenPath?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
};

export const DEFAULT_CLAUDE_OAUTH_TOKEN_PATH = "Y:\\Приложения\\Tove\\data\\secrets\\claude_oauth_token.txt";
export const CLAUDE_SUBSCRIPTION_MODEL = "claude-code-cli";
export const DEFAULT_RADAR_POLZA_TIMEOUT_MS = 120_000;

export type RadarRunResult = {
  radarId: string;
  status: "ok" | "disabled" | "error";
  pulse: RadarPulse;
  outputPath?: string;
  error?: string;
};

export type RadarSchedulerOptions = {
  radars?: readonly RadarDefinition[];
  invoker?: RadarModelInvoker;
  dataRoot?: string;
  now?: () => Date;
  intervalMs?: number;
};

export const RADAR_INTERVAL_MS = 60_000;

export function radarDataRoot(root = repoRoot): string {
  return join(root, "data", "radars");
}

export async function runRadar(
  radar: RadarDefinition,
  options: { invoker?: RadarModelInvoker; dataRoot?: string; now?: () => Date } = {}
): Promise<RadarRunResult> {
  const now = options.now ?? (() => new Date());
  const timestamp = now();
  const dataRoot = options.dataRoot ?? radarDataRoot();
  const radarDir = join(dataRoot, radar.id);
  await mkdir(radarDir, { recursive: true });
  const previousFallbackRuns = await readFallbackRuns(join(radarDir, "pulse.json"));

  if (!radar.enabled) {
    const pulse = makePulse(radar, timestamp, "ждёт", "disabled by config", undefined, undefined, previousFallbackRuns);
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "disabled", pulse };
  }

  try {
    const invoker = options.invoker ?? createDefaultRadarModelInvoker();
    const result = await invoker({ provider: radar.provider, model: radar.model, systemPrompt: RADAR_SYSTEM_PROMPT, prompt: radar.prompt });
    const text = result.text.trim();
    if (!text) throw new Error("Radar model returned empty text.");
    const outputPath = join(radarDir, `${dateKey(timestamp)}.md`);
    await writeFile(outputPath, markdownResult(radar, timestamp, result, text), "utf8");
    const pulse = makePulse(radar, timestamp, "ok", result.reason, outputPath, result, previousFallbackRuns);
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "ok", pulse, outputPath };
  } catch (error) {
    const details = invocationDetails(error);
    const reason = details?.reason ?? errorMessage(error);
    const pulse = makePulse(radar, timestamp, "застрял", reason, undefined, details, previousFallbackRuns);
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "error", pulse, error: reason };
  }
}

export async function runDueRadars(options: RadarSchedulerOptions = {}): Promise<RadarRunResult[]> {
  const radars = options.radars ?? configuredRadars();
  const now = options.now ?? (() => new Date());
  const current = now();
  const results: RadarRunResult[] = [];
  for (const radar of radars) {
    if (radar.enabled && cronMatches(current, radar.schedule)) {
      results.push(await runRadar(radar, options));
    }
  }
  return results;
}

export function startRadarScheduler(options: RadarSchedulerOptions = {}): () => void {
  const radars = options.radars ?? configuredRadars();
  if (!radars.some(radar => radar.enabled)) return () => {};
  const interval = setInterval(() => {
    void runDueRadars(options).catch(() => undefined);
  }, options.intervalMs ?? RADAR_INTERVAL_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

export function cronMatches(date: Date, expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fieldMatches(date.getMinutes(), fields[0], 0, 59)
    && fieldMatches(date.getHours(), fields[1], 0, 23)
    && fieldMatches(date.getDate(), fields[2], 1, 31)
    && fieldMatches(date.getMonth() + 1, fields[3], 1, 12)
    && dayOfWeekMatches(date.getDay(), fields[4]);
}

export function createDefaultRadarModelInvoker(options: RadarInvokerOptions = {}): RadarModelInvoker {
  const claudeCli = options.claudeCli ?? ((request: RadarModelRequest) => runClaudeCli(request, {
    tokenPath: options.claudeTokenPath,
    command: options.claudeCommand
  }));
  const polzaInvoker = options.polzaInvoker ?? ((body: Record<string, unknown>, signal?: AbortSignal) => createPolzaClient().chatCompletions(body, signal));
  const polzaTimeoutMs = options.polzaTimeoutMs ?? configuredPolzaTimeoutMs();

  return async request => {
    if (request.provider === "gemini") {
      const result = await createGeminiClient().generateText(request.model, [{ text: request.prompt }], request.systemPrompt);
      return { text: result.text ?? "", provider: request.provider, model: request.model };
    }
    const body = {
      model: request.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.prompt }
      ]
    };
    if (request.provider === "claude-subscription") {
      const result = await claudeCli(request);
      return { text: result.text, provider: request.provider, model: result.model, webSearch: result.webSearch };
    }
    if (request.provider === "polza") {
      return invokePolzaWithFallback(request, body, polzaInvoker, claudeCli, polzaTimeoutMs);
    }
    const response = await createOpenRouterClient().chatCompletions(body);
    return { text: chatText(response), provider: request.provider, model: request.model };
  };
}

export async function runClaudeCli(request: RadarModelRequest, options: RadarClaudeCliOptions = {}): Promise<RadarClaudeCliResult> {
  const baseEnv = options.env ?? process.env;
  const tokenPath = options.tokenPath ?? baseEnv.SNARKROUTE_CLAUDE_OAUTH_TOKEN_PATH ?? baseEnv.CLAUDE_OAUTH_TOKEN_PATH ?? DEFAULT_CLAUDE_OAUTH_TOKEN_PATH;
  let token: string;
  try {
    token = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    throw new Error("Claude subscription token file could not be read.");
  }
  if (!token) throw new Error("Claude subscription token file is empty.");

  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: token };
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === "ANTHROPIC_API_KEY") delete childEnv[key];
  }
  const command = options.command ?? baseEnv.SNARKROUTE_CLAUDE_COMMAND ?? "claude";
  const prompt = `${request.systemPrompt}\n\nЗадача радара:\n${request.prompt}\n\nВерни только текст Markdown-отчёта без JSON-обёртки.`;
  const args = ["-p", prompt, "--output-format", "json", "--allowedTools", "WebSearch"];
  const first = await runClaudeProcess(command, args, childEnv, options.spawnImpl ?? spawn);
  if (first.exitCode !== 0 && unsupportedWebSearch(first.stderr)) {
    const withoutSearch = await runClaudeProcess(command, ["-p", prompt, "--output-format", "json"], childEnv, options.spawnImpl ?? spawn);
    if (withoutSearch.exitCode !== 0) throw new Error("Claude CLI exited with an error while web search was unavailable.");
    return parseClaudeOutput(withoutSearch.stdout, token, false, baseEnv);
  }
  if (first.exitCode !== 0) throw new Error("Claude CLI exited with an error.");
  return parseClaudeOutput(first.stdout, token, first.exitCode === 0, baseEnv);
}

function fieldMatches(value: number, expression: string, min: number, max: number): boolean {
  return expression.split(",").some(part => {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    if (rangePart === "*") return (value - min) % step === 0;
    const range = rangePart.split("-").map(Number);
    if (range.length === 2 && range.every(Number.isInteger)) {
      return value >= range[0] && value <= range[1] && (value - range[0]) % step === 0;
    }
    const exact = Number(rangePart);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
}

function dayOfWeekMatches(day: number, expression: string): boolean {
  return expression.split(",").some(part => {
    const normalized = part.replace(/(^|[-/])7(?=$|[-/])/g, (_match, prefix: string) => `${prefix}0`);
    return fieldMatches(day, normalized, 0, 6);
  });
}

function dateKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

async function invokePolzaWithFallback(
  request: RadarModelRequest,
  body: Record<string, unknown>,
  polzaInvoker: RadarPolzaInvoker,
  claudeCli: RadarClaudeCli,
  timeoutMs: number
): Promise<RadarModelResult> {
  let reason = "unknown Polza error";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await invokeWithPolzaTimeout(polzaInvoker, body, timeoutMs);
      const text = chatText(response).trim();
      if (!text) throw new Error("Polza radar returned empty text.");
      return { text, provider: "polza", model: request.model, fallback: false };
    } catch (error) {
      reason = safeReason(error);
    }
  }

  const fallbackReason = `Polza failed after one retry: ${reason}`;
  try {
    const result = await claudeCli(request);
    const text = result.text.trim();
    if (!text) throw new Error("Claude fallback returned empty text.");
    return {
      text,
      provider: "claude-subscription",
      model: result.model,
      fallback: true,
      reason: fallbackReason,
      webSearch: result.webSearch
    };
  } catch {
    throw new RadarInvocationError("Claude subscription fallback failed.", {
      provider: "claude-subscription",
      model: CLAUDE_SUBSCRIPTION_MODEL,
      fallback: true,
      reason: `${fallbackReason}; Claude fallback failed.`
    });
  }
}

async function invokeWithPolzaTimeout(polzaInvoker: RadarPolzaInvoker, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await polzaInvoker(body, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Polza radar request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function configuredPolzaTimeoutMs(): number {
  const value = Number(process.env.SNARKROUTE_RADAR_POLZA_TIMEOUT_MS ?? DEFAULT_RADAR_POLZA_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RADAR_POLZA_TIMEOUT_MS;
}

async function runClaudeProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let child: ChildProcess;
  try {
    child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    throw new Error("Claude CLI could not be started.");
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Claude CLI could not be started.")));
    child.once("close", exitCode => resolve({ stdout, stderr, exitCode }));
  });
}

function parseClaudeOutput(stdout: string, token: string, webSearch: boolean, env: NodeJS.ProcessEnv): RadarClaudeCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Claude CLI returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Claude CLI returned an invalid response.");
  const record = parsed as Record<string, unknown>;
  if (record.is_error === true) throw new Error("Claude CLI returned an error.");
  const rawText = typeof record.result === "string" ? record.result : typeof record.text === "string" ? record.text : "";
  const text = rawText.replaceAll(token, "[REDACTED]").trim();
  if (!text) throw new Error("Claude CLI returned empty text.");
  const model = typeof record.model === "string" && record.model.trim()
    ? record.model.trim()
    : env.SNARKROUTE_CLAUDE_MODEL?.trim() || CLAUDE_SUBSCRIPTION_MODEL;
  return { text, model, webSearch };
}

function unsupportedWebSearch(stderr: string): boolean {
  return /unknown (?:option|flag|tool)|unrecognized (?:option|flag)|invalid (?:option|tool)|not supported.*web.?search|web.?search.*not found/i.test(stderr);
}

function markdownResult(radar: RadarDefinition, timestamp: Date, result: RadarModelResult, text: string): string {
  const searchNotice = result.webSearch === false
    ? "> Внимание: веб-поиск недоступен в неинтерактивном режиме Claude CLI; этот отчёт создан без поиска.\n\n"
    : "";
  const fallbackFields = result.fallback
    ? `- Fallback: true\n- Fallback reason: ${safeReason(result.reason ?? "unknown Polza error")}\n`
    : "- Fallback: false\n";
  return `${searchNotice}# ${radar.title}\n\n- Radar: \`${radar.id}\`\n- Generated: ${timestamp.toISOString()}\n- Provider: \`${result.provider}\`\n- Model: \`${result.model}\`\n- Schedule: \`${radar.schedule}\`\n${fallbackFields}\n---\n\n${text}\n`;
}

function makePulse(
  radar: RadarDefinition,
  timestamp: Date,
  status: RadarPulse["status"],
  reason?: string,
  outputPath?: string,
  metadata?: Pick<RadarModelResult, "provider" | "model" | "fallback" | "reason">,
  previousFallbackRuns = 0
): RadarPulse {
  return {
    agent: "snarkroute-radar", where: "SnarkRoute", radarId: radar.id, schedule: radar.schedule,
    lastPulse: timestamp.toISOString(), result: status, status, enabled: radar.enabled,
    provider: metadata?.provider ?? radar.provider, model: metadata?.model ?? radar.model,
    fallback: metadata?.fallback ?? false,
    fallbackRuns: previousFallbackRuns + (metadata?.fallback ? 1 : 0),
    ...(outputPath ? { outputPath } : {}), ...((metadata?.reason ?? reason) ? { reason: safeReason(metadata?.reason ?? reason) } : {})
  };
}

async function readFallbackRuns(path: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { fallbackRuns?: unknown };
    return typeof parsed.fallbackRuns === "number" && Number.isInteger(parsed.fallbackRuns) && parsed.fallbackRuns >= 0 ? parsed.fallbackRuns : 0;
  } catch {
    return 0;
  }
}

function chatText(value: unknown): string {
  const choices = value && typeof value === "object" ? (value as Record<string, unknown>).choices : undefined;
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? (choices[0] as Record<string, unknown>).message
    : undefined;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").join("");
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeReason(error: unknown): string {
  const message = errorMessage(error).replace(/[\r\n]+/g, " ").trim();
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

type RadarInvocationDetails = Pick<RadarModelResult, "provider" | "model" | "fallback" | "reason">;

class RadarInvocationError extends Error {
  constructor(message: string, readonly details: RadarInvocationDetails) {
    super(message);
    this.name = "RadarInvocationError";
  }
}

function invocationDetails(error: unknown): RadarInvocationDetails | undefined {
  return error instanceof RadarInvocationError ? error.details : undefined;
}
