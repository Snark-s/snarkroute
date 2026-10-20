import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGeminiClient } from "@snarkroute/gemini";
import { createOpenRouterClient } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { repoRoot } from "../server-paths";
import { DEFAULT_RADARS, type RadarDefinition, type RadarProvider } from "./radar-config";

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
  outputPath?: string;
  reason?: string;
};

export type RadarModelRequest = {
  provider: RadarProvider;
  model: string;
  prompt: string;
};

export type RadarModelResult = { text: string; provider: RadarProvider; model: string };
export type RadarModelInvoker = (request: RadarModelRequest) => Promise<RadarModelResult>;

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

  if (!radar.enabled) {
    const pulse = makePulse(radar, timestamp, "ждёт", "disabled by config");
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "disabled", pulse };
  }

  try {
    const invoker = options.invoker ?? createDefaultRadarModelInvoker();
    const result = await invoker({ provider: radar.provider, model: radar.model, prompt: radar.prompt });
    const text = result.text.trim();
    if (!text) throw new Error("Radar model returned empty text.");
    const outputPath = join(radarDir, `${dateKey(timestamp)}.md`);
    await writeFile(outputPath, markdownResult(radar, timestamp, result, text), "utf8");
    const pulse = makePulse(radar, timestamp, "ok", undefined, outputPath);
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "ok", pulse, outputPath };
  } catch (error) {
    const reason = errorMessage(error);
    const pulse = makePulse(radar, timestamp, "застрял", reason);
    await writeFile(join(radarDir, "pulse.json"), JSON.stringify(pulse, null, 2), "utf8");
    return { radarId: radar.id, status: "error", pulse, error: reason };
  }
}

export async function runDueRadars(options: RadarSchedulerOptions = {}): Promise<RadarRunResult[]> {
  const radars = options.radars ?? DEFAULT_RADARS;
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
  const radars = options.radars ?? DEFAULT_RADARS;
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

export function createDefaultRadarModelInvoker(): RadarModelInvoker {
  return async request => {
    if (request.provider === "gemini") {
      const result = await createGeminiClient().generateText(request.model, [{ text: request.prompt }]);
      return { text: result.text ?? "", provider: request.provider, model: request.model };
    }
    const body = { model: request.model, messages: [{ role: "user", content: request.prompt }] };
    const response = request.provider === "openrouter"
      ? await createOpenRouterClient().chatCompletions(body)
      : await createPolzaClient().chatCompletions(body);
    return { text: chatText(response), provider: request.provider, model: request.model };
  };
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

function markdownResult(radar: RadarDefinition, timestamp: Date, result: RadarModelResult, text: string): string {
  return `# ${radar.title}\n\n- Radar: \`${radar.id}\`\n- Generated: ${timestamp.toISOString()}\n- Provider: \`${result.provider}\`\n- Model: \`${result.model}\`\n- Schedule: \`${radar.schedule}\`\n\n---\n\n${text}\n`;
}

function makePulse(radar: RadarDefinition, timestamp: Date, status: RadarPulse["status"], reason?: string, outputPath?: string): RadarPulse {
  return {
    agent: "snarkroute-radar", where: "SnarkRoute", radarId: radar.id, schedule: radar.schedule,
    lastPulse: timestamp.toISOString(), result: status, status, enabled: radar.enabled,
    provider: radar.provider, model: radar.model,
    ...(outputPath ? { outputPath } : {}), ...(reason ? { reason } : {})
  };
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
