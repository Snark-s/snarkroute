import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { createReplicateClient } from "@snarkroute/replicate";
import { createOpenRouterClient, openRouterModelInfoToModelInfo, readOpenRouterModelCatalogCache, readOpenRouterPricingCatalogCache, refreshOpenRouterModelCatalog, refreshOpenRouterPricingCatalog, refreshOpenRouterPricingCatalogFromModelCache } from "@snarkroute/openrouter";
import { createPolzaClient, polzaModelInfoToModelInfo, readPolzaPricingCatalogCache, refreshPolzaPricingCatalog } from "@snarkroute/polza";
import { openRouterCatalogCachePath, openRouterPricingCachePath, polzaPricingCachePath, providerLinksPath } from "../server-paths";
import { createModelResolver } from "@snarkroute/openrouter";
import { invalidatePricingCache } from "../billing/pricing-service";
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
  if (refreshed.length > 0) invalidatePricingCache();
  return { refreshed, failed, warnings };
});

app.get<{ Querystring: { format?: string } }>("/api/providers/openrouter/models", async (request) => {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  if (request.query.format === "model-info") {
    const models = (cache?.models ?? []).map((model) => enrichModelInfo(openRouterModelInfoToModelInfo(model), "openrouter"));
    return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: models.length, sourceCounts: cache?.sourceCounts, models };
  }
  const models = (cache?.models ?? []).map((model) => ({ ...model, ...livingCanvasModelMetadata(model.id, "openrouter") }));
  return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: models.length, sourceCounts: cache?.sourceCounts, models };
});

app.get<{ Querystring: { provider?: string; capability?: string; media?: string } }>("/api/models", async (request, reply) => {
  try {
    const models = await loadNormalizedModelCatalog(request.query.provider, { capability: request.query.capability, media: request.query.media });
    return filterNormalizedModels(models, { capability: request.query.capability, media: request.query.media });
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
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

app.get<{ Querystring: { type?: "chat" | "image" | "video" | "embedding"; format?: string } }>("/api/providers/polza/models", async (request, reply) => {
  try {
    if (!isPolzaEnabled()) return { ok: true, configured: false, modelCount: 0, models: [] };
    // Provider endpoint semantics: return the live Polza provider catalog for the requested type.
    // Node-specific executability filtering belongs in /api/models/for-node/:nodeType.
    const models = await createPolzaClient().getModels(request.query.type);
    if (request.query.format === "model-info") {
      const normalizedModels = models.map((model) => enrichModelInfo(polzaModelInfoToModelInfo(model), "polza"));
      return { ok: true, configured: true, modelCount: normalizedModels.length, models: normalizedModels };
    }
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

async function loadNormalizedModelCatalog(provider?: string, filters: { capability?: string; media?: string } = {}) {
  const normalizedProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const models = [];
  if (!normalizedProvider || normalizedProvider === "openrouter") {
    const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
    models.push(...(cache?.models ?? []).map((model) => enrichModelInfo(openRouterModelInfoToModelInfo(model), "openrouter")));
  }
  if ((!normalizedProvider || normalizedProvider === "polza") && isPolzaEnabled()) {
    const client = createPolzaClient();
    const modelGroups = await Promise.all(polzaTypesForFilters(filters).map((type) => client.getModels(type).catch(() => [])));
    models.push(...dedupeByProviderModel(modelGroups.flat()).map((model) => enrichModelInfo(polzaModelInfoToModelInfo(model), "polza")));
  }
  return models;
}

function polzaTypesForFilters(filters: { capability?: string; media?: string }): Array<"chat" | "image" | "video" | "embedding"> {
  const capability = typeof filters.capability === "string" ? filters.capability.trim() : "";
  const media = typeof filters.media === "string" ? filters.media.trim().toLowerCase() : "";
  if (capability === "image.generate" || media === "image") return ["image"];
  if (capability === "video.generate" || media === "video") return ["video"];
  if (capability === "embedding.create") return ["embedding"];
  if (capability === "text.generate" || media === "text") return ["chat"];
  return ["chat", "image", "video", "embedding"];
}

function dedupeByProviderModel<T extends { id: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function enrichModelInfo(model: ReturnType<typeof openRouterModelInfoToModelInfo> | ReturnType<typeof polzaModelInfoToModelInfo>, providerId: string) {
  const primaryMedia = model.outputTypes?.[0] ?? capabilityMedia(model.capabilities[0]) ?? "text";
  const livingCanvas = livingCanvasModelMetadata(model.id, providerId, primaryMedia);
  const metadata = {
    ...(model.metadata ?? {}),
    generationParameters: livingCanvas.generationParameters.length ? livingCanvas.generationParameters : (model.metadata ?? {}).generationParameters,
    maxImageInputs: livingCanvas.maxImageInputs,
    imageReferenceSyntax: livingCanvas.imageReferenceSyntax
  };
  return {
    ...model,
    defaultParameters: { ...(model.defaultParameters ?? {}), ...(livingCanvas.defaultParameters ?? {}) },
    metadata: compactRecord(metadata)
  };
}

function filterNormalizedModels(models: Awaited<ReturnType<typeof loadNormalizedModelCatalog>>, filters: { capability?: string; media?: string }) {
  const capability = typeof filters.capability === "string" ? filters.capability.trim() : "";
  const media = typeof filters.media === "string" ? filters.media.trim().toLowerCase() : "";
  return models.filter((model) => {
    if (capability && !model.capabilities.includes(capability)) return false;
    if (!media) return true;
    const ioKinds = [
      ...(model.inputTypes ?? []),
      ...(model.outputTypes ?? []),
      ...(model.ioContract?.inputs ?? []).map((item: { kind?: unknown }) => item.kind),
      ...(model.ioContract?.outputs ?? []).map((item: { kind?: unknown }) => item.kind)
    ].map((value) => String(value).toLowerCase());
    return ioKinds.includes(media);
  });
}

function capabilityMedia(capability: string | undefined): string | undefined {
  if (!capability) return undefined;
  if (capability.startsWith("image.")) return "image";
  if (capability.startsWith("video.")) return "video";
  if (capability.startsWith("audio.")) return "audio";
  if (capability.startsWith("embedding.")) return "json";
  return "text";
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)));
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
