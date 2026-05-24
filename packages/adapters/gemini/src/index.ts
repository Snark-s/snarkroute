import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ModelGateway, unknownPricingQuote, type ModelInvokeResult, type ModelPricingInput, type PricingQuote, type PricingUnit, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const LOCAL_FILE_DATA_URI_LIMIT_BYTES = 10 * 1024 * 1024;
export const NANO_BANANA_2_DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
export const GEMINI_LLM_DEFAULT_MODEL = "gemini-2.5-flash-lite";
export const GEMINI_LLM_DEFAULT_SYSTEM_PROMPT = `Convert the user's rough idea into a clean image-generation prompt.
Preserve the humor and core idea.
Make risky wording safe and non-erotic.
Do not include copyrighted characters, logos, or text.
Output only the final image prompt.`;
const GEMINI_LLM_PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number; label: string }> = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5, label: "Gemini 2.5 Flash" },
  "gemini-2.5-flash-preview-09-2025": { input: 0.3, output: 2.5, label: "Gemini 2.5 Flash Preview" },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, label: "Gemini 2.5 Flash-Lite" },
  "gemini-2.5-flash-lite-preview-09-2025": { input: 0.1, output: 0.4, label: "Gemini 2.5 Flash-Lite Preview" }
};
const MISSING_TOKEN_MESSAGE = "GEMINI_API_KEY is not configured.\nOpen Settings \u2192 Secrets \u2192 Gemini and paste your token.";

export interface GeminiClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  modelGateway?: Pick<ModelGateway, "invoke">;
  pricingConfigPath?: string;
  localPricingConfig?: GeminiLocalPricingConfig;
}

export interface GeminiLocalPricingConfig {
  provider?: string;
  source?: string;
  updatedAt?: string | null;
  ttlHours?: number;
  allowStalePricing?: boolean;
  models?: Record<string, {
    currency?: string;
    unit?: PricingUnit;
    price?: number | string | null;
    confidence?: "exact" | "estimated" | "low" | "unknown";
    sourceUrl?: string | null;
    notes?: string;
  }>;
}

export interface GeminiImageConfig {
  aspectRatio?: string;
  imageSize?: string;
}

export interface GeminiGenerateResult {
  model: string;
  output: unknown;
  image?: {
    mimeType: string;
    dataBase64: string;
  };
  text?: string;
}

export interface GeminiDownloadedImageAsset {
  localPath: string;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceNodeId: string;
  model: string;
}

export function createGeminiClient(options: GeminiClientOptions = {}) {
  const fetcher = options.fetchImpl ?? fetch;

  async function request(path: string, init: RequestInit = {}) {
    const token = options.token ?? process.env.GEMINI_API_KEY;
    if (!token?.trim()) throw new Error(MISSING_TOKEN_MESSAGE);
    const response = await fetcher(`${API_BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(token.trim())}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  return {
    async generateContent(model: string, parts: unknown[], imageConfig: GeminiImageConfig = {}): Promise<GeminiGenerateResult> {
      const output = await request(`/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: filterDefined({
              aspectRatio: imageConfig.aspectRatio,
              imageSize: imageConfig.imageSize
            })
          }
        })
      });
      return {
        model,
        output,
        image: firstInlineImage(output),
        text: firstText(output)
      };
    },
    async generateText(model: string, parts: unknown[], systemPrompt?: string): Promise<GeminiGenerateResult> {
      const output = await request(`/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        body: JSON.stringify({
          systemInstruction: stringParam(systemPrompt) ? { parts: [{ text: String(systemPrompt) }] } : undefined,
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["TEXT"] }
        })
      });
      return {
        model,
        output,
        text: firstText(output)
      };
    }
  };
}

export function createNanoBanana2NodeRunner(options: GeminiClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const model = NANO_BANANA_2_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "Create a polished image.");
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 14) throw new Error(`gemini.nano-banana-2 accepts at most 14 input images, got ${images.length}.`);
    const gateway = options.modelGateway ?? createGeminiModelGateway(options, model, "image.generate");
    const gatewayResult = await gateway.invoke({
      capability: "image.generate",
      modelRef: `model://gemini/${model}`,
      input: { prompt, images },
      parameters: {
        aspectRatio: stringParam(params.aspectRatio),
        imageSize: stringParam(params.imageSize)
      },
      metadata: { outputDirectory: context.outputDirectory, sourceNodeId: node.id, nodeId: node.id, nodeType: node.type }
    });
    const result = geminiGenerateResultFromGateway(gatewayResult, model);
    const pricingQuote = quoteFromGatewayOutput(gatewayResult.output) ?? estimateGeminiPricingQuote({
      provider: "gemini",
      providerModel: model,
      capability: "image.generate",
      params: {
        aspectRatio: stringParam(params.aspectRatio),
        imageSize: stringParam(params.imageSize),
        localPricingConfig: options.localPricingConfig ?? await readLocalGeminiPricingConfig(options.pricingConfigPath)
      },
      inputMetadata: {}
    });
    const imageAsset = imageAssetFromGateway(gatewayResult);
    if (!result.image) {
      throw new Error(
        `Nano Banana 2 (${model}) did not return an image.${result.text ? ` Provider text response: ${truncateProviderText(result.text)}` : ""} Try an explicit image-generation prompt.`
      );
    }
    if (!imageAsset) throw new Error(`Nano Banana 2 (${model}) did not return a saved image asset.`);
    return {
      output: {
        image: imageAsset,
        output: result.output,
        text: result.text,
        provider: "gemini",
        model,
        providerModel: model,
        cost: legacyCostFromQuote(pricingQuote, params.imageSize),
        estimatedCost: pricingQuote.estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        pricingSource: pricingQuote.pricingSource,
        pricingQuote,
        actualUsage: gatewayResult.usage,
        actualCost: null,
        actualCostCurrency: null,
        inputImageCount: images.length,
        localPath: imageAsset.localPath,
        status: "succeeded"
      },
      logs: [`Downloaded Nano Banana 2 output to ${imageAsset.localPath}`],
      provenance: { provider: "gemini", model },
      providerUsage: {
        provider: "gemini",
        model,
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        providerModel: model,
        logicalModel: undefined,
        estimatedCost: pricingQuote.estimatedCost,
        actualCost: null,
        actualCostCurrency: null,
        pricingHint: pricingQuote.pricingSource,
        pricingSource: pricingQuote.pricingSource,
        pricingQuote
      } satisfies ProviderUsageEvent
    };
  };
}

export function createGeminiLlmNodeRunner(options: GeminiClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs }) => {
    const model = stringParam(params.model) ?? GEMINI_LLM_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    const systemPrompt = firstInputText(inputs.systemPrompt) ?? String(params.systemPrompt ?? GEMINI_LLM_DEFAULT_SYSTEM_PROMPT);
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 14) throw new Error(`gemini.llm accepts at most 14 input images, got ${images.length}.`);
    const gateway = options.modelGateway ?? createGeminiModelGateway(options, model, "text.generate");
    const gatewayResult = await gateway.invoke({
      capability: "text.generate",
      modelRef: `model://gemini/${model}`,
      input: { prompt, images, systemPrompt },
      metadata: { nodeId: node.id, nodeType: node.type }
    });
    const result = geminiGenerateResultFromGateway(gatewayResult, model);
    const pricingQuote = estimateGeminiPricingQuote({
      provider: "gemini",
      providerModel: model,
      capability: "text.generate",
      params: { localPricingConfig: options.localPricingConfig ?? await readLocalGeminiPricingConfig(options.pricingConfigPath) },
      inputMetadata: {}
    });
    const text = result.text?.trim();
    if (!text) {
      throw new Error(`Gemini LLM (${model}) did not return text.`);
    }
    return {
      output: {
        text,
        output: result.output,
        provider: "gemini",
        model,
        providerModel: model,
        cost: estimateGeminiLlmCost(model, result.output),
        estimatedCost: pricingQuote.estimatedCost,
        estimatedCostCurrency: pricingQuote.currency,
        estimatedCostConfidence: pricingQuote.confidence,
        pricingSource: pricingQuote.pricingSource,
        pricingQuote,
        actualUsage: gatewayResult.usage,
        actualCost: null,
        actualCostCurrency: null,
        status: "succeeded"
      },
      logs: [`Generated Gemini text with ${model}`],
      provenance: { provider: "gemini", model },
      providerUsage: {
        provider: "gemini",
        model,
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        providerModel: model,
        estimatedCost: pricingQuote.estimatedCost,
        actualCost: null,
        actualCostCurrency: null,
        pricingHint: pricingQuote.pricingSource,
        pricingSource: pricingQuote.pricingSource,
        pricingQuote
      } satisfies ProviderUsageEvent
    };
  };
}

export function createGeminiProviderAdapter(options: GeminiClientOptions = {}): ProviderAdapter {
  const client = createGeminiClient(options);
  return {
    id: "gemini",
    title: "Gemini",
    capabilities: ["text.generate", "image.generate"],
    pricingResolver: {
      estimate: estimateGeminiPricingQuote
    },
    async invoke(request) {
      const prompt = stringParam(request.input.prompt) ?? "";
      const images = collectInputImages(request.input.images ?? request.input.image);
      if (images.length > 14) throw new Error(`gemini provider adapter accepts at most 14 input images, got ${images.length}.`);
      if (request.capability === "text.generate") {
        const parts = await buildNanoBanana2Parts({ prompt, images, fetchImpl: options.fetchImpl });
        const result = await client.generateText(request.model.id, parts, stringParam(request.input.systemPrompt));
        return {
          modelId: request.model.id,
          providerId: "gemini",
          capability: request.capability,
          output: {
            text: result.text,
            output: result.output,
            model: request.model.id
          },
          usage: objectField(result.output, "usageMetadata") as Record<string, unknown> | undefined,
          raw: result
        };
      }
      if (request.capability === "image.generate") {
        const effectivePrompt = buildImageGenerationPrompt(prompt, images.length > 0);
        const parts = await buildNanoBanana2Parts({ prompt: effectivePrompt, images, fetchImpl: options.fetchImpl });
        const result = await client.generateContent(request.model.id, parts, {
          aspectRatio: stringParam(request.parameters?.aspectRatio),
          imageSize: stringParam(request.parameters?.imageSize)
        });
        const imageAsset = result.image
          ? await writeGeneratedImage(result.image, {
              outputDirectory: stringParam(request.metadata?.outputDirectory) ?? process.cwd(),
              sourceNodeId: stringParam(request.metadata?.sourceNodeId) ?? "gemini",
              model: request.model.id
            })
          : undefined;
        return {
          modelId: request.model.id,
          providerId: "gemini",
          capability: request.capability,
          output: {
            image: imageAsset,
            output: result.output,
            text: result.text,
            model: request.model.id
          },
          usage: objectField(result.output, "usageMetadata") as Record<string, unknown> | undefined,
          raw: result
        };
      }
      throw new Error(`Gemini adapter does not support capability "${request.capability}".`);
    }
  };
}

export function estimateGeminiPricingQuote(input: ModelPricingInput): PricingQuote {
  const config = input.params.localPricingConfig;
  const allowStalePricing = input.params.allowStalePricing === true || Boolean(config && typeof config === "object" && (config as GeminiLocalPricingConfig).allowStalePricing);
  const modelConfig = config && typeof config === "object"
    ? ((config as GeminiLocalPricingConfig).models ?? {})[input.providerModel]
    : undefined;
  const pricingSource = typeof config === "object" && config && typeof (config as GeminiLocalPricingConfig).source === "string"
    ? (config as GeminiLocalPricingConfig).source as string
    : "manual_override";
  if (!modelConfig) return unknownPricingQuote(input, pricingSource, `No local pricing configured for this Gemini model.`);
  const price = numberValue(modelConfig.price);
  if (price === null) {
    return unknownPricingQuote(input, pricingSource, `No local pricing configured for this Gemini model.`);
  }
  const freshness = geminiManualPricingFreshness(config as GeminiLocalPricingConfig);
  if (!freshness.fresh && !allowStalePricing) {
    return {
      ...unknownPricingQuote(input, pricingSource, freshness.warning),
      pricingStatus: freshness.status,
      pricingUpdatedAt: typeof (config as GeminiLocalPricingConfig).updatedAt === "string" ? (config as GeminiLocalPricingConfig).updatedAt ?? null : null,
      pricingExpiresAt: freshness.expiresAt
    };
  }
  const count = Math.max(1, Math.floor(numberValue(input.params.n) ?? 1));
  return {
    logicalModel: input.logicalModel,
    provider: input.provider,
    providerModel: input.providerModel,
    capability: input.capability,
    estimatedCost: Number((price * count).toFixed(8)),
    currency: modelConfig.currency ?? "USD",
    pricingSource,
    confidence: modelConfig.confidence && modelConfig.confidence !== "unknown" ? modelConfig.confidence : "estimated",
    pricingStatus: freshness.status,
    pricingUpdatedAt: typeof (config as GeminiLocalPricingConfig).updatedAt === "string" ? (config as GeminiLocalPricingConfig).updatedAt ?? null : null,
    pricingExpiresAt: freshness.expiresAt,
    unit: modelConfig.unit ?? "image",
    breakdown: { price, count },
    warnings: [
      ...(modelConfig.notes ? [modelConfig.notes] : []),
      ...(!freshness.fresh && allowStalePricing ? [freshness.warning] : [])
    ]
  };
}

export async function readLocalGeminiPricingConfig(configPath = join(process.cwd(), "data", "model-pricing", "gemini.json")): Promise<GeminiLocalPricingConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as GeminiLocalPricingConfig : {};
  } catch {
    return {};
  }
}

function createGeminiModelGateway(options: GeminiClientOptions, model: string, capability: "text.generate" | "image.generate"): ModelGateway {
  return new ModelGateway({
    models: [{
      id: model,
      providerId: "gemini",
      title: model,
      capabilities: [capability],
      pricingHint: "external-provider-billing"
    }],
    adapters: [createGeminiProviderAdapter(options)],
    connections: [{
      providerId: "gemini",
      enabled: true,
      credentialRef: "provider.gemini.default",
      baseUrl: API_BASE
    }]
  });
}

function geminiGenerateResultFromGateway(result: ModelInvokeResult, model: string): GeminiGenerateResult {
  if (result.raw && typeof result.raw === "object" && "output" in result.raw) return result.raw as GeminiGenerateResult;
  return {
    model,
    output: result.output.output,
    text: typeof result.output.text === "string" ? result.output.text : undefined
  };
}

function imageAssetFromGateway(result: ModelInvokeResult): GeminiDownloadedImageAsset | undefined {
  const image = result.output.image;
  return image && typeof image === "object" ? image as GeminiDownloadedImageAsset : undefined;
}

function quoteFromGatewayOutput(output: Record<string, unknown>): PricingQuote | null {
  const quote = output.pricingQuote;
  return quote && typeof quote === "object" ? quote as PricingQuote : null;
}

function legacyCostFromQuote(quote: PricingQuote, imageSize: unknown): Record<string, unknown> {
  return {
    estimated: true,
    currency: quote.currency,
    amountUsd: quote.currency === "USD" ? quote.estimatedCost : null,
    imageSize: stringParam(imageSize) ?? "2K",
    source: quote.pricingSource,
    note: quote.confidence === "unknown" ? "No local pricing configured for this Gemini model." : "Advisory provider cost preview; final billing may differ."
  };
}

function geminiManualPricingFreshness(config: GeminiLocalPricingConfig): { fresh: boolean; status: "fresh" | "stale" | "unknown"; expiresAt: string | null; warning: string } {
  if (!config.updatedAt) {
    return {
      fresh: false,
      status: "unknown",
      expiresAt: null,
      warning: "Gemini manual pricing override has no updatedAt metadata; returning unknown pricing."
    };
  }
  const updatedMs = Date.parse(config.updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return {
      fresh: false,
      status: "unknown",
      expiresAt: null,
      warning: "Gemini manual pricing override has invalid updatedAt metadata; returning unknown pricing."
    };
  }
  const ttlHours = Number.isFinite(config.ttlHours) && Number(config.ttlHours) > 0 ? Number(config.ttlHours) : 24;
  const expiresAt = new Date(updatedMs + ttlHours * 60 * 60 * 1000).toISOString();
  const fresh = Date.now() < Date.parse(expiresAt);
  return {
    fresh,
    status: fresh ? "fresh" : "stale",
    expiresAt,
    warning: fresh ? "" : "Gemini manual pricing override is stale; returning unknown pricing."
  };
}

function buildImageGenerationPrompt(prompt: string, hasInputImage: boolean): string {
  const task = hasInputImage ? "Edit the provided image according to the user prompt." : "Generate a new image according to the user prompt.";
  return `${task}
Return an image result. Do not answer with text only.

User prompt:
${prompt}`;
}

export async function buildNanoBanana2Parts({
  prompt,
  image,
  images,
  fetchImpl
}: {
  prompt: string;
  image?: unknown;
  images?: unknown[];
  fetchImpl?: typeof fetch;
}): Promise<unknown[]> {
  const parts: unknown[] = [{ text: prompt }];
  const imageValues = images ?? (image === undefined || image === null ? [] : [image]);
  if (imageValues.length > 14) throw new Error(`gemini.nano-banana-2 accepts at most 14 input images, got ${imageValues.length}.`);
  for (const imageValue of imageValues) {
    parts.push({ inlineData: await prepareImageInlineData(imageValue, fetchImpl) });
  }
  return parts;
}

export async function prepareImageInlineData(value: unknown, fetchImpl: typeof fetch = fetch): Promise<{ mimeType: string; data: string }> {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return prepareImageInlineData(record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.image, fetchImpl);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Gemini expected image input as a local path, image object, data URI, or remote URL.");
  }

  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
    if (!match) throw new Error("Invalid data URI image input.");
    return { mimeType: match[1], data: match[2] };
  }

  if (/^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value);
    if (!response.ok) throw new Error(`Could not fetch remote image for Gemini input (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > LOCAL_FILE_DATA_URI_LIMIT_BYTES) throw new Error(`Gemini local image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_DATA_URI_LIMIT_BYTES} bytes.`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    return { mimeType, data: bytes.toString("base64") };
  }

  const bytes = await readFile(value);
  if (bytes.length > LOCAL_FILE_DATA_URI_LIMIT_BYTES) throw new Error(`Gemini local image input is too large (${bytes.length} bytes). Limit is ${LOCAL_FILE_DATA_URI_LIMIT_BYTES} bytes.`);
  return { mimeType: mimeTypeFromPath(value), data: bytes.toString("base64") };
}

async function writeGeneratedImage(
  image: { mimeType: string; dataBase64: string },
  options: { outputDirectory: string; sourceNodeId: string; model: string }
): Promise<GeminiDownloadedImageAsset> {
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const extension = extensionFromMimeType(image.mimeType);
  const filename = `${sanitizeFilename(options.sourceNodeId)}-${Date.now()}${extension}`;
  const localPath = join(assetsDirectory, filename);
  const bytes = Buffer.from(image.dataBase64, "base64");
  await writeFile(localPath, bytes);
  return {
    localPath,
    path: localPath,
    filename,
    mimeType: image.mimeType,
    sizeBytes: bytes.length,
    sourceNodeId: options.sourceNodeId,
    model: options.model
  };
}

function firstInputImage(inputs: Record<string, unknown>): unknown {
  if ("image" in inputs) return inputs.image;
  for (const value of Object.values(inputs)) {
    if (value && typeof value === "object" && "path" in value) return value;
    if (value && typeof value === "object" && "image" in value) return (value as { image: unknown }).image;
  }
  return undefined;
}

function collectInputImages(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectInputImages);
  return [value];
}

function firstInputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as Record<string, unknown>).text;
    return text === undefined || text === null ? undefined : String(text);
  }
  return String(value);
}

function firstInlineImage(value: unknown): { mimeType: string; dataBase64: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidates = (value as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates ?? [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      const inline = (record.inlineData ?? record.inline_data) as Record<string, unknown> | undefined;
      const mimeType = inline?.mimeType ?? inline?.mime_type;
      const data = inline?.data;
      if (typeof mimeType === "string" && typeof data === "string" && mimeType.startsWith("image/")) {
        return { mimeType, dataBase64: data };
      }
    }
  }
  return undefined;
}

function firstText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidates = (value as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates ?? [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return undefined;
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function truncateProviderText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function filterDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")) as Partial<T>;
}

export function estimateGeminiImageCost(imageSize: unknown): Record<string, unknown> {
  const size = stringParam(imageSize) ?? "2K";
  return {
    estimated: true,
    currency: "USD",
    amountUsd: null,
    imageSize: size,
    source: "local_pricing_config",
    note: "No local pricing configured for this Gemini image model."
  };
}

export function estimateGeminiLlmCost(model: string, output: unknown): Record<string, unknown> {
  const pricing = GEMINI_LLM_PRICING_USD_PER_MILLION_TOKENS[model];
  const usage = output && typeof output === "object" ? (output as Record<string, unknown>).usageMetadata : undefined;
  const usageRecord = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const inputTokens = numberValue(usageRecord.promptTokenCount);
  const outputTokens = numberValue(usageRecord.candidatesTokenCount);
  const amountUsd =
    pricing && inputTokens !== null && outputTokens !== null
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
      : null;

  return {
    estimated: true,
    currency: "USD",
    amountUsd: amountUsd === null ? null : Number(amountUsd.toFixed(8)),
    model,
    modelLabel: pricing?.label ?? model,
    inputTokens,
    outputTokens,
    inputUsdPerMillionTokens: pricing?.input ?? null,
    outputUsdPerMillionTokens: pricing?.output ?? null,
    source: "Gemini Developer API pricing",
    note: "Estimated provider cost for text generation; free tier, taxes, billing account settings, and provider changes may differ."
  };
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
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
  return mimeTypes[ext] ?? "application/octet-stream";
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/png") return ".png";
  return ".png";
}
