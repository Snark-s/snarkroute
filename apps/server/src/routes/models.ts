import type { FastifyInstance } from "fastify";
import { listKnownModels, type ModelInputType, type ModelOutputType, type ModelProviderId, type UnifiedModelInfo } from "@snarkroute/model-catalog";

interface ModelCatalogQuery {
  provider?: string;
  outputType?: string;
  inputType?: string;
  capability?: string;
}

export async function registerModelRoutes(app: FastifyInstance) {
app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "GET") return;
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/api/models") return;
  const query: ModelCatalogQuery = {
    provider: url.searchParams.get("provider") ?? undefined,
    outputType: url.searchParams.get("outputType") ?? undefined,
    inputType: url.searchParams.get("inputType") ?? undefined,
    capability: url.searchParams.get("capability") ?? undefined
  };
  const models = filterModels(listKnownModels(), {
    provider: normalizeQueryValue(query.provider),
    outputType: normalizeQueryValue(query.outputType) as ModelOutputType | undefined,
    inputType: normalizeQueryValue(query.inputType) as ModelInputType | undefined,
    capability: normalizeQueryValue(query.capability)
  });

  return reply.send({
    ok: true,
    modelCount: models.length,
    models
  });
});
}

function filterModels(
  models: UnifiedModelInfo[],
  filters: { provider?: ModelProviderId; outputType?: ModelOutputType; inputType?: ModelInputType; capability?: string }
): UnifiedModelInfo[] {
  return models.filter((model) => {
    if (filters.provider && model.provider !== filters.provider) return false;
    if (filters.outputType && model.outputType !== filters.outputType) return false;
    if (filters.inputType && !model.inputTypes.includes(filters.inputType)) return false;
    if (filters.capability && !(model.capabilities ?? []).includes(filters.capability)) return false;
    return true;
  });
}

function normalizeQueryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
