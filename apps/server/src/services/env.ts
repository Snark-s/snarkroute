import { readFile, writeFile } from "node:fs/promises";
import { envPath } from "../server-paths";

export function isReplicateEnabled(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

export function isGeminiEnabled(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function isOpenAiEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function isOpenRouterEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function isPolzaEnabled(): boolean {
  return Boolean(process.env.POLZA_AI_API_KEY?.trim());
}

export function isSeedanceEnabled(): boolean {
  const backend = process.env.SEEDANCE_PROVIDER_BACKEND?.trim();
  const apiKey = process.env.SEEDANCE_API_KEY?.trim() || process.env.ARK_API_KEY?.trim() || process.env.BYTEPLUS_ARK_API_KEY?.trim() || process.env.LAS_API_KEY?.trim() || process.env.VOLCENGINE_LAS_API_KEY?.trim();
  const hasOfficialDefault = backend === "byteplus-modelark" || backend === "seedance-byteplus" || backend === "volcengine-las" || backend === "seedance-volcengine";
  return Boolean(backend && apiKey && (hasOfficialDefault || process.env.SEEDANCE_API_BASE_URL?.trim()));
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function numberEnv(key: string): number | null {
  const number = Number(process.env[key]);
  return Number.isFinite(number) ? number : null;
}

export function maskSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.length <= 8 ? "********" : `${trimmed.slice(0, 4)}${"*".repeat(Math.min(16, Math.max(8, trimmed.length - 8)))}${trimmed.slice(-4)}`;
}

export async function writeEnvValue(key: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    text = "";
  }

  const escaped = value.replace(/\r?\n/g, "");
  const line = `${key}=${escaped}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.trimEnd()}${text.trimEnd() ? "\n" : ""}${line}\n`;

  await writeFile(envPath, next, "utf8");
}
