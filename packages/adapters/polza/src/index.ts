import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { estimateCatalogPricingQuote, estimatePricingCatalogQuote, isPricingCatalogFresh, ModelGateway, type ModelInvokeResult, type ModelPricingInput, type PricingCatalog, type PricingQuote, type PricingSourceAdapter, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

export const POLZA_BASE_URL = "https://polza.ai/api";
export const POLZA_TEXT_DEFAULT_MODEL = "openai/gpt-4o";
export const POLZA_IMAGE_DEFAULT_MODEL = "openai/gpt-5.4-image-2";
export const POLZA_VIDEO_DEFAULT_MODEL = "wan/2.6";
export const POLZA_MISSING_KEY_MESSAGE = "POLZA_AI_API_KEY is not configured.\nAdd POLZA_AI_API_KEY to .env with your Polza.ai API key.";
const LOCAL_FILE_DATA_URI_LIMIT_BYTES = 20 * 1024 * 1024;
const PRICING_TTL_HOURS = 12;

export interface PolzaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  mediaPollIntervalMs?: number;
  mediaPollMaxAttempts?: number;
  modelGateway?: Pick<ModelGateway, "invoke">;
}

export interface PolzaImageAsset {
  localPath?: string;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sourceNodeId: string;
  model: string;
  originalUrl?: string;
  warning?: string;
}

export type PolzaVideoAsset = PolzaImageAsset;

export interface PolzaModelInfo {
  id: string;
  name?: string;
  type?: string;
  short_description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  pricing?: Record<string, unknown>;
  top_provider?: Record<string, unknown>;
}

type PolzaChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type PolzaChatMessage = { role: string; content: string | PolzaChatContentPart[] };

export function createPolzaClient(options: PolzaClientOptions = {}) {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.POLZA_BASE_URL ?? POLZA_BASE_URL);
  const retryDelayMs = options.retryDelayMs ?? 750;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const apiKey = options.apiKey ?? process.env.POLZA_AI_API_KEY;
    if (!apiKey?.trim()) throw new Error(POLZA_MISSING_KEY_MESSAGE);
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${apiKey.trim()}`);
    const maxAttempts = retryableMethod(init.method) ? 3 : 1;
    let lastNetworkError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}${path}`, { ...init, headers });
      } catch (error) {
        lastNetworkError = error;
        if (attempt < maxAttempts) {
          await delay(retryDelayMs * attempt);
          continue;
        }
        throw new Error(polzaNetworkError(error, baseUrl));
      }
      if (response.ok) return response.json();
      const body = await response.text().catch(() => "");
      if (attempt < maxAttempts && retryableStatus(response.status)) {
        await delay(retryDelayMs * attempt);
        continue;
      }
      throw new Error(polzaHttpError(response.status, body));
    }
    throw new Error(polzaNetworkError(lastNetworkError, baseUrl));
  }

  return {
    async chatCompletions(body: Record<string, unknown>): Promise<unknown> {
      return request("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
    },
    async imageGenerations(body: Record<string, unknown>): Promise<unknown> {
      return request("/v2/images/generations", { method: "POST", body: JSON.stringify(body) });
    },
    async media(body: Record<string, unknown>): Promise<unknown> {
      return request("/v1/media", { method: "POST", body: JSON.stringify(body) });
    },
    async mediaStatus(id: string): Promise<unknown> {
      return request(`/v1/media/${encodeURIComponent(id)}`, { method: "GET" });
    },
    async getModels(type?: "chat" | "image" | "video" | "embedding"): Promise<PolzaModelInfo[]> {
      const query = type ? `?type=${encodeURIComponent(type)}` : "";
      return parsePolzaModelCatalog(await request(`/v1/models${query}`, { method: "GET" }));
    }
  };
}

export function parsePolzaModelCatalog(input: unknown): PolzaModelInfo[] {
  const data = input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).data)
    ? (input as Record<string, unknown>).data as unknown[]
    : Array.isArray(input) ? input : [];
  return data.map(parsePolzaModel).filter((model): model is PolzaModelInfo => Boolean(model));
}

export async function refreshPolzaPricingCatalog(options: PolzaClientOptions & { cachePath?: string; ttlHours?: number; type?: "chat" | "image" | "embedding" } = {}): Promise<PricingCatalog> {
  const client = createPolzaClient(options);
  const modelGroups = options.type
    ? [await client.getModels(options.type)]
    : await Promise.all([client.getModels("chat").catch(() => []), client.getModels("image").catch(() => []), client.getModels("embedding").catch(() => [])]);
  const catalog = polzaPricingCatalogFromModels(modelGroups.flat(), options.ttlHours);
  const cachePath = options.cachePath ?? join(process.cwd(), "data", "cache", "model-pricing", "polza.json");
  await writePricingCatalog(cachePath, catalog);
  return catalog;
}

export async function readPolzaPricingCatalogCache(cachePath = join(process.cwd(), "data", "cache", "model-pricing", "polza.json")): Promise<PricingCatalog | null> {
  return readPricingCatalog(cachePath, "polza");
}

export function createPolzaPricingSourceAdapter(options: PolzaClientOptions & { cachePath?: string; ttlHours?: number } = {}): PricingSourceAdapter {
  return {
    provider: "polza",
    refreshPricing: () => refreshPolzaPricingCatalog(options),
    readCachedPricing: () => readPolzaPricingCatalogCache(options.cachePath),
    isCatalogFresh: isPricingCatalogFresh,
    estimateFromCatalog: estimatePolzaPricingQuoteFromCatalog
  };
}

export function estimatePolzaPricingQuoteFromCatalog(input: ModelPricingInput, catalog: PricingCatalog): PricingQuote {
  return estimatePricingCatalogQuote(input, catalog, "Polza pricing catalog is stale; using stale estimate");
}

export function polzaPricingCatalogFromModels(models: PolzaModelInfo[], ttlHours = PRICING_TTL_HOURS, fetchedAt = new Date().toISOString()): PricingCatalog {
  const fetchedMs = Date.parse(fetchedAt);
  const baseMs = Number.isFinite(fetchedMs) ? fetchedMs : Date.now();
  const catalog: PricingCatalog = {
    provider: "polza",
    fetchedAt: new Date(baseMs).toISOString(),
    expiresAt: new Date(baseMs + ttlHours * 60 * 60 * 1000).toISOString(),
    source: "polza_models_catalog",
    sourceUrl: null,
    models: {},
    warnings: []
  };
  for (const model of models) {
    if (!model.pricing || Object.keys(model.pricing).length === 0) continue;
    catalog.models[model.id] = {
      currency: typeof model.pricing.currency === "string" ? model.pricing.currency : "USD",
      pricing: { ...model.pricing },
      raw: { id: model.id, name: model.name, type: model.type }
    };
  }
  return catalog;
}

function parsePolzaModel(input: unknown): PolzaModelInfo | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture as Record<string, unknown> : {};
  return {
    id,
    name: typeof record.name === "string" ? record.name : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    short_description: typeof record.short_description === "string" ? record.short_description : undefined,
    architecture: {
      input_modalities: stringArray(architecture.input_modalities),
      output_modalities: stringArray(architecture.output_modalities),
      modality: typeof architecture.modality === "string" ? architecture.modality : undefined
    },
    pricing: record.pricing && typeof record.pricing === "object" ? record.pricing as Record<string, unknown> : undefined,
    top_provider: record.top_provider && typeof record.top_provider === "object" ? record.top_provider as Record<string, unknown> : undefined
  };
}

export function createPolzaTextNodeRunner(options: PolzaClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs }) => {
    const model = stringParam(params.model) ?? POLZA_TEXT_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Polza Text requires a prompt.");
    const systemPrompt = firstInputText(inputs.systemPrompt) ?? stringParam(params.systemPrompt);
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 14) throw new Error(`Polza Text accepts at most 14 input images, got ${images.length}.`);
    const gateway = options.modelGateway ?? createPolzaModelGateway(options, model, "text.generate");
    const gatewayResult = await gateway.invoke({
      capability: "text.generate",
      modelRef: `model://polza/${model}`,
      input: { prompt, images, systemPrompt },
      parameters: params,
      metadata: { nodeId: node.id, nodeType: node.type }
    });
    const response = gatewayResult.output.output;
    const text = typeof gatewayResult.output.text === "string" ? gatewayResult.output.text : firstChatText(response);
    if (!text) throw new Error(`Polza text model "${model}" did not return text.`);
    const usage = objectField(response, "usage");
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimatePolzaPricingQuote({
      provider: "polza",
      providerModel: model,
      capability: "text.generate",
      params,
      inputMetadata: {}
    });
    return {
      output: {
        text,
        output: response,
        provider: "polza",
        model,
        providerModel: model,
        estimatedCost: pricingQuote.estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        actualCostCurrency: actualCostCurrencyFromUsage(usage),
        pricingSource: pricingQuote.pricingSource,
        pricingQuote,
        status: "succeeded"
      },
      logs: [`Generated text with Polza ${model}`],
      provenance: { provider: "polza", model },
      providerUsage: polzaUsageEvent(node.id, node.type, model, "succeeded", usage, pricingQuote)
    };
  };
}

export function createPolzaImageNodeRunner(options: PolzaClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const model = stringParam(params.model) ?? POLZA_IMAGE_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Polza Image requires a prompt.");
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 14) throw new Error(`Polza Image accepts at most 14 input images, got ${images.length}.`);
    const gateway = options.modelGateway ?? createPolzaModelGateway(options, model, "image.generate");
    const gatewayResult = await gateway.invoke({
      capability: "image.generate",
      modelRef: `model://polza/${model}`,
      input: { prompt, images },
      parameters: params,
      metadata: { outputDirectory: context.outputDirectory, sourceNodeId: node.id, nodeId: node.id, nodeType: node.type }
    });
    const response = gatewayResult.output.output;
    const request = gatewayResult.output.request as Record<string, unknown> | undefined;
    const imageAsset = polzaImageAssetFromGateway(gatewayResult);
    if (!imageAsset) throw new Error(`Polza image model "${model}" did not return an image.`);
    const usage = objectField(response, "usage");
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimatePolzaPricingQuote({
      provider: "polza",
      providerModel: model,
      capability: "image.generate",
      params,
      inputMetadata: {}
    });
    return {
      output: {
        image: imageAsset,
        output: response,
        request,
        provider: "polza",
        model,
        providerModel: model,
        estimatedCost: pricingQuote.estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        actualCostCurrency: actualCostCurrencyFromUsage(usage),
        pricingSource: pricingQuote.pricingSource,
        pricingQuote,
        inputImageCount: images.length,
        localPath: imageAsset.localPath,
        originalUrl: imageAsset.originalUrl,
        warning: imageAsset.warning,
        status: "succeeded"
      },
      logs: [`Generated Polza image with ${model}: ${imageAsset.localPath ?? imageAsset.originalUrl ?? imageAsset.path}`],
      provenance: { provider: "polza", model },
      providerUsage: polzaUsageEvent(node.id, node.type, model, "succeeded", usage, pricingQuote)
    };
  };
}

export function createPolzaVideoNodeRunner(options: PolzaClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const model = stringParam(params.model) ?? POLZA_VIDEO_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Polza Video requires a prompt.");
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 1) throw new Error(`Polza Video accepts at most 1 input image, got ${images.length}.`);
    const gateway = options.modelGateway ?? createPolzaModelGateway(options, model, "video.generate");
    const gatewayResult = await gateway.invoke({
      capability: "video.generate",
      modelRef: `model://polza/${model}`,
      input: { prompt, images },
      parameters: params,
      metadata: { outputDirectory: context.outputDirectory, sourceNodeId: node.id, nodeId: node.id, nodeType: node.type }
    });
    const response = gatewayResult.output.output;
    const request = gatewayResult.output.request as Record<string, unknown> | undefined;
    const videoAsset = polzaVideoAssetFromGateway(gatewayResult);
    if (!videoAsset) throw new Error(`Polza video model "${model}" did not return a video.`);
    const usage = objectField(response, "usage");
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimatePolzaPricingQuote({
      provider: "polza",
      providerModel: model,
      capability: "video.generate",
      params,
      inputMetadata: {}
    });
    return {
      output: {
        video: videoAsset,
        output: response,
        request,
        provider: "polza",
        model,
        providerModel: model,
        estimatedCost: pricingQuote.estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        actualCostCurrency: actualCostCurrencyFromUsage(usage),
        pricingSource: pricingQuote.pricingSource,
        pricingQuote,
        inputImageCount: images.length,
        localPath: videoAsset.localPath,
        originalUrl: videoAsset.originalUrl,
        warning: videoAsset.warning,
        status: "succeeded"
      },
      logs: [`Generated Polza video with ${model}: ${videoAsset.localPath ?? videoAsset.originalUrl ?? videoAsset.path}`],
      provenance: { provider: "polza", model },
      providerUsage: polzaUsageEvent(node.id, node.type, model, "succeeded", usage, pricingQuote)
    };
  };
}

export function createPolzaProviderAdapter(options: PolzaClientOptions = {}): ProviderAdapter {
  const client = createPolzaClient(options);
  return {
    id: "polza",
    title: "Polza.ai",
    capabilities: ["text.generate", "image.generate", "video.generate"],
    pricingResolver: {
      estimate: estimatePolzaPricingQuote
    },
    async invoke(request) {
      const prompt = stringParam(request.input.prompt) ?? "";
      const images = collectInputImages(request.input.images ?? request.input.image);
      if (request.capability === "text.generate") {
        const imageUrls = await Promise.all(images.map((image) => prepareImageUrl(image, options.fetchImpl)));
        const userContent: string | PolzaChatContentPart[] = imageUrls.length > 0
          ? [
              { type: "text", text: prompt },
              ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))
            ]
          : prompt;
        const systemPrompt = stringParam(request.input.systemPrompt);
        const messages: PolzaChatMessage[] = [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: userContent }
        ];
        const response = await client.chatCompletions(buildChatRequestBody(request.model.id, messages, request.parameters ?? {}));
        const text = firstChatText(response);
        return {
          modelId: request.model.id,
          providerId: "polza",
          capability: request.capability,
          output: { text, output: response, model: request.model.id },
          usage: objectField(response, "usage") as Record<string, unknown> | undefined,
          raw: response
        };
      }
      if (request.capability === "image.generate") {
        const imageInputs = await Promise.all(images.map((image) => prepareMediaImageInput(image, options.fetchImpl)));
        const usesImageGenerations = usesPolzaImageGenerationsEndpoint(request.model.id);
        const requestBody = usesImageGenerations
          ? buildImageRequestBody(polzaImageGenerationsModel(request.model.id), prompt, request.parameters ?? {})
          : buildMediaImageRequestBody(request.model.id, prompt, request.parameters ?? {}, imageInputs);
        const response = usesImageGenerations ? await client.imageGenerations(requestBody) : await waitForPolzaMediaResult(await client.media(requestBody), client, options);
        const image = firstGeneratedImage(response);
        if (!image) throw new Error(`Polza image model "${request.model.id}" did not return an image.`);
        const imageAsset = await writePolzaImage(image, {
          outputDirectory: stringParam(request.metadata?.outputDirectory) ?? process.cwd(),
          sourceNodeId: stringParam(request.metadata?.sourceNodeId) ?? "polza",
          model: request.model.id,
          fetchImpl: options.fetchImpl
        });
        return {
          modelId: request.model.id,
          providerId: "polza",
          capability: request.capability,
          output: { image: imageAsset, output: response, request: requestBody, model: request.model.id },
          usage: objectField(response, "usage") as Record<string, unknown> | undefined,
          raw: response
        };
      }
      if (request.capability === "video.generate") {
        const imageInputs = await Promise.all(images.map((image) => prepareMediaImageInput(image, options.fetchImpl)));
        const requestBody = buildMediaVideoRequestBody(request.model.id, prompt, request.parameters ?? {}, imageInputs);
        const response = await waitForPolzaMediaResult(await client.media(requestBody), client, options, "video");
        const video = firstGeneratedVideo(response);
        if (!video) throw new Error(`Polza video model "${request.model.id}" did not return a video.`);
        const videoAsset = await writePolzaVideo(video, {
          outputDirectory: stringParam(request.metadata?.outputDirectory) ?? process.cwd(),
          sourceNodeId: stringParam(request.metadata?.sourceNodeId) ?? "polza",
          model: request.model.id,
          fetchImpl: options.fetchImpl
        });
        return {
          modelId: request.model.id,
          providerId: "polza",
          capability: request.capability,
          output: { video: videoAsset, output: response, request: requestBody, model: request.model.id },
          usage: objectField(response, "usage") as Record<string, unknown> | undefined,
          raw: response
        };
      }
      throw new Error(`Polza adapter does not support capability "${request.capability}".`);
    }
  };
}

export function estimatePolzaPricingQuote(input: ModelPricingInput): PricingQuote {
  return estimateCatalogPricingQuote(input, input.params.pricing, "polza_catalog");
}

function createPolzaModelGateway(options: PolzaClientOptions, model: string, capability: "text.generate" | "image.generate" | "video.generate"): ModelGateway {
  return new ModelGateway({
    models: [{
      id: model,
      providerId: "polza",
      title: model,
      capabilities: [capability],
      pricingHint: "polza_usage"
    }],
    adapters: [createPolzaProviderAdapter(options)],
    connections: [{
      providerId: "polza",
      enabled: true,
      credentialRef: "provider.polza.default",
      baseUrl: options.baseUrl ?? process.env.POLZA_BASE_URL ?? POLZA_BASE_URL
    }]
  });
}

function polzaImageAssetFromGateway(result: ModelInvokeResult): PolzaImageAsset | undefined {
  const image = result.output.image;
  return image && typeof image === "object" ? image as PolzaImageAsset : undefined;
}

function polzaVideoAssetFromGateway(result: ModelInvokeResult): PolzaVideoAsset | undefined {
  const video = result.output.video;
  return video && typeof video === "object" ? video as PolzaVideoAsset : undefined;
}

function quoteFromGatewayOutput(output: Record<string, unknown>): PricingQuote | null {
  const quote = output.pricingQuote;
  return quote && typeof quote === "object" ? quote as PricingQuote : null;
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
      fetchedAt: stringField(record, "fetchedAt") ?? "",
      expiresAt: stringField(record, "expiresAt") ?? "",
      source: stringField(record, "source") ?? `${provider}_catalog`,
      sourceUrl: stringField(record, "sourceUrl") ?? null,
      models: record.models && typeof record.models === "object" ? record.models as PricingCatalog["models"] : {},
      warnings: stringArray(record.warnings) ?? []
    };
  } catch {
    return null;
  }
}

export function buildChatRequestBody(model: string, messages: PolzaChatMessage[], params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  for (const key of ["temperature", "max_tokens", "max_completion_tokens", "top_p", "frequency_penalty", "presence_penalty"] as const) {
    if (params[key] !== undefined) body[key] = params[key];
  }
  return body;
}

export function buildImageRequestBody(model: string, prompt: string, params: Record<string, unknown>): Record<string, unknown> {
  const requestedSize = stringParam(params.size);
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: numberParam(params.n) ?? 1,
    size: requestedSize && requestedSize !== "auto" ? requestedSize : sizeFromAspectRatio(params.aspectRatio) ?? "1024x1024",
    quality: stringParam(params.quality) ?? stringParam(params.imageSize) ?? "auto",
    response_format: stringParam(params.responseFormat) ?? "b64_json"
  };
  for (const [paramKey, bodyKey] of [
    ["style", "style"],
    ["outputFormat", "output_format"],
    ["background", "background"],
    ["outputCompression", "output_compression"],
    ["user", "user"]
  ] as const) {
    if (params[paramKey] !== undefined) body[bodyKey] = params[paramKey];
  }
  return body;
}

export function buildMediaImageRequestBody(model: string, prompt: string, params: Record<string, unknown>, imageInputs: Array<{ type: "url" | "base64"; data: string }> = []): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt };
  if (imageInputs.length > 0) input.images = imageInputs;
  if (isPolzaGpt54Image2(model)) {
    input.aspect_ratio = stringParam(params.aspectRatio) ?? "auto";
    input.n = numberParam(params.n) ?? 1;
  } else if (isPolzaGptImage15(model)) {
    input.aspect_ratio = supportedPolzaAspectRatio(params.aspectRatio, ["1:1", "2:3", "3:2"], "1:1");
    input.quality = stringParam(params.quality) ?? "medium";
  } else if (!isPolzaOpenAiImageWithoutAspectRatio(model)) {
    input.aspect_ratio = stringParam(params.aspectRatio) ?? "1:1";
    input.image_resolution = stringParam(params.imageResolution) ?? stringParam(params.imageSize) ?? "2K";
    input.quality = stringParam(params.quality) ?? "high";
    input.output_format = stringParam(params.outputFormat) ?? "png";
    input.max_images = numberParam(params.n) ?? 1;
  }
  return {
    model,
    input: filterDefined(input),
    async: false,
    user: stringParam(params.user)
  };
}

export function buildMediaVideoRequestBody(model: string, prompt: string, params: Record<string, unknown>, imageInputs: Array<{ type: "url" | "base64"; data: string }> = []): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt,
    resolution: stringParam(params.resolution) ?? "720p",
    duration: String(numberParam(params.duration) ?? stringParam(params.duration) ?? "5"),
    multi_shots: params.multi_shots === true || stringParam(params.multi_shots) === "true" ? "true" : "false"
  };
  if (imageInputs.length > 0) input.images = imageInputs.slice(0, 1);
  return { model, input, async: true, user: stringParam(params.user) };
}

function isPolzaGpt54Image2(model: string): boolean {
  return model === "openai/gpt-5.4-image-2";
}

function isPolzaGptImage15(model: string): boolean {
  return model === "openai/gpt-image-1.5";
}

function isPolzaOpenAiImageWithoutAspectRatio(model: string): boolean {
  return model === "openai/gpt-5-image" || model === "openai/gpt-5-image-mini";
}

function usesPolzaImageGenerationsEndpoint(model: string): boolean {
  return model === "dall-e-3" || model === "dall-e-2" || model === "gpt-image-1" || model === "openai/gpt-image-1";
}

function polzaImageGenerationsModel(model: string): string {
  return model === "openai/gpt-image-1" ? "gpt-image-1" : model;
}

function supportedPolzaAspectRatio(value: unknown, allowed: string[], fallback: string): string {
  const ratio = stringParam(value);
  return ratio && allowed.includes(ratio) ? ratio : fallback;
}

function firstChatText(response: unknown): string {
  const choices = objectField(response, "choices");
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  const message = first && typeof first === "object" ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
  return typeof content === "string" ? content : "";
}

function firstGeneratedImage(response: unknown): unknown {
  const mediaImage = firstMediaImage(response);
  if (mediaImage) return mediaImage;
  const data = objectField(response, "data");
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  return record.b64_json ?? record.url ?? null;
}

function firstGeneratedVideo(response: unknown): unknown {
  const mediaVideo = firstMediaVideo(response);
  if (mediaVideo) return mediaVideo;
  const data = objectField(response, "data");
  return firstMediaVideo(data);
}

async function waitForPolzaMediaResult(
  initialResponse: unknown,
  client: { mediaStatus: (id: string) => Promise<unknown> },
  options: PolzaClientOptions,
  kind: "image" | "video" = "image"
): Promise<unknown> {
  const outputFrom = kind === "video" ? firstGeneratedVideo : firstGeneratedImage;
  if (outputFrom(initialResponse)) return initialResponse;
  const initialState = mediaOperationState(initialResponse);
  const id = initialState.id;
  const status = initialState.status;
  if (!id || (status !== "pending" && status !== "processing")) return initialResponse;

  const intervalMs = options.mediaPollIntervalMs ?? 3000;
  const maxAttempts = options.mediaPollMaxAttempts ?? 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(intervalMs);
    const response = await client.mediaStatus(id);
    const nextStatus = mediaOperationState(response).status;
    if (nextStatus === "completed" || outputFrom(response)) return response;
    if (nextStatus === "failed") throw new Error(`Polza ${kind} generation failed (${id}). ${JSON.stringify(objectField(response, "error") ?? response)}`);
  }
  throw new Error(`Polza ${kind} generation is still ${status} (${id}) after ${Math.round((intervalMs * maxAttempts) / 1000)} seconds.`);
}

function mediaOperationState(value: unknown): { id?: string; status?: string } {
  const directId = stringField(value, "id");
  const directStatus = stringField(value, "status");
  if (directId || directStatus) return { id: directId, status: directStatus?.toLowerCase() };
  const text = nestedStatusText(value);
  const pending = /\b(pending|processing)\s*\(\s*([^)]+)\s*\)/i.exec(text);
  return pending ? { status: pending[1].toLowerCase(), id: pending[2].trim() } : {};
}

function nestedStatusText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nestedStatusText).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>).map(nestedStatusText).join(" ");
}

function firstMediaImage(value: unknown): unknown {
  if (!value) return null;
  if (typeof value === "string") return looksLikeImageReference(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = firstMediaImage(item);
      if (image) return image;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "image", "image_url", "output_url", "file_url", "b64_json", "base64", "data"]) {
    const image = firstMediaImage(record[key]);
    if (image) return image;
  }
  for (const key of ["images", "files", "outputs", "result", "results"]) {
    const image = firstMediaImage(record[key]);
    if (image) return image;
  }
  return null;
}

function firstMediaVideo(value: unknown): unknown {
  if (!value) return null;
  if (typeof value === "string") return looksLikeVideoReference(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const video = firstMediaVideo(item);
      if (video) return video;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "video", "video_url", "output_url", "file_url", "b64_json", "base64", "data"]) {
    const video = firstMediaVideo(record[key]);
    if (video) return video;
  }
  for (const key of ["videos", "files", "outputs", "result", "results"]) {
    const video = firstMediaVideo(record[key]);
    if (video) return video;
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

async function prepareMediaImageInput(value: unknown, fetchImpl: typeof fetch = fetch): Promise<{ type: "url" | "base64"; data: string }> {
  const data = await prepareImageUrl(value, fetchImpl);
  return { type: /^https?:\/\//i.test(data) ? "url" : "base64", data };
}

async function prepareImageUrl(value: unknown, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return prepareImageUrl(record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.image, fetchImpl);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Polza Image expected image input as a local path, image object, data URI, or remote URL.");
  }
  if (value.startsWith("data:")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  const bytes = await readFile(value);
  if (bytes.length > LOCAL_FILE_DATA_URI_LIMIT_BYTES) throw new Error(`Polza local image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_DATA_URI_LIMIT_BYTES} bytes.`);
  return `data:${mimeTypeFromPath(value)};base64,${bytes.toString("base64")}`;
}

function looksLikeImageReference(value: string): boolean {
  return value.startsWith("data:image/") || /^https?:\/\//i.test(value) || /^[A-Za-z0-9+/]+=*$/.test(value.slice(0, 80));
}

function looksLikeVideoReference(value: string): boolean {
  return value.startsWith("data:video/") || /^https?:\/\//i.test(value) || /^[A-Za-z0-9+/]+=*$/.test(value.slice(0, 80));
}

async function writePolzaImage(
  image: unknown,
  options: { outputDirectory: string; sourceNodeId: string; model: string; fetchImpl?: typeof fetch }
): Promise<PolzaImageAsset> {
  if (typeof image !== "string" || !image.trim()) throw new Error("Polza image response did not include a usable image URL or base64 payload.");
  if (/^https?:\/\//i.test(image)) {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(image);
    } catch (error) {
      return remoteImageAsset(image, {
        ...options,
        warning: `Polza returned an image URL, but SnarkRoute could not download a local copy. Details: ${networkErrorDetail(error)}`
      });
    }
    if (!response.ok) throw new Error(`Could not download Polza image output (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? mimeTypeFromUrl(image);
    return writeGeneratedImage(bytes, mimeType, { ...options, originalUrl: image });
  }
  const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(image);
  if (dataUriMatch) return writeGeneratedImage(Buffer.from(dataUriMatch[2], "base64"), dataUriMatch[1], options);
  return writeGeneratedImage(Buffer.from(image, "base64"), "image/png", options);
}

async function writePolzaVideo(
  video: unknown,
  options: { outputDirectory: string; sourceNodeId: string; model: string; fetchImpl?: typeof fetch }
): Promise<PolzaVideoAsset> {
  if (typeof video !== "string" || !video.trim()) throw new Error("Polza video response did not include a usable video URL or base64 payload.");
  if (/^https?:\/\//i.test(video)) {
    const response = await (options.fetchImpl ?? fetch)(video);
    if (!response.ok) throw new Error(`Could not download Polza video output (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? videoMimeTypeFromUrl(video);
    return writeGeneratedVideo(bytes, mimeType, { ...options, originalUrl: video });
  }
  const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(video);
  if (dataUriMatch) return writeGeneratedVideo(Buffer.from(dataUriMatch[2], "base64"), dataUriMatch[1], options);
  return writeGeneratedVideo(Buffer.from(video, "base64"), "video/mp4", options);
}

function remoteImageAsset(url: string, options: { sourceNodeId: string; model: string; warning?: string }): PolzaImageAsset {
  return {
    originalUrl: url,
    path: url,
    filename: filenameFromUrl(url),
    mimeType: mimeTypeFromUrl(url),
    sourceNodeId: options.sourceNodeId,
    model: options.model,
    warning: options.warning
  };
}

async function writeGeneratedImage(
  bytes: Buffer,
  mimeType: string,
  options: { outputDirectory: string; sourceNodeId: string; model: string; originalUrl?: string }
): Promise<PolzaImageAsset> {
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
    model: options.model,
    originalUrl: options.originalUrl
  };
}

async function writeGeneratedVideo(
  bytes: Buffer,
  mimeType: string,
  options: { outputDirectory: string; sourceNodeId: string; model: string; originalUrl?: string }
): Promise<PolzaVideoAsset> {
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${sanitizeFilename(options.sourceNodeId)}-${Date.now()}${videoExtensionFromMimeType(mimeType)}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, bytes);
  return {
    localPath,
    path: localPath,
    filename,
    mimeType,
    sizeBytes: bytes.length,
    sourceNodeId: options.sourceNodeId,
    model: options.model,
    originalUrl: options.originalUrl
  };
}

function polzaUsageEvent(nodeId: string, nodeType: string, model: string, status: string, usage: unknown, pricingQuote: PricingQuote): ProviderUsageEvent {
  return {
    provider: "polza",
    model,
    providerModel: model,
    nodeId,
    nodeType,
    status,
    metrics: usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined,
    estimatedCost: pricingQuote.estimatedCost,
    actualCost: actualCostFromUsage(usage),
    actualCostCurrency: actualCostCurrencyFromUsage(usage),
    pricingHint: pricingQuote.pricingSource,
    pricingSource: pricingQuote.pricingSource,
    pricingQuote
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

function actualCostFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  return numberParam((usage as Record<string, unknown>).cost) ?? numberParam((usage as Record<string, unknown>).cost_rub) ?? null;
}

function actualCostCurrencyFromUsage(usage: unknown): string | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  if (numberParam(record.cost_rub) !== undefined) return "RUB";
  if (numberParam(record.cost) !== undefined) return typeof record.currency === "string" ? record.currency : null;
  return null;
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function filterDefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function numberParam(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function sizeFromAspectRatio(value: unknown): string | undefined {
  const ratio = stringParam(value);
  if (ratio === "1:1") return "1024x1024";
  if (ratio === "3:2" || ratio === "16:9") return "1792x1024";
  if (ratio === "2:3" || ratio === "9:16") return "1024x1792";
  return undefined;
}

function sanitizeFilename(filename: string): string {
  return basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function mimeTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
    if (pathname.endsWith(".webp")) return "image/webp";
  } catch {
    return "image/png";
  }
  return "image/png";
}

function videoMimeTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".webm")) return "video/webm";
    if (pathname.endsWith(".mov")) return "video/quicktime";
  } catch {
    return "video/mp4";
  }
  return "video/mp4";
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

function filenameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    return name || "polza-image";
  } catch {
    return "polza-image";
  }
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function videoExtensionFromMimeType(mimeType: string): string {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
}

function polzaHttpError(status: number, body: string): string {
  if (status === 401 || status === 403) return "Polza.ai API key seems invalid.";
  if (status === 402) return "Polza.ai account has insufficient funds.";
  if (status === 404) return "Polza.ai model or endpoint was not found.";
  const message = body ? ` ${truncate(body, 500)}` : "";
  return `Polza.ai request failed (${status}).${message}`;
}

function polzaNetworkError(error: unknown, baseUrl: string): string {
  return `Polza.ai is unreachable at ${baseUrl}. Check internet access, proxy/VPN/firewall settings, DNS, or POLZA_BASE_URL. Details: ${networkErrorDetail(error)}`;
}

function retryableMethod(method: string | undefined): boolean {
  return ["GET", "POST"].includes((method ?? "GET").toUpperCase());
}

function retryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const causeCode = cause && "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
  const causeMessage = cause?.message ?? "";
  return [causeCode, causeMessage, message].filter(Boolean).join(": ") || "network request failed";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}
