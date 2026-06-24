import { refreshOpenRouterPricingCatalog, refreshOpenRouterPricingCatalogFromModelCache } from "@snarkroute/openrouter";
import { refreshPolzaPricingCatalog } from "@snarkroute/polza";
import { invalidatePricingCache } from "./pricing-service";
import { getCloudStorage } from "../services/cloud-storage";
import { appMode, isPolzaEnabled } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterCatalogCachePath, openRouterPricingCachePath, polzaPricingCachePath } from "../server-paths";

export type ModelPricingRefreshProvider = "openrouter" | "polza" | "gemini" | "replicate" | "all" | string;

export type ModelPricingRefreshResult = {
  refreshed: string[];
  failed: Array<{ provider: string; error: string }>;
  warnings: string[];
  offeringsUpdated: number;
  pricesUpdated: number;
  stale: number;
};

let inProcessRefresh: Promise<ModelPricingRefreshResult> | null = null;

export async function refreshModelPricing(provider: ModelPricingRefreshProvider = "all"): Promise<ModelPricingRefreshResult> {
  if (inProcessRefresh) return inProcessRefresh;
  inProcessRefresh = runRefreshWithOptionalDbLock(provider).finally(() => {
    inProcessRefresh = null;
  });
  return inProcessRefresh;
}

async function runRefreshWithOptionalDbLock(provider: ModelPricingRefreshProvider): Promise<ModelPricingRefreshResult> {
  if (appMode() === "cloud" && process.env.DATABASE_URL?.trim()) {
    return getCloudStorage().withAdvisoryLock("model_pricing_refresh", () => runRefresh(provider));
  }
  return runRefresh(provider);
}

async function runRefresh(provider: ModelPricingRefreshProvider): Promise<ModelPricingRefreshResult> {
  const targets = provider === "all" ? ["openrouter", "polza", "gemini", "replicate"] : [provider];
  const refreshed: string[] = [];
  const failed: Array<{ provider: string; error: string }> = [];
  const warnings: string[] = [];
  let pricesUpdated = 0;
  for (const target of targets) {
    if (target === "openrouter") {
      try {
        const catalog = await refreshWithTimeout(
          refreshOpenRouterPricingCatalog({ cachePath: openRouterPricingCachePath, modelCatalogCachePath: openRouterCatalogCachePath }),
          8000
        );
        refreshed.push("openrouter");
        pricesUpdated += Object.keys(catalog.models ?? {}).length;
      } catch (error) {
        const fromModelCache = await refreshOpenRouterPricingCatalogFromModelCache({ cachePath: openRouterPricingCachePath, modelCatalogCachePath: openRouterCatalogCachePath }).catch(() => null);
        if (fromModelCache) {
          refreshed.push("openrouter");
          pricesUpdated += Object.keys(fromModelCache.models ?? {}).length;
          warnings.push("OpenRouter pricing refresh used cached model catalog because live refresh failed.");
        } else {
          failed.push({ provider: "openrouter", error: errorMessage(error) });
        }
      }
      continue;
    }
    if (target === "polza") {
      if (!isPolzaEnabled()) {
        failed.push({ provider: "polza", error: "Polza.ai API key is not configured." });
        continue;
      }
      try {
        const catalog = await refreshWithTimeout(refreshPolzaPricingCatalog({ cachePath: polzaPricingCachePath }), 8000);
        refreshed.push("polza");
        pricesUpdated += Object.keys(catalog.models ?? {}).length;
      } catch (error) {
        failed.push({ provider: "polza", error: errorMessage(error) });
      }
      continue;
    }
    if (target === "gemini" || target === "replicate") {
      warnings.push(`${target} pricing has no machine-readable refresh source configured; manual catalog estimates remain in use.`);
      continue;
    }
    failed.push({ provider: target, error: "Unsupported pricing provider." });
  }
  if (refreshed.length > 0) invalidatePricingCache();
  return {
    refreshed,
    failed,
    warnings,
    offeringsUpdated: pricesUpdated,
    pricesUpdated,
    stale: failed.length + warnings.length
  };
}

async function refreshWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Pricing refresh timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
