import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { createReplicateClient } from "@snarkroute/replicate";
import { createOpenRouterClient, readOpenRouterModelCatalogCache, refreshOpenRouterModelCatalog } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { openRouterCatalogCachePath, providerLinksPath } from "../server-paths";
import { isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterPublicError, openRouterSettingsStatus } from "../providers/openrouter";
import { seedanceSettingsStatus, validateSeedanceConfiguration } from "../providers/seedance";

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
    return { ok: true, refreshedAt: cache.refreshedAt, modelCount: cache.models.length, models: cache.models };
  } catch (error) {
    return reply.code(400).send({ ok: false, error: `OpenRouter catalog refresh failed: ${openRouterPublicError(error)}` });
  }
});

app.get("/api/providers/openrouter/models", async () => {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: cache?.models.length ?? 0, models: cache?.models ?? [] };
});

app.get<{ Querystring: { type?: "chat" | "image" | "embedding" } }>("/api/providers/polza/models", async (request, reply) => {
  try {
    if (!isPolzaEnabled()) return { ok: true, configured: false, modelCount: 0, models: [] };
    const models = await createPolzaClient().getModels(request.query.type);
    return { ok: true, configured: true, modelCount: models.length, models };
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
