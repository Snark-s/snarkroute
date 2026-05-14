import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

export const POLZA_BASE_URL = "https://polza.ai/api";
export const POLZA_TEXT_DEFAULT_MODEL = "openai/gpt-4o";
export const POLZA_IMAGE_DEFAULT_MODEL = "openai/gpt-5.4-image-2";
export const POLZA_MISSING_KEY_MESSAGE = "POLZA_AI_API_KEY is not configured.\nAdd POLZA_AI_API_KEY to .env with your Polza.ai API key.";

export interface PolzaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
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
    async getModels(type?: "chat" | "image" | "embedding"): Promise<PolzaModelInfo[]> {
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
  const client = createPolzaClient(options);
  return async ({ node, params, inputs }) => {
    const model = stringParam(params.model) ?? POLZA_TEXT_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Polza Text requires a prompt.");
    const systemPrompt = firstInputText(inputs.systemPrompt) ?? stringParam(params.systemPrompt);
    const messages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: prompt }
    ];
    const response = await client.chatCompletions(buildChatRequestBody(model, messages, params));
    const text = firstChatText(response);
    if (!text) throw new Error(`Polza text model "${model}" did not return text.`);
    const usage = objectField(response, "usage");
    return {
      output: {
        text,
        output: response,
        provider: "polza",
        model,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        pricingSource: "polza_usage",
        status: "succeeded"
      },
      logs: [`Generated text with Polza ${model}`],
      provenance: { provider: "polza", model },
      providerUsage: polzaUsageEvent(node.id, node.type, model, "succeeded", usage)
    };
  };
}

export function createPolzaImageNodeRunner(options: PolzaClientOptions = {}): NodeRunner {
  const client = createPolzaClient(options);
  return async ({ node, params, inputs, context }) => {
    const model = stringParam(params.model) ?? POLZA_IMAGE_DEFAULT_MODEL;
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("Polza Image requires a prompt.");
    const request = buildMediaImageRequestBody(model, prompt, params);
    const response = await client.media(request);
    const image = firstGeneratedImage(response);
    if (!image) {
      const pendingId = stringField(response, "id");
      const status = stringField(response, "status");
      if (pendingId) throw new Error(`Polza image generation is ${status || "pending"} (${pendingId}). Async polling is not supported by this node yet.`);
      throw new Error(`Polza image model "${model}" did not return an image.`);
    }
    const imageAsset = await writePolzaImage(image, {
      outputDirectory: context.outputDirectory,
      sourceNodeId: node.id,
      model,
      fetchImpl: options.fetchImpl
    });
    const usage = objectField(response, "usage");
    return {
      output: {
        image: imageAsset,
        output: response,
        request,
        provider: "polza",
        model,
        actualUsage: usage,
        actualCost: actualCostFromUsage(usage),
        pricingSource: "polza_usage",
        localPath: imageAsset.localPath,
        originalUrl: imageAsset.originalUrl,
        warning: imageAsset.warning,
        status: "succeeded"
      },
      logs: [`Generated Polza image with ${model}: ${imageAsset.localPath ?? imageAsset.originalUrl ?? imageAsset.path}`],
      provenance: { provider: "polza", model },
      providerUsage: polzaUsageEvent(node.id, node.type, model, "succeeded", usage)
    };
  };
}

export function buildChatRequestBody(model: string, messages: Array<{ role: string; content: string }>, params: Record<string, unknown>): Record<string, unknown> {
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

export function buildMediaImageRequestBody(model: string, prompt: string, params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt };
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

function isPolzaGpt54Image2(model: string): boolean {
  return model === "openai/gpt-5.4-image-2";
}

function isPolzaGptImage15(model: string): boolean {
  return model === "openai/gpt-image-1.5";
}

function isPolzaOpenAiImageWithoutAspectRatio(model: string): boolean {
  return model === "openai/gpt-5-image" || model === "openai/gpt-5-image-mini";
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

function looksLikeImageReference(value: string): boolean {
  return value.startsWith("data:image/") || /^https?:\/\//i.test(value) || /^[A-Za-z0-9+/]+=*$/.test(value.slice(0, 80));
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

function polzaUsageEvent(nodeId: string, nodeType: string, model: string, status: string, usage: unknown): ProviderUsageEvent {
  return {
    provider: "polza",
    model,
    nodeId,
    nodeType,
    status,
    metrics: usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined,
    estimatedCost: null,
    actualCost: actualCostFromUsage(usage),
    pricingHint: "polza_usage"
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
