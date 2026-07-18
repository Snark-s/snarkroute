import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { estimateCatalogPricingQuote, estimatePricingCatalogQuote, isPricingCatalogFresh, ModelGateway, type ModelInfo, type ModelInvokeResult, type ModelPricingInput, type PricingCatalog, type PricingQuote, type PricingSourceAdapter, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";
import {
  createModelResolver,
  resolutionMetadata,
  resolveModelProvider,
  type ModelMapping,
  type ModelResolver,
  type ProviderMode,
  type ResolvedModelBase,
  type ResolvedModelProvider,
  type SupportStatus
} from "@snarkroute/model-registry";

export {
  createModelResolver,
  resolutionMetadata,
  resolveModelProvider,
  type ModelMapping,
  type ModelResolver,
  type ProviderMode,
  type ResolvedModelBase,
  type ResolvedModelProvider,
  type SupportStatus
} from "@snarkroute/model-registry";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MISSING_KEY_MESSAGE = "OpenRouter API key is missing.";
const LOCAL_FILE_DATA_URI_LIMIT_BYTES = 10 * 1024 * 1024;

export interface OpenRouterClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
  retryDelayMs?: number;
  modelGateway?: Pick<ModelGateway, "invoke">;
}

export interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenRouterContentPart[];
}

export type OpenRouterContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OpenRouterModelInfo {
  id: string;
  provider?: "openrouter";
  kind?: "text" | "image" | "video";
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  supported_durations?: string[];
  supported_aspect_ratios?: string[];
  supported_resolutions?: string[];
  supported_frame_image_modes?: string[];
  context_length?: number;
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  top_provider?: Record<string, unknown>;
}

export interface OpenRouterCatalogCache {
  refreshedAt: string;
  models: OpenRouterModelInfo[];
  sourceCounts?: {
    models: number;
    videoModels: number;
  };
}

export const OPENROUTER_PRICING_CATALOG_SOURCE = "openrouter_models_catalog";
const PRICING_TTL_HOURS = 12;

export function openRouterModelInfoToModelInfo(model: OpenRouterModelInfo): ModelInfo {
  const inputTypes = withOptionalImageInput(
    normalizedModalities(model.architecture?.input_modalities, ["text"]),
    openRouterModelAcceptsImageInput(model)
  );
  const outputTypes = normalizedModalities(model.architecture?.output_modalities, openRouterDefaultOutputs(model));
  const capabilities = openRouterModelCapabilities(model, outputTypes);
  const metadata: Record<string, unknown> = {
    source: "openrouter_models_catalog",
    providerModelKind: model.kind,
    description: model.description,
    pricing: model.pricing,
    supportedParameters: model.supported_parameters,
    supportedAspectRatios: model.supported_aspect_ratios,
    supportedDurations: model.supported_durations,
    supportedResolutions: model.supported_resolutions,
    supportedFrameImageModes: model.supported_frame_image_modes,
    topProvider: model.top_provider,
    generationParameters: generationParameterDefinitions({
      aspectRatios: model.supported_aspect_ratios,
      durations: model.supported_durations,
      resolutions: model.supported_resolutions
    })
  };
  return {
    id: model.id,
    providerId: "openrouter",
    title: model.name ?? model.id,
    capabilities,
    inputTypes,
    outputTypes,
    contextWindow: model.context_length,
    supportsImages: inputTypes.includes("image"),
    supportsVideo: inputTypes.includes("video") || outputTypes.includes("video"),
    supportsJson: Boolean(model.supported_parameters?.includes("response_format")),
    ioContract: {
      inputs: inputTypes.map((kind) => ({ kind: kind as "text" | "image" | "video" | "audio" | "file" | "json", minItems: 0, maxItems: kind === "image" ? undefined : 1 })),
      outputs: outputTypes.map((kind) => ({ kind: kind as "text" | "image" | "video" | "audio" | "file" | "json", minItems: 0, maxItems: 1 }))
    },
    defaultParameters: defaultGenerationParameters({
      aspectRatios: model.supported_aspect_ratios,
      durations: model.supported_durations,
      resolutions: model.supported_resolutions
    }),
    pricingHint: pricingHint(model.pricing),
    metadata: compactRecord(metadata)
  };
}

export function createOpenRouterClient(options: OpenRouterClientOptions = {}) {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL);
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function request(path: string, init: RequestInit = {}, keyRequired = true): Promise<unknown> {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (keyRequired && !apiKey?.trim()) throw new Error(OPENROUTER_MISSING_KEY_MESSAGE);
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (apiKey?.trim()) headers.set("Authorization", `Bearer ${apiKey.trim()}`);
    const referer = options.referer ?? process.env.SNARKROUTE_SITE_URL;
    if (referer) headers.set("HTTP-Referer", referer);
    const title = options.title ?? process.env.OPENROUTER_APP_TITLE ?? "SnarkRoute";
    if (title) headers.set("X-OpenRouter-Title", title);
    let response: Response;
    const method = init.method?.toUpperCase() ?? "GET";
    const maxAttempts = method === "GET" ? 2 : 1;
    try {
      response = await fetchWithNetworkRetry(fetcher, `${baseUrl}${path}`, { ...init, headers }, maxAttempts, retryDelayMs);
    } catch (error) {
      throw new Error(openRouterNetworkError(error, baseUrl));
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(openRouterHttpError(response.status, body));
    }
    return response.json();
  }

  return {
    async testConnection(): Promise<{ ok: true; modelCount: number }> {
      const catalog = parseOpenRouterModelCatalog(await request("/models", { method: "GET" }, true));
      return { ok: true, modelCount: catalog.length };
    },

    async getModels(keyRequired = false): Promise<OpenRouterModelInfo[]> {
      return parseOpenRouterModelCatalog(await request("/models", { method: "GET" }, keyRequired), "text");
    },

    async getVideoModels(keyRequired = false): Promise<OpenRouterModelInfo[]> {
      return parseOpenRouterModelCatalog(await request("/videos/models", { method: "GET" }, keyRequired), "video");
    },

    async chatCompletions(body: Record<string, unknown>): Promise<unknown> {
      return request("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body)
      }, true);
    }
  };
}

export function createOpenRouterTextNodeRunner(options: OpenRouterClientOptions & { modelResolver?: ModelResolver } = {}): NodeRunner {
  return async ({ node, params, inputs }) => {
    const resolution = options.modelResolver?.({ task: "text", modelId: stringParam(params.model) ?? "text.default", providerMode: providerModeParam(params.providerMode) }) ?? {
      provider: "openrouter" as const,
      model: stringParam(params.model) ?? "openai/gpt-5.2",
      reason: "openrouter direct model id",
      warnings: [],
      selectedModelId: stringParam(params.model) ?? "openai/gpt-5.2",
      selectedModelLabel: stringParam(params.model) ?? "openai/gpt-5.2",
      selectedConnectionRoute: providerModeParam(params.providerMode),
      resolvedProvider: "OpenRouter",
      resolvedRoute: "openrouter" as const,
      supportsImageGeneration: "unknown" as const,
      localMappingRequired: false,
      fallbackUsed: false
    };
    if (resolution.provider !== "openrouter") throw new Error(resolution.reason || "Model is not available through OpenRouter.");
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Text AI requires a prompt.");
    const systemPrompt = firstInputText(inputs.systemPrompt) ?? stringParam(params.systemPrompt);
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    const gateway = options.modelGateway ?? createOpenRouterModelGateway(options, resolution.model, "text.generate");
    const gatewayResult = await gateway.invoke({
      capability: "text.generate",
      modelRef: `model://openrouter/${resolution.model}`,
      input: { prompt, images, systemPrompt },
      parameters: params,
      metadata: { nodeId: node.id, nodeType: node.type, warnings: resolution.warnings }
    });
    const response = gatewayResult.output.output;
    const text = typeof gatewayResult.output.text === "string" ? gatewayResult.output.text : firstOpenRouterText(response);
    if (!text) throw new Error(`OpenRouter model "${resolution.model}" did not return text.`);
    const usage = response && typeof response === "object" ? (response as Record<string, unknown>).usage : gatewayResult.usage;
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimateOpenRouterPricingQuote({
      logicalModel: stringParam(params.model),
      provider: "openrouter",
      providerModel: resolution.model,
      capability: "text.generate",
      params,
      inputMetadata: {}
    });
    const estimatedCost = numberOrNull(gatewayResult.output.estimatedCost) ?? estimateTextCostFromPricing(params.pricing, usage) ?? pricingQuote.estimatedCost;
    return {
      output: {
        text,
        output: response,
        provider: "openrouter",
        logicalModel: stringParam(params.model),
        model: resolution.model,
        providerModel: resolution.model,
        warnings: resolution.warnings,
        estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        actualCostCurrency: null,
        pricingSource: estimatedCost === null ? "unknown" : "openrouter_catalog",
        pricingQuote,
        status: "succeeded"
      },
      logs: [`Generated text with OpenRouter ${resolution.model}`],
      provenance: { provider: "openrouter", model: resolution.model, reason: resolution.reason, warnings: resolution.warnings },
      providerUsage: openRouterUsageEvent(node.id, node.type, resolution.model, "succeeded", usage, { ...pricingQuote, estimatedCost }, stringParam(params.model))
    };
  };
}

export function createOpenRouterImageNodeRunner(options: OpenRouterClientOptions & { modelResolver?: ModelResolver } = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const selectedModelId = stringParam(params.model) ?? "image.nano-banana";
    const selectedConnectionRoute = providerModeParam(params.providerMode);
    const resolution = options.modelResolver?.({ task: "image", modelId: selectedModelId, providerMode: selectedConnectionRoute }) ?? {
      provider: "openrouter" as const,
      model: selectedModelId,
      reason: "OpenRouter direct model id.",
      warnings: [],
      selectedModelId,
      selectedModelLabel: selectedModelId,
      selectedConnectionRoute,
      resolvedProvider: "OpenRouter",
      resolvedRoute: "openrouter",
      supportsImageGeneration: "unknown" as const,
      localMappingRequired: false,
      fallbackUsed: false
    };
    if (resolution.provider !== "openrouter") throw new Error(resolution.reason || "This model is listed in the UI but has no executable image route.");
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Image Generation requires a prompt.");
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    const gateway = options.modelGateway ?? createOpenRouterModelGateway(options, resolution.model, "image.generate");
    const gatewayResult = await gateway.invoke({
      capability: "image.generate",
      modelRef: `model://openrouter/${resolution.model}`,
      input: { prompt, images },
      parameters: params,
      metadata: { outputDirectory: context.outputDirectory, sourceNodeId: node.id, nodeId: node.id, nodeType: node.type, warnings: resolution.warnings }
    });
    const response = gatewayResult.output.output;
    const imageAsset = openRouterImageAssetFromGateway(gatewayResult);
    if (!imageAsset) throw new Error(`OpenRouter model "${resolution.model}" did not return an image.`);
    const usage = response && typeof response === "object" ? (response as Record<string, unknown>).usage : gatewayResult.usage;
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimateOpenRouterPricingQuote({
      logicalModel: selectedModelId,
      provider: "openrouter",
      providerModel: resolution.model,
      capability: "image.generate",
      params,
      inputMetadata: {}
    });
    const estimatedCost = numberOrNull(gatewayResult.output.estimatedCost) ?? estimateImageCostFromPricing(params.pricing) ?? pricingQuote.estimatedCost;
    const metadata = resolutionMetadata(resolution, {
      requestProvider: "openrouter",
      requestModelSlug: resolution.model,
      estimatedCostStatus: estimatedCost === null ? "unknown" : "available"
    });
    return {
      output: {
        image: imageAsset,
        output: response,
        metadata,
        ...metadata,
        logicalModel: selectedModelId,
        provider: "openrouter",
        model: resolution.model,
        providerModel: resolution.model,
        estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        actualCostCurrency: null,
        pricingSource: estimatedCost === null ? "unknown" : "openrouter_catalog",
        pricingQuote,
        inputImageCount: images.length,
        localPath: imageAsset.localPath,
        status: "succeeded"
      },
      logs: [
        `Generated image with OpenRouter ${resolution.model} at ${imageAsset.localPath}`,
        `Resolved route: ${metadata.resolvedRoute}; fallback: ${metadata.fallbackUsed ? metadata.fallbackReason || "yes" : "no"}`
      ],
      provenance: metadata,
      providerUsage: openRouterUsageEvent(node.id, node.type, resolution.model, "succeeded", usage, { ...pricingQuote, estimatedCost }, selectedModelId)
    };
  };
}

export function createOpenRouterProviderAdapter(options: OpenRouterClientOptions = {}): ProviderAdapter {
  const client = createOpenRouterClient(options);
  return {
    id: "openrouter",
    title: "OpenRouter",
    capabilities: ["text.generate", "image.generate"],
    pricingResolver: {
      estimate: estimateOpenRouterPricingQuote
    },
    async invoke(request) {
      const prompt = stringParam(request.input.prompt) ?? "";
      const images = collectInputImages(request.input.images ?? request.input.image);
      const imageUrls = await Promise.all(images.map((image) => prepareImageUrl(image, options.fetchImpl)));
      if (request.capability === "text.generate") {
        const userContent: string | OpenRouterContentPart[] = imageUrls.length > 0
          ? [
              { type: "text", text: prompt },
              ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))
            ]
          : prompt;
        const systemPrompt = stringParam(request.input.systemPrompt);
        const messages: OpenRouterChatMessage[] = [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user", content: userContent }
        ];
        const response = await client.chatCompletions(buildChatRequestBody(request.model.id, messages, request.parameters ?? {}));
        const usage = response && typeof response === "object" ? (response as Record<string, unknown>).usage : undefined;
        return {
          modelId: request.model.id,
          providerId: "openrouter",
          capability: request.capability,
          output: {
            text: firstOpenRouterText(response),
            output: response,
            model: request.model.id,
            estimatedCost: estimateTextCostFromPricing(request.parameters?.pricing, usage),
            pricingQuote: estimateOpenRouterPricingQuote({
              logicalModel: stringParam(request.metadata?.logicalModel),
              provider: "openrouter",
              providerModel: request.model.id,
              capability: request.capability,
              params: request.parameters ?? {},
              inputMetadata: request.metadata
            })
          },
          usage: usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined,
          raw: response,
          warnings: stringArrayFromUnknown(request.metadata?.warnings)
        };
      }
      if (request.capability === "image.generate") {
        const response = await client.chatCompletions(buildImageRequestBody(request.model.id, prompt, request.parameters ?? {}, imageUrls));
        const image = firstOpenRouterImage(response);
        if (!image) throw new Error(`OpenRouter model "${request.model.id}" did not return an image.`);
        const imageAsset = await writeOpenRouterImage(image, {
          outputDirectory: stringParam(request.metadata?.outputDirectory) ?? process.cwd(),
          sourceNodeId: stringParam(request.metadata?.sourceNodeId) ?? "openrouter",
          model: request.model.id,
          fetchImpl: options.fetchImpl
        });
        const usage = response && typeof response === "object" ? (response as Record<string, unknown>).usage : undefined;
        return {
          modelId: request.model.id,
          providerId: "openrouter",
          capability: request.capability,
          output: {
            image: imageAsset,
            output: response,
            model: request.model.id,
            estimatedCost: estimateImageCostFromPricing(request.parameters?.pricing),
            pricingQuote: estimateOpenRouterPricingQuote({
              logicalModel: stringParam(request.metadata?.logicalModel),
              provider: "openrouter",
              providerModel: request.model.id,
              capability: request.capability,
              params: request.parameters ?? {},
              inputMetadata: request.metadata
            })
          },
          usage: usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined,
          raw: response,
          warnings: stringArrayFromUnknown(request.metadata?.warnings)
        };
      }
      throw new Error(`OpenRouter adapter does not support capability "${request.capability}".`);
    }
  };
}

export function estimateOpenRouterPricingQuote(input: ModelPricingInput): PricingQuote {
  return estimateCatalogPricingQuote(input, input.params.pricing, "openrouter_catalog");
}

function createOpenRouterModelGateway(options: OpenRouterClientOptions, model: string, capability: "text.generate" | "image.generate"): ModelGateway {
  return new ModelGateway({
    models: [{
      id: model,
      providerId: "openrouter",
      title: model,
      capabilities: [capability],
      pricingHint: "openrouter_catalog"
    }],
    adapters: [createOpenRouterProviderAdapter(options)],
    connections: [{
      providerId: "openrouter",
      enabled: true,
      credentialRef: "provider.openrouter.default",
      baseUrl: options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL
    }]
  });
}

function openRouterImageAssetFromGateway(result: ModelInvokeResult): { localPath?: string; path?: string; filename?: string; mimeType?: string; sourceNodeId?: string; model?: string } | undefined {
  const image = result.output.image;
  return image && typeof image === "object" ? image : undefined;
}

export function buildChatRequestBody(model: string, messages: OpenRouterChatMessage[], params: Record<string, unknown>): Record<string, unknown> {
  const supported = Array.isArray(params.supported_parameters) ? params.supported_parameters.filter((item): item is string => typeof item === "string") : null;
  const allowed = supported ? new Set(supported) : new Set(["temperature", "max_tokens", "top_p", "stream"]);
  const body: Record<string, unknown> = { model, messages };
  for (const key of ["temperature", "max_tokens", "top_p", "stream"] as const) {
    if (params[key] !== undefined && allowed.has(key)) body[key] = params[key];
  }
  return body;
}

export function buildImageRequestBody(model: string, prompt: string, params: Record<string, unknown>, imageUrls: string[] = []): Record<string, unknown> {
  const content: string | OpenRouterContentPart[] = imageUrls.length > 0
    ? [
        { type: "text", text: prompt },
        ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))
      ]
    : prompt;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content }],
    modalities: ["image", "text"]
  };
  if (isOpenAiImageModel(model)) {
    const aspectRatio = typeof params.aspectRatio === "string" && params.aspectRatio.trim() ? params.aspectRatio.trim() : "1:1";
    body.image_config = { aspect_ratio: aspectRatio };
    const quality = openAiImageQuality(params.imageSize);
    if (quality) body.quality = quality;
    return body;
  }
  const imageConfig: Record<string, unknown> = {};
  if (params.aspectRatio !== undefined) imageConfig.aspect_ratio = params.aspectRatio;
  if (params.imageSize !== undefined) imageConfig.image_size = params.imageSize;
  if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;
  return body;
}

function isOpenAiImageModel(model: string): boolean {
  return model.startsWith("openai/") && /image/i.test(model);
}

function openAiImageQuality(imageSize: unknown): string | null {
  if (typeof imageSize !== "string") return null;
  if (["low", "medium", "high", "auto"].includes(imageSize)) return imageSize;
  if (imageSize === "1K") return "low";
  if (imageSize === "2K") return "medium";
  if (imageSize === "4K") return "high";
  return null;
}

export async function refreshOpenRouterModelCatalog(options: OpenRouterClientOptions & { cachePath?: string } = {}): Promise<OpenRouterCatalogCache> {
  const client = createOpenRouterClient(options);
  const [textModels, videoModels] = await Promise.all([
    client.getModels(false),
    client.getVideoModels(false)
  ]);
  debugOpenRouterCatalogRefresh(textModels, videoModels);
  const cache = {
    refreshedAt: new Date().toISOString(),
    models: [...textModels, ...videoModels],
    sourceCounts: { models: textModels.length, videoModels: videoModels.length }
  };
  const cachePath = options.cachePath ?? join(process.cwd(), "data", "cache", "openrouter-models.json");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache;
}

export async function refreshOpenRouterPricingCatalog(options: OpenRouterClientOptions & { cachePath?: string; modelCatalogCachePath?: string; ttlHours?: number } = {}): Promise<PricingCatalog> {
  const client = createOpenRouterClient(options);
  const [textModels, videoModels] = await Promise.all([
    client.getModels(false),
    client.getVideoModels(false).catch(() => [])
  ]);
  const models = [...textModels, ...videoModels];
  const modelCatalogCachePath = options.modelCatalogCachePath;
  if (modelCatalogCachePath) {
    await writeOpenRouterModelCatalogCache({ refreshedAt: new Date().toISOString(), models, sourceCounts: { models: textModels.length, videoModels: videoModels.length } }, modelCatalogCachePath);
  }
  const catalog = openRouterPricingCatalogFromModels(models, options.ttlHours);
  const cachePath = options.cachePath ?? join(process.cwd(), "data", "cache", "model-pricing", "openrouter.json");
  await writePricingCatalog(cachePath, catalog);
  return catalog;
}

export async function refreshOpenRouterPricingCatalogFromModelCache(options: { cachePath?: string; modelCatalogCachePath?: string; ttlHours?: number } = {}): Promise<PricingCatalog | null> {
  const modelCache = await readOpenRouterModelCatalogCache(options.modelCatalogCachePath);
  if (!modelCache) return null;
  const catalog = openRouterPricingCatalogFromModels(modelCache.models, options.ttlHours, modelCache.refreshedAt);
  await writePricingCatalog(options.cachePath ?? join(process.cwd(), "data", "cache", "model-pricing", "openrouter.json"), catalog);
  return catalog;
}

export async function readOpenRouterPricingCatalogCache(cachePath = join(process.cwd(), "data", "cache", "model-pricing", "openrouter.json")): Promise<PricingCatalog | null> {
  return readPricingCatalog(cachePath, "openrouter");
}

export function createOpenRouterPricingSourceAdapter(options: OpenRouterClientOptions & { cachePath?: string; modelCatalogCachePath?: string; ttlHours?: number } = {}): PricingSourceAdapter {
  return {
    provider: "openrouter",
    refreshPricing: () => refreshOpenRouterPricingCatalog(options),
    readCachedPricing: () => readOpenRouterPricingCatalogCache(options.cachePath),
    isCatalogFresh: isPricingCatalogFresh,
    estimateFromCatalog: estimateOpenRouterPricingQuoteFromCatalog
  };
}

export function estimateOpenRouterPricingQuoteFromCatalog(input: ModelPricingInput, catalog: PricingCatalog): PricingQuote {
  return estimatePricingCatalogQuote(input, catalog, "OpenRouter pricing catalog is stale; using stale estimate");
}

export function openRouterPricingCatalogFromModels(models: OpenRouterModelInfo[], ttlHours = PRICING_TTL_HOURS, fetchedAt = new Date().toISOString()): PricingCatalog {
  const fetchedMs = Date.parse(fetchedAt);
  const baseMs = Number.isFinite(fetchedMs) ? fetchedMs : Date.now();
  const catalog: PricingCatalog = {
    provider: "openrouter",
    fetchedAt: new Date(baseMs).toISOString(),
    expiresAt: new Date(baseMs + ttlHours * 60 * 60 * 1000).toISOString(),
    source: OPENROUTER_PRICING_CATALOG_SOURCE,
    sourceUrl: null,
    models: {},
    warnings: []
  };
  for (const model of models) {
    if (!model.pricing || Object.keys(model.pricing).length === 0) continue;
    catalog.models[model.id] = {
      currency: typeof model.pricing.currency === "string" ? model.pricing.currency : "USD",
      pricing: { ...model.pricing },
      raw: { id: model.id, name: model.name, kind: model.kind, architecture: model.architecture }
    };
  }
  return catalog;
}

export async function readOpenRouterModelCatalogCache(cachePath = join(process.cwd(), "data", "cache", "openrouter-models.json")): Promise<OpenRouterCatalogCache | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      refreshedAt: typeof record.refreshedAt === "string" ? record.refreshedAt : "",
      models: Array.isArray(record.models) ? record.models.map((model) => parseOpenRouterModel(model)).filter((model): model is OpenRouterModelInfo => Boolean(model)) : [],
      sourceCounts: record.sourceCounts && typeof record.sourceCounts === "object"
        ? {
            models: optionalNumber((record.sourceCounts as Record<string, unknown>).models) ?? 0,
            videoModels: optionalNumber((record.sourceCounts as Record<string, unknown>).videoModels) ?? 0
          }
        : undefined
    };
  } catch {
    return null;
  }
}

async function writeOpenRouterModelCatalogCache(cache: OpenRouterCatalogCache, cachePath: string): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function writePricingCatalog(cachePath: string, catalog: PricingCatalog): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

async function readPricingCatalog(cachePath: string, provider: string): Promise<PricingCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      provider,
      fetchedAt: optionalString(record.fetchedAt) ?? "",
      expiresAt: optionalString(record.expiresAt) ?? "",
      source: optionalString(record.source) ?? `${provider}_catalog`,
      sourceUrl: optionalString(record.sourceUrl) ?? null,
      models: record.models && typeof record.models === "object" ? record.models as PricingCatalog["models"] : {},
      warnings: stringArray(record.warnings) ?? []
    };
  } catch {
    return null;
  }
}

export function parseOpenRouterModelCatalog(input: unknown, kind?: OpenRouterModelInfo["kind"]): OpenRouterModelInfo[] {
  const data: unknown[] = input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).data)
    ? ((input as Record<string, unknown>).data as unknown[])
    : Array.isArray(input) ? input : [];
  return data.map((model) => parseOpenRouterModel(model, kind)).filter((model): model is OpenRouterModelInfo => Boolean(model));
}

function parseOpenRouterModel(input: unknown, kind?: OpenRouterModelInfo["kind"]): OpenRouterModelInfo | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture as Record<string, unknown> : {};
  const topProvider = record.top_provider && typeof record.top_provider === "object" ? record.top_provider as Record<string, unknown> : {};
  const recordKind = record.kind === "text" || record.kind === "image" || record.kind === "video" ? record.kind : undefined;
  const inferredKind = kind ?? recordKind ?? inferOpenRouterModelKind(record, architecture);
  return {
    id,
    provider: "openrouter",
    kind: inferredKind,
    name: optionalString(record.name),
    description: optionalString(record.description),
    architecture: {
      input_modalities: stringArray(architecture.input_modalities),
      output_modalities: inferredKind === "video" ? stringArray(architecture.output_modalities) ?? ["video"] : stringArray(architecture.output_modalities),
      modality: optionalString(architecture.modality)
    },
    supported_durations: stringArrayFromKeys([record, architecture, topProvider], ["supported_durations", "durations", "duration"]),
    supported_aspect_ratios: stringArrayFromKeys([record, architecture, topProvider], ["supported_aspect_ratios", "aspect_ratios", "aspect_ratio"]),
    supported_resolutions: stringArrayFromKeys([record, architecture, topProvider], ["supported_resolutions", "resolutions", "resolution"]),
    supported_frame_image_modes: stringArrayFromKeys([record, architecture, topProvider], ["supported_frame_image_modes", "frame_image_modes", "frame_image_mode"]),
    context_length: optionalNumber(record.context_length),
    pricing: record.pricing && typeof record.pricing === "object" ? record.pricing as Record<string, unknown> : undefined,
    supported_parameters: stringArray(record.supported_parameters),
    top_provider: Object.keys(topProvider).length > 0 ? topProvider : undefined
  };
}

function inferOpenRouterModelKind(record: Record<string, unknown>, architecture: Record<string, unknown>): OpenRouterModelInfo["kind"] {
  const output = stringArray(architecture.output_modalities) ?? [];
  const modality = optionalString(architecture.modality) ?? "";
  if (output.includes("video") || modalityOutputModalities(modality).includes("video")) return "video";
  if (output.includes("image") || modalityOutputModalities(modality).includes("image")) return "image";
  return "text";
}

function openRouterDefaultOutputs(model: OpenRouterModelInfo): string[] {
  const modalityOutputs = modalityOutputModalities(model.architecture?.modality ?? "");
  if (modalityOutputs.length) return modalityOutputs;
  if (model.kind === "image") return ["image"];
  if (model.kind === "video") return ["video"];
  return ["text"];
}

function openRouterModelCapabilities(model: OpenRouterModelInfo, outputTypes: string[]): ModelInfo["capabilities"] {
  const capabilities: ModelInfo["capabilities"] = [];
  if (model.kind === "text" || outputTypes.includes("text")) capabilities.push("text.generate");
  if (outputTypes.includes("image")) capabilities.push("image.generate");
  if (outputTypes.includes("video")) capabilities.push("video.generate");
  return [...new Set(capabilities.length ? capabilities : ["text.generate"])];
}

function openRouterModelAcceptsImageInput(model: OpenRouterModelInfo): boolean {
  const input = model.architecture?.input_modalities ?? [];
  if (input.some((modality) => modality.toLowerCase() === "image")) return true;
  if (model.supported_frame_image_modes?.length) return true;
  const text = `${model.id} ${model.name ?? ""} ${model.description ?? ""} ${model.architecture?.modality ?? ""}`.toLowerCase();
  return /\bimage[- ]to[- ]video\b|\bimage inputs?\b|\bimage references?\b|\bfirst frame\b|\blast frame\b/.test(text);
}

function withOptionalImageInput(inputTypes: string[], acceptsImageInput: boolean): string[] {
  return acceptsImageInput && !inputTypes.includes("image") ? [...inputTypes, "image"] : inputTypes;
}

function normalizedModalities(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = (values?.length ? values : fallback)
    .map((value) => value.toLowerCase())
    .filter((value) => value === "text" || value === "image" || value === "video" || value === "audio" || value === "file" || value === "json");
  return [...new Set(normalized.length ? normalized : fallback)];
}

function pricingHint(pricing: Record<string, unknown> | undefined): string | undefined {
  if (!pricing || Object.keys(pricing).length === 0) return undefined;
  const compact = Object.entries(pricing)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return compact.length ? compact.join(", ") : "pricing available";
}

function generationParameterDefinitions(options: { aspectRatios?: string[]; durations?: string[]; resolutions?: string[] }): Array<Record<string, unknown>> | undefined {
  const definitions = [
    selectDefinition("aspectRatio", "Aspect ratio", options.aspectRatios),
    selectDefinition("duration", "Duration", options.durations),
    selectDefinition("resolution", "Resolution", options.resolutions)
  ].filter((definition): definition is Record<string, unknown> => Boolean(definition));
  return definitions.length ? definitions : undefined;
}

function selectDefinition(id: string, label: string, values: string[] | undefined): Record<string, unknown> | undefined {
  if (!values?.length) return undefined;
  return { id, label, type: "select", default: values[0], options: values.map((value) => ({ value })) };
}

function defaultGenerationParameters(options: { aspectRatios?: string[]; durations?: string[]; resolutions?: string[] }): Record<string, unknown> | undefined {
  const defaults = compactRecord({
    aspectRatio: options.aspectRatios?.[0],
    duration: options.durations?.[0],
    resolution: options.resolutions?.[0]
  });
  return Object.keys(defaults).length ? defaults : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)));
}

function stringArrayFromKeys(sources: Array<Record<string, unknown>>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    for (const source of sources) {
      const array = stringOrNumberArray(source[key]) ?? stringArrayFromDelimited(source[key]);
      if (array?.length) return array;
      const nested = source[key] && typeof source[key] === "object" ? stringOrNumberArray(Object.values(source[key] as Record<string, unknown>)) : undefined;
      if (nested?.length) return nested;
    }
  }
  return undefined;
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function debugOpenRouterCatalogRefresh(textModels: OpenRouterModelInfo[], videoModels: OpenRouterModelInfo[]): void {
  const allKling = [...textModels, ...videoModels].filter((model) => /kling/i.test(`${model.id} ${model.name ?? ""}`));
  console.info(`[OpenRouter catalog] /api/v1/models: ${textModels.length} models`);
  console.info(`[OpenRouter catalog] /api/v1/videos/models: ${videoModels.length} models`);
  console.info(`[OpenRouter catalog] kling models: ${allKling.map((model) => `${model.id} kind=${model.kind ?? "unknown"} output=${model.architecture?.output_modalities?.join(",") ?? ""}`).join("; ") || "none"}`);
  for (const model of allKling) {
    const reasons = openRouterVideoFilterReasons(model);
    console.info(`[OpenRouter catalog] kling filter ${model.id}: ${reasons.length ? reasons.join("; ") : "included"}`);
  }
}

function openRouterVideoFilterReasons(model: OpenRouterModelInfo): string[] {
  const reasons: string[] = [];
  if (model.kind !== "video") reasons.push(`kind=${model.kind ?? "missing"}`);
  const output = model.architecture?.output_modalities ?? [];
  const modality = model.architecture?.modality ?? "";
  if (!output.includes("video") && !modalityOutputModalities(modality).includes("video")) reasons.push("no video output modality");
  if (isOpenRouterRoutingAlias(model.id)) reasons.push("routing alias");
  return reasons;
}

function isOpenRouterRoutingAlias(modelId: string): boolean {
  return modelId === "openrouter/auto";
}

function firstOpenRouterText(response: unknown): string {
  const choices = response && typeof response === "object" ? (response as Record<string, unknown>).choices : undefined;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as Record<string, unknown>).message;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  return typeof content === "string" ? content : "";
}

function firstOpenRouterImage(response: unknown): unknown {
  if (!response || typeof response !== "object") return null;
  const choices = (response as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const images = record.images;
  if (Array.isArray(images) && images.length > 0) {
    const image = images[0];
    if (typeof image === "string") return image;
    if (image && typeof image === "object") {
      const imageRecord = image as Record<string, unknown>;
      const url = imageRecord.image_url && typeof imageRecord.image_url === "object" ? (imageRecord.image_url as Record<string, unknown>).url : imageRecord.url;
      if (typeof url === "string") return url;
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      const imageUrl = partRecord.image_url && typeof partRecord.image_url === "object" ? (partRecord.image_url as Record<string, unknown>).url : undefined;
      if (typeof imageUrl === "string") return imageUrl;
    }
  }
  return null;
}

function firstInputImage(inputs: Record<string, unknown>): unknown {
  if ("image" in inputs) return inputs.image;
  for (const value of Object.values(inputs)) {
    if (value && typeof value === "object" && ("path" in value || "localPath" in value)) return value;
    if (value && typeof value === "object" && "image" in value) return (value as { image: unknown }).image;
  }
  return undefined;
}

function collectInputImages(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectInputImages);
  return [value];
}

async function prepareImageUrl(value: unknown, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return prepareImageUrl(record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.image, fetchImpl);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("OpenRouter image generation expected image input as a local path, image object, data URI, or remote URL.");
  }
  if (value.startsWith("data:")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  const bytes = await readFile(value);
  if (bytes.length > LOCAL_FILE_DATA_URI_LIMIT_BYTES) throw new Error(`OpenRouter local image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_DATA_URI_LIMIT_BYTES} bytes.`);
  return `data:${mimeTypeFromPath(value)};base64,${bytes.toString("base64")}`;
}

async function writeOpenRouterImage(
  image: unknown,
  options: { outputDirectory: string; sourceNodeId: string; model: string; fetchImpl?: typeof fetch }
) {
  if (image && typeof image === "object") {
    const record = image as Record<string, unknown>;
    return writeOpenRouterImage(record.localPath ?? record.path ?? record.image_url ?? record.url ?? record.image, options);
  }
  if (typeof image !== "string" || !image.trim()) {
    throw new Error("OpenRouter image response did not include a usable image URL or data URI.");
  }

  if (image.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(image);
    if (!match) throw new Error("OpenRouter image response returned an invalid data URI.");
    return writeGeneratedImage(Buffer.from(match[2], "base64"), match[1], options);
  }

  if (/^https?:\/\//i.test(image)) {
    const response = await (options.fetchImpl ?? fetch)(image);
    if (!response.ok) throw new Error(`Could not download OpenRouter image output (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? mimeTypeFromPath(new URL(image).pathname);
    return writeGeneratedImage(bytes, mimeType, options);
  }

  return {
    localPath: image,
    path: image,
    filename: basename(image),
    mimeType: mimeTypeFromPath(image),
    sourceNodeId: options.sourceNodeId,
    model: options.model
  };
}

async function writeGeneratedImage(bytes: Buffer, mimeType: string, options: { outputDirectory: string; sourceNodeId: string; model: string }) {
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(options.sourceNodeId)}-${Date.now()}${extensionFromMimeType(mimeType)}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);
  return {
    localPath,
    path: localPath,
    filename,
    mimeType,
    sizeBytes: bytes.length,
    sourceNodeId: options.sourceNodeId,
    model: options.model
  };
}

function firstInputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") return String((entry as Record<string, unknown>).text);
  }
  return undefined;
}

function sanitizeFilename(filename: string): string {
  return basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function mimeTypeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  return mimeTypes[ext] ?? "image/png";
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function openRouterUsageEvent(nodeId: string, nodeType: string, model: string, status: string, usage: unknown, pricingQuote: PricingQuote, logicalModel?: string): ProviderUsageEvent {
  return {
    provider: "openrouter",
    model,
    providerModel: model,
    logicalModel,
    nodeId,
    nodeType,
    status,
    metrics: usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined,
    estimatedCost: pricingQuote.estimatedCost,
    actualCost: actualCostFromUsage(usage),
    actualCostCurrency: null,
    pricingHint: pricingQuote.pricingSource,
    pricingSource: pricingQuote.pricingSource,
    pricingQuote
  };
}

function quoteFromGatewayOutput(output: Record<string, unknown>): PricingQuote | null {
  const quote = output.pricingQuote;
  return quote && typeof quote === "object" ? quote as PricingQuote : null;
}

function estimateTextCostFromPricing(pricing: unknown, usage: unknown): number | null {
  if (!pricing || typeof pricing !== "object" || !usage || typeof usage !== "object") return null;
  const pricingRecord = pricing as Record<string, unknown>;
  const usageRecord = usage as Record<string, unknown>;
  const promptTokens = optionalNumber(usageRecord.prompt_tokens) ?? 0;
  const completionTokens = optionalNumber(usageRecord.completion_tokens) ?? 0;
  const promptPrice = numberFromPricing(pricingRecord.prompt);
  const completionPrice = numberFromPricing(pricingRecord.completion);
  if (promptPrice === undefined && completionPrice === undefined) return null;
  return Number(((promptTokens * (promptPrice ?? 0)) + (completionTokens * (completionPrice ?? 0))).toFixed(8));
}

function estimateImageCostFromPricing(pricing: unknown): number | null {
  if (!pricing || typeof pricing !== "object") return null;
  const pricingRecord = pricing as Record<string, unknown>;
  return numberFromPricing(pricingRecord.image) ?? numberFromPricing(pricingRecord.request) ?? null;
}

function actualCostFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const cost = optionalNumber((usage as Record<string, unknown>).cost);
  return cost ?? null;
}

function numberFromPricing(value: unknown): number | undefined {
  const number = optionalNumber(value);
  return number === undefined ? undefined : number;
}

function openRouterHttpError(status: number, body: string): string {
  if (status === 401 || status === 403) return "OpenRouter API key seems invalid.";
  if (status === 404) return "Model is not available through OpenRouter.";
  const message = body ? ` ${truncate(body, 500)}` : "";
  return `OpenRouter request failed (${status}).${message}`;
}

function openRouterNetworkError(error: unknown, baseUrl: string): string {
  const message = errorMessage(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const causeMessage = cause?.message;
  const code = cause && "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
  const detail = [code, causeMessage, message].filter(Boolean).join(": ");
  return `OpenRouter is unreachable. The API key is configured, but SnarkRoute cannot reach ${baseUrl}. Check internet access, proxy/VPN/firewall settings, DNS, or OPENROUTER_BASE_URL. Details: ${detail || "network request failed"}`;
}

async function fetchWithNetworkRetry(fetcher: typeof fetch, url: string, init: RequestInit, maxAttempts: number, retryDelayMs: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetcher(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerModeParam(value: unknown): ProviderMode {
  return value === "openrouter" || value === "direct" || value === "local" ? value : "auto";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function stringOrNumberArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map((item) => String(item));
  return items.length ? items : undefined;
}

function stringArrayFromDelimited(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = value.split(/[,+\s/]+/).map((part) => part.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function numberOrNull(value: unknown): number | null {
  const number = optionalNumber(value);
  return number === undefined ? null : number;
}

function filterDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
