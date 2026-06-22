import { readFile, writeFile } from "node:fs/promises";
import { envPath } from "../server-paths";

export type AppProduct = "boojum" | "snark";
export type AppMode = "local" | "cloud" | "self_hosted";

export type AppCapabilities = {
  product: AppProduct;
  mode: AppMode;
  authRequiredForSave: boolean;
  supportsCredits: boolean;
  supportsGuestDemo: boolean;
  supportsUserApiKeys: boolean;
  supportsBrowserVault: boolean;
  supportsCloudStoredUserKeys: boolean;
  supportsLocalFilesystem: boolean;
  supportsPublicSharing: boolean;
  supportsDeveloperDiagnostics: boolean;
};

export function appProduct(): AppProduct {
  const value = process.env.APP_PRODUCT?.trim().toLowerCase();
  return value === "snark" ? "snark" : "boojum";
}

export function appMode(): AppMode {
  const value = process.env.APP_MODE?.trim().toLowerCase();
  if (value === "cloud" || value === "self_hosted") return value;
  return "local";
}

export function appCapabilities(): AppCapabilities {
  const product = appProduct();
  const mode = appMode();
  return {
    product,
    mode,
    authRequiredForSave: mode === "cloud",
    supportsCredits: mode === "cloud",
    supportsGuestDemo: true,
    supportsUserApiKeys: mode !== "cloud",
    supportsBrowserVault: false,
    supportsCloudStoredUserKeys: false,
    supportsLocalFilesystem: product === "boojum" || mode !== "cloud",
    supportsPublicSharing: false,
    supportsDeveloperDiagnostics: appDevUi() && !isProduction()
  };
}

export function appDevUi(): boolean {
  const value = process.env.APP_DEV_UI?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === "production";
}

export function assertProductionSafety(): void {
  if (appDevUi() && isProduction()) {
    throw new Error("APP_DEV_UI must not be enabled in production");
  }
  if (!isProduction() || appMode() !== "cloud") return;
  const authSecret = process.env.AUTH_HASH_SECRET?.trim() ?? "";
  if (!authSecret) throw new Error("AUTH_HASH_SECRET is required in production cloud mode");
  if (authSecret.length < 32) throw new Error("AUTH_HASH_SECRET must be at least 32 characters in production cloud mode");
  const authBaseUrl = process.env.AUTH_BASE_URL?.trim() ?? "";
  const appWebUrl = process.env.APP_WEB_URL?.trim() ?? "";
  if (!authBaseUrl) throw new Error("AUTH_BASE_URL is required in production cloud mode");
  if (!appWebUrl) throw new Error("APP_WEB_URL is required in production cloud mode");
  assertProductionPublicUrl(authBaseUrl, "AUTH_BASE_URL");
  assertProductionPublicUrl(appWebUrl, "APP_WEB_URL");
}

function assertProductionPublicUrl(value: string, name: string): void {
  const hostname = urlHostname(value);
  if (!hostname) throw new Error(`${name} must be a valid URL in production cloud mode`);
  if (isLocalhost(hostname)) throw new Error(`${name} must not point to localhost in production cloud mode`);
}

function urlHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

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

export function isElevenLabsEnabled(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

export function isPolzaEnabled(): boolean {
  return Boolean(process.env.POLZA_AI_API_KEY?.trim());
}

export function isWorldLabsEnabled(): boolean {
  return Boolean(process.env.WORLDS_API_KEY?.trim());
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
