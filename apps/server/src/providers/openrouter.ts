import { readOpenRouterModelCatalogCache } from "@snarkroute/openrouter";
import { openRouterCatalogCachePath } from "../server-paths";
import { errorMessage } from "../services/errors";
import { isOpenRouterEnabled } from "../services/env";
export async function openRouterSettingsStatus() {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  const defaultModel = process.env.OPENROUTER_DEFAULT_MODEL?.trim() || "text.default";
  const models = cache?.models ?? [];
  const resolvedDefault = defaultModel === "text.default" ? "openai/gpt-5.2" : defaultModel;
  return {
    configured: isOpenRouterEnabled(),
    maskedApiKey: isOpenRouterEnabled() ? maskSecret(process.env.OPENROUTER_API_KEY) : "",
    defaultModel,
    budgetWarningUsd: numberEnv("OPENROUTER_BUDGET_WARNING_USD"),
    catalog: {
      refreshedAt: cache?.refreshedAt ?? null,
      modelCount: models.length
    },
    defaultModelStatus: models.length === 0 ? "catalog-empty" : models.some((model) => model.id === resolvedDefault) ? "available" : "not-in-catalog"
  };
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

export function openRouterPublicError(error: unknown): string {
  const message = errorMessage(error);
  if (/missing|not set/i.test(message)) return "OpenRouter API key is not set";
  if (/invalid|401|403/i.test(message)) return "OpenRouter API key seems invalid.";
  if (/not available/i.test(message)) return "Model is not available through OpenRouter.";
  if (/unreachable|fetch failed|network request failed/i.test(message)) return "OpenRouter is unreachable. The API key is configured, but SnarkRoute cannot reach OpenRouter. Check internet access, proxy/VPN/firewall settings, DNS, or OPENROUTER_BASE_URL.";
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}
