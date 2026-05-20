import { readFile } from "node:fs/promises";
import type { NodeRunner } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import {
  createModelResolver,
  createOpenRouterImageNodeRunner,
  createOpenRouterTextNodeRunner,
  readOpenRouterModelCatalogCache,
  resolutionMetadata,
  type ModelMapping,
  type OpenRouterModelInfo,
  type ProviderMode
} from "@snarkroute/openrouter";
import { openRouterCatalogCachePath, openRouterMappingsPath } from "../server-paths";
import { isGeminiEnabled, isOpenRouterEnabled } from "../services/env";

export async function loadModelRouteMappings(): Promise<ModelMapping[]> {
  const parsed = JSON.parse(await readFile(openRouterMappingsPath, "utf8")) as { models?: unknown };
  return Array.isArray(parsed.models) ? parsed.models.filter((entry): entry is ModelMapping => Boolean(entry && typeof entry === "object" && typeof (entry as ModelMapping).id === "string")) : [];
}

export function createRemoteTextNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const openRouterRunner = createOpenRouterTextNodeRunner({ modelResolver });
  const rawOpenRouterRunner = createOpenRouterTextNodeRunner();
  const geminiRunner = createGeminiLlmNodeRunner();
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const requestedModel = stringValue(input.params.model);
    const modelId = !requestedModel || requestedModel === "text.default" ? process.env.OPENROUTER_DEFAULT_MODEL || "text.default" : requestedModel;
    if (modelId.includes("/") && providerMode !== "direct") return rawOpenRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    const resolution = modelResolver({ task: "text", modelId, providerMode });
    if (resolution.provider === "openrouter") return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      return geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
    }
    throw new Error(resolution.provider === "direct" ? "Direct provider is not configured." : "Local provider is not available.");
  };
}

export function createRemoteImageNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const geminiRunner = createNanoBanana2NodeRunner();
  const openRouterRunner = createOpenRouterImageNodeRunner({ modelResolver });
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const modelId = stringValue(input.params.model) || "image.nano-banana";
    const cachedCatalog = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
    const cachedModel = cachedCatalog?.models.find((model) => model.id === modelId);
    if (cachedModel && !openRouterModelSupportsImage(cachedModel)) throw new Error("This model is not available for image generation.");
    if (cachedModel && openRouterModelSupportsImage(cachedModel) && providerMode !== "direct") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      const catalogBackedRunner = createOpenRouterImageNodeRunner({
        modelResolver: createModelResolver([catalogImageModelMapping(cachedModel)])
      });
      return catalogBackedRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    const resolution = modelResolver({ task: "image", modelId, providerMode });
    if (resolution.provider === "openrouter") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      if (!isGeminiEnabled()) throw new Error("Direct API is selected, but direct provider credentials are missing.");
      const result = await geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
      const metadata = resolutionMetadata(resolution, {
        requestProvider: resolution.directProvider,
        requestModelSlug: resolution.model,
        estimatedCostStatus: "unknown"
      });
      return {
        ...result,
        output: result.output && typeof result.output === "object" ? { ...(result.output as Record<string, unknown>), metadata, ...metadata } : result.output,
        logs: [...(result.logs ?? []), `Resolved route: ${metadata.resolvedRoute}; fallback: ${metadata.fallbackUsed ? metadata.fallbackReason || "yes" : "no"}`],
        provenance: { ...(result.provenance ?? {}), ...metadata }
      };
    }
    throw new Error(resolution.provider === "direct" ? `Direct API route requires a provider mapping for ${modelId}, but none was found.` : "Local provider is not available.");
  };
}

function catalogImageModelMapping(model: OpenRouterModelInfo): ModelMapping {
  return {
    id: model.id,
    task: "image",
    label: model.name ? `${model.name} (${model.id})` : model.id,
    provider: model.id.split("/")[0] || "openrouter",
    capabilities: ["image-generation"],
    supportsImageGeneration: "supported",
    openrouterModel: model.id,
    directProvider: null,
    directModel: null,
    status: "supported",
    routeSupport: { openrouter: "supported", direct: "unknown" }
  };
}

function openRouterModelSupportsImage(model: OpenRouterModelInfo): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  const output = model.architecture?.output_modalities ?? [];
  const modality = model.architecture?.modality ?? "";
  return output.includes("image") || modalityOutputModalities(modality).includes("image");
}

function isOpenRouterRoutingAlias(modelId: string): boolean {
  return modelId === "openrouter/auto";
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function providerModeParam(value: unknown): ProviderMode {
  return value === "openrouter" || value === "direct" || value === "local" ? value : "auto";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
