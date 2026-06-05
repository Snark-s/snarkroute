import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { createReplicateClient } from "@snarkroute/replicate";
import { createOpenRouterClient, readOpenRouterModelCatalogCache, readOpenRouterPricingCatalogCache, refreshOpenRouterModelCatalog, refreshOpenRouterPricingCatalog, refreshOpenRouterPricingCatalogFromModelCache } from "@snarkroute/openrouter";
import { createPolzaClient, readPolzaPricingCatalogCache, refreshPolzaPricingCatalog } from "@snarkroute/polza";
import { openRouterCatalogCachePath, openRouterPricingCachePath, polzaPricingCachePath, providerLinksPath } from "../server-paths";
import { createModelResolver } from "@snarkroute/openrouter";
import { loadModelRouteMappings, quoteModelExecutingNode } from "../execution/model-gateway-runners";
import { isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterPublicError, openRouterSettingsStatus } from "../providers/openrouter";
import { seedanceSettingsStatus, validateSeedanceConfiguration } from "../providers/seedance";
import { livingCanvasModelMetadata } from "../providers/living-canvas-model-catalog";

type PricingCatalog = {
  provider: string;
  fetchedAt: string;
  expiresAt: string;
  source: string;
  sourceUrl: string | null;
  models: Record<string, { currency: string; pricing: Record<string, unknown>; raw?: Record<string, unknown> }>;
  warnings: string[];
};

export async function registerProviderRoutes(app: FastifyInstance) {
app.get("/api/providers/links", async (request, reply) => {
  try {
    return JSON.parse(await readFile(providerLinksPath, "utf8"));
  } catch (error) {
    return reply.code(500).send({ error: `Provider links are unavailable: ${errorMessage(error)}` });
  }
});

app.get("/api/providers/openrouter/status", async () => ({ openrouter: await openRouterSettingsStatus() }));
app.get("/api/providers/seedance/status", async () => ({ seedance: seedanceSettingsStatus() }));

app.post("/api/providers/seedance/test", async (request, reply) => {
  const result = validateSeedanceConfiguration();
  if (!result.ok) return reply.code(400).send({ ok: false, error: result.error, seedance: result.status });
  return { ok: true, status: "configured", message: "Seedance configuration has the required local settings.", seedance: result.status };
});

app.post("/api/providers/openrouter/test", async (request, reply) => {
  try {
    if (!isOpenRouterEnabled()) return reply.code(400).send({ ok: false, error: "OpenRouter API key is not set" });
    const result = await createOpenRouterClient().testConnection();
    return { ok: true, status: "connected", message: "Connected", modelCount: result.modelCount };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: openRouterPublicError(error) });
  }
});

app.post("/api/providers/openrouter/refresh-model-catalog", async (request, reply) => {
  try {
    const cache = await refreshOpenRouterModelCatalog({ cachePath: openRouterCatalogCachePath });
    return { ok: true, refreshedAt: cache.refreshedAt, modelCount: cache.models.length, sourceCounts: cache.sourceCounts, models: cache.models };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: `OpenRouter catalog refresh failed: ${openRouterPublicError(error)}` });
  }
});

app.post<{ Body: { provider?: "openrouter" | "polza" | "gemini" | "all" | string } }>("/api/model-pricing/refresh", async (request) => {
  const provider = request.body?.provider ?? "all";
  const targets = provider === "all" ? ["openrouter", "polza"] : [provider];
  const refreshed: string[] = [];
  const failed: Array<{ provider: string; error: string }> = [];
  const warnings: string[] = [];
  for (const target of targets) {
    if (target === "openrouter") {
      try {
        await refreshWithTimeout(
          refreshOpenRouterPricingCatalog({ cachePath: openRouterPricingCachePath, modelCatalogCachePath: openRouterCatalogCachePath }),
          8000
        );
        refreshed.push("openrouter");
      } catch (error) {
        const fromModelCache = await refreshOpenRouterPricingCatalogFromModelCache({ cachePath: openRouterPricingCachePath, modelCatalogCachePath: openRouterCatalogCachePath }).catch(() => null);
        if (fromModelCache) {
          refreshed.push("openrouter");
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
        await refreshWithTimeout(refreshPolzaPricingCatalog({ cachePath: polzaPricingCachePath }), 8000);
        refreshed.push("polza");
      } catch (error) {
        failed.push({ provider: "polza", error: errorMessage(error) });
      }
      continue;
    }
    if (target === "gemini") {
      warnings.push("Gemini pricing has no machine-readable refresh source configured; manual override fallback remains in use.");
      continue;
    }
    failed.push({ provider: target, error: "Unsupported pricing provider." });
  }
  return { refreshed, failed, warnings };
});

app.get("/api/providers/openrouter/models", async () => {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  const models = (cache?.models ?? []).map((model) => ({ ...model, ...livingCanvasModelMetadata(model.id, "openrouter") }));
  return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: models.length, sourceCounts: cache?.sourceCounts, models };
});

app.post<{ Body: { nodeType?: string; params?: Record<string, unknown> } }>("/api/model-gateway/quote", async (request, reply) => {
  try {
    const nodeType = typeof request.body?.nodeType === "string" ? request.body.nodeType : "";
    const params = sanitizeQuoteParams(request.body?.params);
    const polzaModels = nodeType.startsWith("polza.") && isPolzaEnabled()
      ? await createPolzaClient().getModels(nodeType === "polza.text" ? "chat" : nodeType === "polza.video.generate" ? "video" : "image").catch(() => [])
      : [];
    const openRouterPricingCatalog = nodeType === "ai.text" || nodeType === "ai.image.generate" ? await ensurePricingCatalog("openrouter") : null;
    const polzaPricingCatalog = nodeType.startsWith("polza.") ? await ensurePricingCatalog("polza") : null;
    return await quoteModelExecutingNode({
      nodeType,
      params,
      modelResolver: createModelResolver(await loadModelRouteMappings()),
      polzaModels,
      openRouterPricingCatalog,
      polzaPricingCatalog
    });
  } catch (error) {
    return reply.code(200).send({
      selected: {
        provider: "unknown",
        providerModel: String(request.body?.params?.model ?? request.body?.nodeType ?? "unknown"),
        capability: "unknown",
        estimatedCost: null,
        currency: null,
        pricingSource: "unknown",
        confidence: "unknown",
        unit: "unknown",
        warnings: [errorMessage(error)]
      },
      alternatives: [],
      warnings: [errorMessage(error)]
    });
  }
});

app.get<{ Querystring: { type?: "chat" | "image" | "video" | "embedding" } }>("/api/providers/polza/models", async (request, reply) => {
  try {
    if (!isPolzaEnabled()) return { ok: true, configured: false, modelCount: 0, models: [] };
    const models = await createPolzaClient().getModels(request.query.type);
    const livingCanvasModels = models.map((model) => ({ ...model, ...livingCanvasModelMetadata(model.id, "polza", request.query.type) }));
    return { ok: true, configured: true, modelCount: livingCanvasModels.length, models: livingCanvasModels };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.get<{ Querystring: { model?: string } }>("/api/replicate/schema", async (request, reply) => {
  if (!isReplicateEnabled()) return reply.code(400).send({ error: "REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token." });
  if (!request.query.model) return reply.code(400).send({ error: "Query parameter model is required." });
  try {
    return await createReplicateClient().getModelSchema(request.query.model);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

}

function sanitizeQuoteParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  return Object.fromEntries(Object.entries(params as Record<string, unknown>).filter(([key]) => !/api[_-]?key|token|secret|password/i.test(key)));
}

async function ensurePricingCatalog(provider: "openrouter" | "polza"): Promise<PricingCatalog | null> {
  const cache = provider === "openrouter"
    ? await readOpenRouterPricingCatalogCache(openRouterPricingCachePath)
    : await readPolzaPricingCatalogCache(polzaPricingCachePath);
  if (cache && Date.parse(cache.expiresAt) > Date.now()) return cache;
  try {
    if (provider === "openrouter") {
      return await refreshWithTimeout(
        refreshOpenRouterPricingCatalog({ cachePath: openRouterPricingCachePath, modelCatalogCachePath: openRouterCatalogCachePath }),
        5000
      );
    }
    if (!isPolzaEnabled()) return cache;
    return await refreshWithTimeout(refreshPolzaPricingCatalog({ cachePath: polzaPricingCachePath }), 5000);
  } catch {
    return cache
      ? { ...cache, warnings: [...(cache.warnings ?? []), `${provider === "openrouter" ? "OpenRouter" : "Polza"} pricing catalog is stale; using stale estimate`] }
      : null;
  }
}

function refreshWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Pricing refresh timed out after ${timeoutMs}ms.`)), timeoutMs))
  ]);
}
