import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { createReplicateClient } from "@snarkroute/replicate";
import { createOpenRouterClient, openRouterModelInfoToModelInfo, readOpenRouterModelCatalogCache, readOpenRouterPricingCatalogCache, refreshOpenRouterModelCatalog, refreshOpenRouterPricingCatalog } from "@snarkroute/openrouter";
import { createPolzaClient, polzaModelInfoToModelInfo, readPolzaPricingCatalogCache, refreshPolzaPricingCatalog } from "@snarkroute/polza";
import { createKieClient, listDocumentedKieModels } from "@snarkroute/kie";
import { documentedRuTronixModels, rutronixModelInfoToModelInfo } from "@snarkroute/rutronix";
import { openRouterCatalogCachePath, openRouterPricingCachePath, polzaPricingCachePath, providerLinksPath } from "../server-paths";
import { createModelResolver } from "@snarkroute/openrouter";
import { refreshModelPricing } from "../billing/model-pricing-refresh-service";
import { loadModelRouteMappings, quoteModelExecutingNode } from "../execution/model-gateway-runners";
import { isKieEnabled, isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterPublicError, openRouterSettingsStatus } from "../providers/openrouter";
import { seedanceSettingsStatus, validateSeedanceConfiguration } from "../providers/seedance";

type PricingCatalog = {
  provider: string;
  fetchedAt: string;
  expiresAt: string;
  source: string;
  sourceUrl: string | null;
  models: Record<string, { currency: string; pricing: Record<string, unknown>; raw?: Record<string, unknown> }>;
  warnings: string[];
};

type PolzaCatalogModelType = "chat" | "image" | "video" | "audio" | "embedding";

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
app.get("/api/providers/kie/status", async () => ({ kie: { configured: isKieEnabled(), modelCount: listDocumentedKieModels().length, discoverySource: "official-documentation" } }));

app.post("/api/providers/kie/test", async (_request, reply) => {
  try {
    if (!isKieEnabled()) return reply.code(400).send({ ok: false, error: "KIE_API_KEY is not set" });
    const credits = await createKieClient().getCredits();
    return { ok: true, status: "connected", credits, modelCount: listDocumentedKieModels().length };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

app.get("/api/providers/kie/models", async () => ({ ok: true, configured: isKieEnabled(), source: "official-documentation", modelCount: listDocumentedKieModels().length, models: listDocumentedKieModels() }));

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
  return refreshModelPricing(request.body?.provider ?? "all");
});

app.get<{ Querystring: { format?: string } }>("/api/providers/openrouter/models", async (request) => {
  // Provider raw endpoint: expose the cached live OpenRouter catalog.
  // Unified V1 catalog semantics live at /api/models/v1.
  // Node-specific executability filtering belongs in /api/models/for-node/:nodeType.
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  if (request.query.format === "model-info") {
    const models = (cache?.models ?? []).map((model) => openRouterModelInfoToModelInfo(model));
    return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: models.length, sourceCounts: cache?.sourceCounts, models };
  }
  const models = cache?.models ?? [];
  return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: models.length, sourceCounts: cache?.sourceCounts, models };
});

app.get<{ Querystring: { format?: string } }>("/api/providers/rutronix/models", async (request) => {
  const models = documentedRuTronixModels();
  return { ok: true, configured: Boolean(process.env.RUTRONIX_API_KEY?.trim()), source: "documented", modelCount: models.length, models: request.query.format === "model-info" ? models.map(rutronixModelInfoToModelInfo) : models };
});

app.post<{ Body: { nodeType?: string; params?: Record<string, unknown> } }>("/api/model-gateway/quote", async (request, reply) => {
  try {
    const nodeType = typeof request.body?.nodeType === "string" ? request.body.nodeType : "";
    const params = sanitizeQuoteParams(request.body?.params);
    const polzaModels = nodeType.startsWith("polza.") && isPolzaEnabled()
      ? await createPolzaClient().getModels(polzaProviderModelTypeForNode(nodeType)).catch(() => [])
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

app.get<{ Querystring: { type?: PolzaCatalogModelType; format?: string } }>("/api/providers/polza/models", async (request, reply) => {
  try {
    if (!isPolzaEnabled()) return { ok: true, configured: false, modelCount: 0, models: [] };
    // Provider raw endpoint: return the live Polza provider catalog for the requested type.
    // Unified V1 catalog semantics live at /api/models/v1.
    // Node-specific executability filtering belongs in /api/models/for-node/:nodeType.
    const models = await createPolzaClient().getModels(request.query.type);
    if (request.query.format === "model-info") {
      const normalizedModels = models.map((model) => polzaModelInfoToModelInfo(model));
      return { ok: true, configured: true, modelCount: normalizedModels.length, models: normalizedModels };
    }
    return { ok: true, configured: true, modelCount: models.length, models };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
});

function polzaProviderModelTypeForNode(nodeType: string): PolzaCatalogModelType {
  if (nodeType === "polza.text") return "chat";
  if (nodeType === "polza.video.generate") return "video";
  if (nodeType === "polza.audio.generate") return "audio";
  return "image";
}

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
