import { readFile } from "node:fs/promises";
import type { NodeRunner } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner, estimateGeminiPricingQuote, NANO_BANANA_2_DEFAULT_MODEL, readLocalGeminiPricingConfig, type GeminiLocalPricingConfig } from "@snarkroute/gemini";
import {
  createModelResolver,
  createOpenRouterImageNodeRunner,
  createOpenRouterTextNodeRunner,
  estimateOpenRouterPricingQuote,
  readOpenRouterModelCatalogCache,
  resolutionMetadata,
  type ModelMapping,
  type OpenRouterModelInfo,
  type ProviderMode
} from "@snarkroute/openrouter";
import { estimatePolzaPricingQuote, POLZA_IMAGE_DEFAULT_MODEL, POLZA_TEXT_DEFAULT_MODEL, type PolzaModelInfo } from "@snarkroute/polza";

type PricingQuote = {
  logicalModel?: string;
  provider: string;
  providerModel: string;
  capability: string;
  estimatedCost: number | null;
  currency: string | null;
  pricingSource: string;
  confidence: "exact" | "estimated" | "low" | "unknown" | string;
  unit?: string;
  breakdown?: Record<string, unknown>;
  warnings?: string[];
};
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
      return catalogBackedRunner({ ...input, params: { ...input.params, model: modelId, providerMode, pricing: cachedModel.pricing } });
    }
    const resolution = modelResolver({ task: "image", modelId, providerMode });
    if (resolution.provider === "openrouter") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      const model = cachedCatalog?.models.find((entry) => entry.id === resolution.model);
      return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode, pricing: model?.pricing } });
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

export type ModelGatewayQuotePreview = {
  selected: PricingQuote;
  alternatives: PricingQuote[];
  warnings: string[];
};

export async function quoteModelExecutingNode(options: {
  nodeType: string;
  params?: Record<string, unknown>;
  modelResolver: ReturnType<typeof createModelResolver>;
  polzaModels?: PolzaModelInfo[];
  geminiPricingConfig?: GeminiLocalPricingConfig;
}): Promise<ModelGatewayQuotePreview> {
  const params = options.params ?? {};
  const geminiPricingConfig = options.geminiPricingConfig ?? await readLocalGeminiPricingConfig();
  const openRouterCatalog = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  const warnings: string[] = [];

  if (options.nodeType === "ai.image.generate") {
    const providerMode = providerModeParam(params.providerMode);
    const modelId = stringValue(params.model) || "image.nano-banana";
    const cachedModel = openRouterCatalog?.models.find((model) => model.id === modelId);
    if (cachedModel && !openRouterModelSupportsImage(cachedModel)) {
      warnings.push("Cached OpenRouter model does not advertise image output support.");
    }
    if (cachedModel && openRouterModelSupportsImage(cachedModel) && providerMode !== "direct") {
      const selected = openRouterQuote(modelId, cachedModel.id, "image.generate", params, cachedModel.pricing);
      return { selected, alternatives: directGeminiAlternative(modelId, params, geminiPricingConfig), warnings };
    }
    try {
      const resolution = options.modelResolver({ task: "image", modelId, providerMode });
      if (resolution.provider === "openrouter") {
        const model = openRouterCatalog?.models.find((entry) => entry.id === resolution.model);
        return { selected: openRouterQuote(modelId, resolution.model, "image.generate", params, model?.pricing), alternatives: directGeminiAlternative(modelId, params, geminiPricingConfig), warnings };
      }
      if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
        return { selected: geminiQuote(modelId, resolution.model, "image.generate", params, geminiPricingConfig), alternatives: openRouterAlternative(modelId, params, openRouterCatalog?.models), warnings };
      }
      warnings.push(resolution.reason ?? "No quoteable provider route was selected.");
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    return { selected: unknownSelected(modelId, "unknown", modelId, "image.generate", params, warnings[0]), alternatives: [], warnings };
  }

  if (options.nodeType === "ai.text") {
    const providerMode = providerModeParam(params.providerMode);
    const requestedModel = stringValue(params.model);
    const modelId = !requestedModel || requestedModel === "text.default" ? process.env.OPENROUTER_DEFAULT_MODEL || "text.default" : requestedModel;
    if (modelId.includes("/") && providerMode !== "direct") {
      const model = openRouterCatalog?.models.find((entry) => entry.id === modelId);
      return { selected: openRouterQuote(modelId, modelId, "text.generate", params, model?.pricing), alternatives: [], warnings };
    }
    try {
      const resolution = options.modelResolver({ task: "text", modelId, providerMode });
      if (resolution.provider === "openrouter") {
        const model = openRouterCatalog?.models.find((entry) => entry.id === resolution.model);
        return { selected: openRouterQuote(modelId, resolution.model, "text.generate", params, model?.pricing), alternatives: [], warnings };
      }
      if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
        return { selected: geminiQuote(modelId, resolution.model, "text.generate", params, geminiPricingConfig), alternatives: [], warnings };
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    return { selected: unknownSelected(modelId, "unknown", modelId, "text.generate", params, warnings[0]), alternatives: [], warnings };
  }

  if (options.nodeType === "gemini.nano-banana-2") {
    return { selected: geminiQuote("gemini.nano-banana-2", NANO_BANANA_2_DEFAULT_MODEL, "image.generate", params, geminiPricingConfig), alternatives: [], warnings };
  }

  if (options.nodeType === "polza.text" || options.nodeType === "polza.image.generate") {
    const capability = options.nodeType === "polza.text" ? "text.generate" : "image.generate";
    const defaultModel = options.nodeType === "polza.text" ? POLZA_TEXT_DEFAULT_MODEL : POLZA_IMAGE_DEFAULT_MODEL;
    const modelId = stringValue(params.model) ?? defaultModel;
    const catalogModel = options.polzaModels?.find((model) => model.id === modelId);
    // TODO: connect Polza as a logical Model Gateway route separately; explicit Polza nodes only are quoted here.
    return {
      selected: estimatePolzaPricingQuote({ logicalModel: options.nodeType, provider: "polza", providerModel: modelId, capability, params: { ...params, pricing: catalogModel?.pricing }, inputMetadata: {} }),
      alternatives: [],
      warnings: catalogModel?.pricing ? [] : ["No Polza catalog pricing is available for this model."]
    };
  }

  warnings.push(`Node type "${options.nodeType}" does not execute through Model Gateway pricing preview.`);
  return { selected: unknownSelected(options.nodeType, "unknown", options.nodeType, "unknown", params, warnings[0]), alternatives: [], warnings };
}

function openRouterQuote(logicalModel: string, providerModel: string, capability: string, params: Record<string, unknown>, pricing: unknown): PricingQuote {
  return estimateOpenRouterPricingQuote({ logicalModel, provider: "openrouter", providerModel, capability, params: { ...params, pricing }, inputMetadata: {} });
}

function geminiQuote(logicalModel: string, providerModel: string, capability: string, params: Record<string, unknown>, localPricingConfig: GeminiLocalPricingConfig): PricingQuote {
  return estimateGeminiPricingQuote({ logicalModel, provider: "gemini", providerModel, capability, params: { ...params, localPricingConfig }, inputMetadata: {} });
}

function directGeminiAlternative(modelId: string, params: Record<string, unknown>, config: GeminiLocalPricingConfig): PricingQuote[] {
  return modelId === "image.nano-banana" ? [geminiQuote(modelId, NANO_BANANA_2_DEFAULT_MODEL, "image.generate", params, config)] : [];
}

function openRouterAlternative(modelId: string, params: Record<string, unknown>, models: OpenRouterModelInfo[] | undefined): PricingQuote[] {
  const model = models?.find((entry) => entry.id === modelId && openRouterModelSupportsImage(entry));
  return model ? [openRouterQuote(modelId, model.id, "image.generate", params, model.pricing)] : [];
}

function unknownSelected(logicalModel: string, provider: string, providerModel: string, capability: string, params: Record<string, unknown>, warning?: string): PricingQuote {
  return {
    logicalModel,
    provider,
    providerModel,
    capability,
    estimatedCost: null,
    currency: null,
    pricingSource: "unknown",
    confidence: "unknown",
    unit: "unknown",
    warnings: warning ? [warning] : undefined,
    breakdown: { requestedParams: Object.keys(params).filter((key) => !/api[_-]?key|token|secret|password/i.test(key)) }
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
