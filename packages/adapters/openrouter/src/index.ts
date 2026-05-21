import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { estimateCatalogPricingQuote, ModelGateway, type ModelInvokeResult, type ModelPricingInput, type PricingQuote, type ProviderAdapter } from "@snarkroute/core";
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
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  context_length?: number;
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  top_provider?: Record<string, unknown>;
}

export interface OpenRouterCatalogCache {
  refreshedAt: string;
  models: OpenRouterModelInfo[];
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
      return parseOpenRouterModelCatalog(await request("/models", { method: "GET" }, keyRequired));
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
    body.aspect_ratio = aspectRatio;
    const size = openAiImageSize(aspectRatio);
    if (size) body.size = size;
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

function openAiImageSize(aspectRatio: unknown): string | null {
  const ratio = typeof aspectRatio === "string" ? aspectRatio : "1:1";
  if (ratio === "16:9") return "1792x1024";
  if (ratio === "9:16") return "1024x1792";
  if (ratio === "3:2") return "1536x1024";
  if (ratio === "2:3") return "1024x1536";
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (width === height) return "1024x1024";
  return width > height ? "1536x1024" : "1024x1536";
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
  const models = await client.getModels(false);
  const cache = { refreshedAt: new Date().toISOString(), models };
  const cachePath = options.cachePath ?? join(process.cwd(), "data", "cache", "openrouter-models.json");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache;
}

export async function readOpenRouterModelCatalogCache(cachePath = join(process.cwd(), "data", "cache", "openrouter-models.json")): Promise<OpenRouterCatalogCache | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      refreshedAt: typeof record.refreshedAt === "string" ? record.refreshedAt : "",
      models: Array.isArray(record.models) ? record.models.map(parseOpenRouterModel).filter((model): model is OpenRouterModelInfo => Boolean(model)) : []
    };
  } catch {
    return null;
  }
}

export function parseOpenRouterModelCatalog(input: unknown): OpenRouterModelInfo[] {
  const data: unknown[] = input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).data)
    ? ((input as Record<string, unknown>).data as unknown[])
    : Array.isArray(input) ? input : [];
  return data.map(parseOpenRouterModel).filter((model): model is OpenRouterModelInfo => Boolean(model));
}

function parseOpenRouterModel(input: unknown): OpenRouterModelInfo | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture as Record<string, unknown> : {};
  return {
    id,
    name: optionalString(record.name),
    description: optionalString(record.description),
    architecture: {
      input_modalities: stringArray(architecture.input_modalities),
      output_modalities: stringArray(architecture.output_modalities),
      modality: optionalString(architecture.modality)
    },
    context_length: optionalNumber(record.context_length),
    pricing: record.pricing && typeof record.pricing === "object" ? record.pricing as Record<string, unknown> : undefined,
    supported_parameters: stringArray(record.supported_parameters),
    top_provider: record.top_provider && typeof record.top_provider === "object" ? record.top_provider as Record<string, unknown> : undefined
  };
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
