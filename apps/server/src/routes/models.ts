import type { FastifyInstance } from "fastify";
import { readOpenRouterModelCatalogCache, refreshOpenRouterModelCatalog } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { listDocumentedKieModels } from "@snarkroute/kie";
import { documentedRuTronixModels } from "@snarkroute/rutronix";
import { createLocalUpscaleWorkerClient } from "@snarkroute/local-upscale";
import { createLocalVideoUpscaleWorkerClient } from "@snarkroute/local-video-upscale";
import type { ModelOptionForNodeV1, ModelOutputTypeV1, ModelProviderRouteV1, ModelRoleV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { openRouterCatalogCachePath } from "../server-paths";
import { isPolzaEnabled } from "../services/env";
import { providerNodeManifests } from "../providers/provider-node-manifests";
import { assembleModelCatalogV1, canonicalModelCatalogV1, fallbackProviderModelsForCatalogV1, modelOptionsForNodeV1, type RawProviderModelV1 } from "../services/model-catalog-v1";

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
    const canonicalModels = canonicalModelCatalogV1(models);
    return reply.send({ ok: true, modelCount: models.length, models, canonicalModelCount: canonicalModels.length, canonicalModels });
  }

  if (url.pathname === "/api/models/executable-generation") {
    const nodeTypes = providerNodeManifests()
      .filter((manifest) => manifest.enabled !== false && manifest.executor?.type === "builtin" && manifest.outputs.some((output) => output.type === "image" || output.type === "video"))
      .map((manifest) => manifest.id);
    const catalog = await loadLiveModelCatalogV1();
    const groups = nodeTypes.map((nodeType) => modelOptionsForNodeV1(nodeType, catalog));
    const models = executableGenerationModelsV1(groups.flat());
    reply.header("Cache-Control", "no-store");
    return reply.send({ ok: true, nodeTypes, modelCount: models.length, models });
  }

  const nodeType = nodeTypeFromForNodePath(url.pathname);
  if (nodeType) {
    // Node-compatible endpoint: executor-safe selectable models for a specific nodeType.
    // Provider-native selectors must use storedModelId, not the unified catalog id.
    const models = modelOptionsForNodeV1(nodeType, await loadLiveModelCatalogV1(nodeType));
    return reply.send({ ok: true, nodeType, modelCount: models.length, models });
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

export function executableGenerationModelsV1(models: ModelOptionForNodeV1[]): ModelOptionForNodeV1[] {
  const physicalRoutes = models.flatMap((model) => model.providerRoutes?.length
    ? model.providerRoutes.map((route) => executableProviderRouteModel(model, route))
    : [model]
  ).filter((model) => model.availability.status === "available" && model.availability.configured !== false);
  const deduped = new Map<string, ModelOptionForNodeV1>();
  for (const model of physicalRoutes) {
    const key = [model.provider, model.providerModelId, [...model.outputTypes].sort().join(",")]
      .map((value) => String(value).toLowerCase())
      .join("\u0000");
    const existing = deduped.get(key);
    if (!existing || isProviderNeutralNode(model.nodeType) && !isProviderNeutralNode(existing.nodeType)) {
      deduped.set(key, model);
    }
  }
  return [...deduped.values()];
}

function executableProviderRouteModel(model: ModelOptionForNodeV1, route: ModelProviderRouteV1): ModelOptionForNodeV1 {
  const inputContract = route.ioContract ?? model.ioContract ?? model.inputContract;
  const image = inputContract?.inputs?.find((item) => item.kind === "image");
  const requiredImageInputs = itemMinimum(image);
  const inputRoles = [...new Set([
    ...(image?.roles ?? []),
    ...(image?.slots ?? []).map((slot) => slot.role)
  ])];
  return {
    ...model,
    id: `${model.nodeType}:${model.canonicalModelId ?? model.id}:${route.provider}:${route.providerModelId}`,
    canonicalModelId: model.canonicalModelId ?? model.id,
    provider: route.provider,
    providerModelId: route.providerModelId,
    storedModelId: route.storedModelId,
    executionProvider: route.provider,
    providerRoutes: [route],
    availability: route.availability,
    inputTypes: route.inputTypes,
    outputTypes: route.outputTypes,
    capabilities: route.capabilities,
    roles: rolesForCapabilities(route.capabilities),
    parameters: route.parameters,
    pricing: route.pricing,
    ioContract: inputContract,
    inputContract,
    requiredImageInputs,
    maximumImageInputs: image?.maxItems,
    optionalImageInputs: image ? image.maxItems === undefined ? undefined : Math.max(0, image.maxItems - requiredImageInputs) : 0,
    inputRoles,
    runnableWithSuppliedInputs: (inputContract?.inputs ?? []).every((item) =>
      !["image", "video", "audio"].includes(item.kind) || itemMinimum(item) === 0
    ),
    metadata: {
      ...(model.metadata ?? {}),
      ...(route.metadata ?? {}),
      ...(route.constraints ? { providerConstraints: route.constraints } : {})
    }
  };
}

function rolesForCapabilities(capabilities: ModelOptionForNodeV1["capabilities"]): ModelRoleV1[] {
  const roles: ModelRoleV1[] = [];
  if (capabilities.some((capability) => capability.endsWith(".generate"))) roles.push("generator");
  if (capabilities.includes("image.edit")) roles.push("editor");
  if (capabilities.includes("image.upscale") || capabilities.includes("video.upscale")) roles.push("upscaler");
  return roles;
}

function itemMinimum(item: { minItems?: number; required?: boolean } | undefined): number {
  return item?.minItems ?? (item?.required ? 1 : 0);
}

function isProviderNeutralNode(nodeType: string): boolean {
  return nodeType === "ai.image.generate" || nodeType === "ai.video.generate";
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
  const localUpscaleModels = nodeType === undefined || nodeType === "local_upscale"
    ? await loadLocalUpscaleModelsForCatalogV1().catch(() => [])
    : [];
  const localVideoUpscaleModels = nodeType === undefined || nodeType === "local_video_upscale"
    ? await loadLocalVideoUpscaleModelsForCatalogV1().catch(() => [])
    : [];
  const kieModels = nodeType === undefined || nodeType === "ai.text" || nodeType === "ai.image.generate" || nodeType === "ai.video.generate"
    ? documentedKieModelsForCatalogV1()
    : [];
  return assembleModelCatalogV1({
    openRouterModels,
    polzaModels,
    localUpscaleModels,
    localVideoUpscaleModels,
    kieModels,
    rutronixModels: nodeType === undefined || nodeType === "ai.text" ? documentedRuTronixModels() : [],
    fallbackModels: fallbackProviderModelsForCatalogV1()
  });
}

function documentedKieModelsForCatalogV1(): RawProviderModelV1[] {
  return listDocumentedKieModels().map((model) => ({
    id: model.id,
    title: model.title,
    canonicalModelId: model.canonicalModelId,
    inputTypes: model.inputTypes,
    outputTypes: model.outputTypes,
    capabilities: model.capabilities,
    availability: { status: "available", source: "curated", configured: Boolean(process.env.KIE_API_KEY?.trim()) },
    providerConstraints: model.constraints,
    top_provider: { parameters: Object.fromEntries(model.parameters.map((parameter) => [String(parameter.id), parameterDefinitionToProviderSchema(parameter)])) }
  }));
}

function parameterDefinitionToProviderSchema(parameter: Record<string, unknown>): Record<string, unknown> {
  return {
    type: parameter.type === "select" ? "string" : parameter.type,
    default: parameter.default,
    enum: Array.isArray(parameter.options) ? parameter.options.map((option) => typeof option === "object" && option ? String((option as Record<string, unknown>).value) : String(option)) : undefined,
    min: parameter.min,
    max: parameter.max,
    step: parameter.step,
    required: parameter.required
  };
}

async function loadLocalUpscaleModelsForCatalogV1(): Promise<RawProviderModelV1[]> {
  const client = createLocalUpscaleWorkerClient();
  if (!client.configured) return [];
  const capabilities = await withTimeout(client.capabilities(), modelCatalogRequestTimeoutMs());
  return capabilities.models.map((model) => ({
    id: model.id,
    name: model.display_name,
    type: "image",
    inputTypes: ["image"],
    outputTypes: ["image"],
    capabilities: ["image.upscale"],
    availability: model.weights_installed
      ? { status: "available", source: "live", configured: true }
      : { status: "unavailable", source: "live", configured: true, reason: "Model weights are not installed in the local worker." },
    top_provider: {
      parameters: {
        image: { type: "string", required: true, min: 1, max: 1, description: "Source image" },
        scale: { type: "integer", default: model.scale_factor, enum: [model.scale_factor], required: true },
        tile_size: { type: "integer", default: model.recommended_tile_size, min: 64, max: 2048, step: 16 },
        tile_overlap: { type: "integer", default: 32, min: 0, max: 256, step: 1 },
        device: { type: "string", default: "auto", enum: ["auto", "cuda", "cpu"] }
      }
    },
    metadata: model
  }));
}

async function loadLocalVideoUpscaleModelsForCatalogV1(): Promise<RawProviderModelV1[]> {
  const client = createLocalVideoUpscaleWorkerClient();
  if (!client.configured) return [];
  const capabilities = await withTimeout(client.capabilities(), modelCatalogRequestTimeoutMs());
  return capabilities.models.map((model) => ({
    id: model.id,
    name: model.display_name,
    type: "video",
    inputTypes: ["video"],
    outputTypes: ["video"],
    capabilities: ["video.upscale"],
    availability: model.weights_installed
      ? { status: "available", source: "live", configured: true }
      : { status: "unavailable", source: "live", configured: true, reason: "Model weights are not installed in the local worker." },
    top_provider: {
      parameters: {
        video: { type: "string", required: true, min: 1, max: 1, description: "Source video" },
        scale: { type: "integer", default: model.native_scale, enum: [model.native_scale], required: true },
        device: { type: "string", default: "auto", enum: ["auto", "cuda", "cpu"] },
        output_codec: { type: "string", default: "libx264", enum: model.supported_output_codecs },
        output_container: { type: "string", default: "mp4", enum: model.supported_output_containers },
        crf: { type: "integer", default: 18, min: 0, max: 51 },
        chunk_size: { type: "integer", default: model.recommended_chunk_size, min: 1, max: 120 },
        overlap_frames: { type: "integer", default: model.temporal ? 2 : 0, min: 0, max: model.temporal ? 16 : 0 },
        audio_handling: { type: "string", default: "copy", enum: ["copy", "drop"] },
        ...(model.spatial_tiling_supported ? {
          tile_size: { type: "integer", default: model.recommended_tile_size ?? 256, min: 64, max: 2048, step: 16 },
          tile_overlap: { type: "integer", default: 32, min: 0, max: 256, step: 1 }
        } : {})
      }
    },
    metadata: model
  }));
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
