import { maskSecret } from "../services/env";

export type SeedanceBackend = "byteplus-modelark" | "volcengine-las" | "seedance-compatible";

export const SEEDANCE_BACKENDS: Record<SeedanceBackend, { label: string; apiKeyEnvKeys: string[]; defaultBaseUrl?: string; baseUrlEnvKey: string }> = {
  "byteplus-modelark": {
    label: "BytePlus ModelArk",
    apiKeyEnvKeys: ["ARK_API_KEY", "BYTEPLUS_ARK_API_KEY", "SEEDANCE_API_KEY"],
    defaultBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    baseUrlEnvKey: "SEEDANCE_API_BASE_URL"
  },
  "volcengine-las": {
    label: "Volcengine LAS",
    apiKeyEnvKeys: ["LAS_API_KEY", "VOLCENGINE_LAS_API_KEY", "SEEDANCE_API_KEY"],
    defaultBaseUrl: "https://operator.las.cn-beijing.volces.com/api/v1",
    baseUrlEnvKey: "SEEDANCE_API_BASE_URL"
  },
  "seedance-compatible": {
    label: "Custom Seedance-compatible endpoint",
    apiKeyEnvKeys: ["SEEDANCE_API_KEY"],
    baseUrlEnvKey: "SEEDANCE_API_BASE_URL"
  }
};

export interface SeedanceSettingsStatus {
  configured: boolean;
  backend: SeedanceBackend | "";
  backendLabel: string;
  maskedApiKey: string;
  apiKeyEnvKey: string;
  hasApiKey: boolean;
  baseUrl: string;
  baseUrlSource: "default" | "custom" | "missing";
  diagnostics: string[];
  statusText: string;
}

export function normalizeSeedanceBackend(value: unknown): SeedanceBackend | "" {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "byteplus-modelark" || text === "seedance-byteplus") return "byteplus-modelark";
  if (text === "volcengine-las" || text === "seedance-volcengine") return "volcengine-las";
  if (text === "seedance-compatible" || text === "seedance" || text === "custom") return "seedance-compatible";
  return "";
}

export function seedanceSettingsStatus(): SeedanceSettingsStatus {
  const backend = normalizeSeedanceBackend(process.env.SEEDANCE_PROVIDER_BACKEND);
  const backendConfig = backend ? SEEDANCE_BACKENDS[backend] : null;
  const keyMatch = backendConfig ? firstEnvValue(backendConfig.apiKeyEnvKeys) : firstEnvValue(["SEEDANCE_API_KEY", "ARK_API_KEY", "BYTEPLUS_ARK_API_KEY", "LAS_API_KEY", "VOLCENGINE_LAS_API_KEY"]);
  const customBaseUrl = process.env.SEEDANCE_API_BASE_URL?.trim() ?? "";
  const baseUrl = customBaseUrl || backendConfig?.defaultBaseUrl || "";
  const diagnostics = [
    backend ? "" : "Seedance provider backend is not selected",
    keyMatch.invalidKey && !keyMatch.value ? `Seedance API key in ${keyMatch.invalidKey} is invalid` : "",
    keyMatch.value ? "" : "Seedance API key is missing",
    baseUrl ? "" : "Seedance API base URL is missing"
  ].filter(Boolean);
  const configured = diagnostics.length === 0;
  return {
    configured,
    backend,
    backendLabel: backendConfig?.label ?? "Not selected",
    maskedApiKey: keyMatch.value ? maskSecret(keyMatch.value) : "",
    apiKeyEnvKey: keyMatch.key || backendConfig?.apiKeyEnvKeys[0] || "SEEDANCE_API_KEY",
    hasApiKey: Boolean(keyMatch.value),
    baseUrl,
    baseUrlSource: customBaseUrl ? "custom" : backendConfig?.defaultBaseUrl ? "default" : "missing",
    diagnostics,
    statusText: configured ? `configured (${backendConfig?.label})` : keyMatch.value && !backend ? "key saved, provider/base URL not verified" : diagnostics[0] ?? "not configured"
  };
}

export function validateSeedanceConfiguration(): { ok: boolean; status: SeedanceSettingsStatus; error?: string } {
  const status = seedanceSettingsStatus();
  return status.configured ? { ok: true, status } : { ok: false, status, error: status.diagnostics[0] ?? "Seedance is not configured" };
}

function firstEnvValue(keys: string[]): { key: string; value: string; invalidKey?: string } {
  let invalidKey = "";
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value && isHeaderSafeSecret(value)) return { key, value, invalidKey };
    if (value && !invalidKey) invalidKey = key;
  }
  return { key: "", value: "", invalidKey };
}

function isHeaderSafeSecret(value: string): boolean {
  return /^[\x21-\x7E]+$/.test(value);
}
