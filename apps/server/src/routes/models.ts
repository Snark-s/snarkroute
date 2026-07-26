import type { FastifyInstance } from "fastify";
import { readOpenRouterModelCatalogCache, refreshOpenRouterModelCatalog } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { documentedRuTronixModels } from "@snarkroute/rutronix";
import type { ModelOutputTypeV1, SuppliedModelInputsV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { openRouterCatalogCachePath } from "../server-paths";
import { isPolzaEnabled } from "../services/env";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { assembleModelCatalogV1, fallbackProviderModelsForCatalogV1, modelOptionsForNodeV1, type RawProviderModelV1 } from "../services/model-catalog-v1";

interface ModelCatalogQuery {
  provider?: string;
  outputType?: string;
  inputType?: string;
  capability?: string;
}

type PolzaCatalogModelType = "chat" | "image" | "video" | "audio" | "embedding";
const defaultCatalogRequestTimeoutMs = 5_000;

export async function registerModelRoutes(app: FastifyInstance) {
app.addHook("onRequest", async (request, reply) => {
  if (request.method !== "GET") return;
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/models/v1") {
    // Model Catalog V1: live provider catalogs merged with curated metadata overlays.
    // Curated metadata is not an availability whitelist.
    const models = filterModelsV1(await loadLiveModelCatalogV1(), {
      provider: normalizeQueryValue(url.searchParams.get("provider")),
      outputType: normalizeQueryValue(url.searchParams.get("outputType")),
      inputType: normalizeQueryValue(url.searchParams.get("inputType")),
      capability: normalizeQueryValue(url.searchParams.get("capability"))
    });
    return reply.send({ ok: true, modelCount: models.length, models });
  }

  if (url.pathname === "/api/models/executable-generation") {
    const nodeTypes = providerNodeManifests()
      .filter((manifest) => manifest.enabled !== false && manifest.executor?.type === "builtin" && manifest.outputs.some((output) => output.type === "image" || output.type === "video"))
      .map((manifest) => manifest.id);
    const catalog = await loadLiveModelCatalogV1();
    const groups = nodeTypes.map((nodeType) => modelOptionsForNodeV1(nodeType, catalog));
    const models = groups.flat();
    return reply.send({ ok: true, nodeTypes, modelCount: models.length, models });
  }

  const nodeType = nodeTypeFromForNodePath(url.pathname);
  if (nodeType) {
    // Node-compatible endpoint: executor-safe selectable models for a specific nodeType.
    // Provider-native selectors must use storedModelId, not the unified catalog id.
    const suppliedInputs = suppliedInputsFromSearchParams(url.searchParams);
    const models = modelOptionsForNodeV1(nodeType, await loadLiveModelCatalogV1(nodeType), suppliedInputs);
    const query = suppliedInputs ? `?image=${suppliedInputs.image ?? 0}&video=${suppliedInputs.video ?? 0}&audio=${suppliedInputs.audio ?? 0}` : "";
    return reply.send({ ok: true, nodeType, suppliedInputs, modelCount: models.length, familyCount: new Set(models.map((model) => modelFamily(model.providerModelId))).size, diagnosticsUrl: `/api/models/for-node/${encodeURIComponent(nodeType)}/debug${query}`, models });
  }

  if (url.pathname !== "/api/models") return;
  // Legacy compatibility endpoint for callers that still consume a singular outputType.
  // It is a thin adapter over Model Catalog V1, never a separate static model source.
  const query: ModelCatalogQuery = {
    provider: url.searchParams.get("provider") ?? undefined,
    outputType: url.searchParams.get("outputType") ?? undefined,
    inputType: url.searchParams.get("inputType") ?? undefined,
    capability: url.searchParams.get("capability") ?? undefined
  };
  const requestedOutputType = normalizeQueryValue(query.outputType);
  const legacyOutputType = isModelOutputTypeV1(requestedOutputType) ? requestedOutputType : undefined;
  const models = filterModelsV1(await loadLiveModelCatalogV1(), {
    provider: normalizeQueryValue(query.provider),
    outputType: requestedOutputType,
    inputType: normalizeQueryValue(query.inputType),
    capability: normalizeQueryValue(query.capability)
  }).flatMap((model) => legacyModelFromV1(model, legacyOutputType));

  return reply.send({
    ok: true,
    modelCount: models.length,
    models
  });
});
}

function legacyModelFromV1(model: ReturnType<typeof assembleModelCatalogV1>[number], requestedOutputType?: ModelOutputTypeV1) {
  const outputType = requestedOutputType && model.outputTypes.includes(requestedOutputType)
    ? requestedOutputType
    : model.outputTypes[0];
  if (!outputType) return [];
  return [{
    id: model.id,
    provider: model.provider,
    providerModelId: model.providerModelId,
    displayName: model.displayName,
    outputType,
    inputTypes: model.inputTypes,
    iconKey: model.iconKey,
    iconPath: model.iconPath,
    parameters: model.parameters,
    catalogStatus: model.catalogStatus,
    capabilities: model.capabilities,
    aliases: model.aliases,
    metadata: model.metadata
  }];
}

async function loadLiveModelCatalogV1(nodeType?: string) {
  const openRouterModels = nodeType?.startsWith("polza.") ? [] : await loadOpenRouterModelsForCatalogV1();
  const polzaTypes = polzaTypesForCatalogV1(nodeType);
  const polzaModels = isPolzaEnabled() && polzaTypes.length > 0
    ? await loadPolzaModelsForCatalogV1(polzaTypes).catch(() => [])
    : [];
  return assembleModelCatalogV1({
    openRouterModels,
    polzaModels,
    rutronixModels: nodeType === undefined || nodeType === "ai.text" ? documentedRuTronixModels() : [],
    fallbackModels: fallbackProviderModelsForCatalogV1()
  });
}

async function loadOpenRouterModelsForCatalogV1(): Promise<RawProviderModelV1[]> {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath).catch(() => null);
  if (cache?.models?.length) return cache.models as RawProviderModelV1[];
  const refreshed = await refreshOpenRouterModelCatalog({ cachePath: openRouterCatalogCachePath }).catch(() => null);
  return (refreshed?.models ?? []) as RawProviderModelV1[];
}

async function loadPolzaModelsForCatalogV1(types: PolzaCatalogModelType[]): Promise<RawProviderModelV1[]> {
  const client = createPolzaClient();
  const timeoutMs = modelCatalogRequestTimeoutMs();
  const groups = await Promise.all(types.map((type) => withTimeout(client.getModels(type), timeoutMs).catch(() => [])));
  return dedupeById(groups.flat()) as RawProviderModelV1[];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Model catalog request timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelCatalogRequestTimeoutMs(): number {
  const configured = Number(process.env.MODEL_CATALOG_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 30_000)
    : defaultCatalogRequestTimeoutMs;
}

function polzaTypesForCatalogV1(nodeType?: string): PolzaCatalogModelType[] {
  if (nodeType === "polza.image.generate") return ["image"];
  if (nodeType === "polza.text") return ["chat"];
  if (nodeType === "polza.video.generate") return ["video"];
  if (nodeType?.startsWith("ai.")) return [];
  return ["chat", "image", "video", "audio", "embedding"];
}

function filterModelsV1<T extends {
  provider: string;
  outputTypes: string[];
  inputTypes: string[];
  capabilities: string[];
}>(
  models: T[],
  filters: { provider?: string; outputType?: string; inputType?: string; capability?: string }
): T[] {
  return models.filter((model) => {
    if (filters.provider && model.provider !== filters.provider) return false;
    if (filters.outputType && !model.outputTypes.includes(filters.outputType)) return false;
    if (filters.inputType && !model.inputTypes.includes(filters.inputType)) return false;
    if (filters.capability && !model.capabilities.includes(filters.capability)) return false;
    return true;
  });
}

function nodeTypeFromForNodePath(pathname: string): string | undefined {
  const prefix = "/api/models/for-node/";
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return undefined;
  return decodeURIComponent(encoded);
}

function nodeTypeFromForNodeDebugPath(pathname: string): string | undefined {
  const suffix = "/debug";
  if (!pathname.endsWith(suffix)) return undefined;
  return nodeTypeFromForNodePath(pathname.slice(0, -suffix.length));
}

function suppliedInputsFromSearchParams(searchParams: URLSearchParams): SuppliedModelInputsV1 | undefined {
  if (!["image", "video", "audio"].some((kind) => searchParams.has(kind))) return undefined;
  return {
    image: inputCount(searchParams.get("image")),
    video: inputCount(searchParams.get("video")),
    audio: inputCount(searchParams.get("audio"))
  };
}

function inputCount(value: string | null): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function dedupeById<T extends { id?: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const id = typeof model.id === "string" ? model.id : "";
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeQueryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const modelOutputTypesV1 = new Set<string>(["text", "image", "video", "audio", "embedding", "json", "unknown"]);

function isModelOutputTypeV1(value: string | undefined): value is ModelOutputTypeV1 {
  return typeof value === "string" && modelOutputTypesV1.has(value);
}
