import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const LOCAL_FILE_DATA_URI_LIMIT_BYTES = 10 * 1024 * 1024;
export const NANO_BANANA_2_DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const MISSING_TOKEN_MESSAGE = "GEMINI_API_KEY is not configured.\nOpen Settings \u2192 Secrets \u2192 Gemini and paste your token.";

export interface GeminiClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
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
    }
  };
}

export function createNanoBanana2NodeRunner(options: GeminiClientOptions = {}): NodeRunner {
  const client = createGeminiClient(options);
  return async ({ node, params, inputs, context }) => {
    const model = String(params.model ?? NANO_BANANA_2_DEFAULT_MODEL);
    const prompt = firstInputText(inputs.prompt) ?? String(params.prompt ?? "Create a polished image.");
    const images = collectInputImages(params.image ?? params.images ?? inputs.images ?? firstInputImage(inputs));
    if (images.length > 14) throw new Error(`gemini.nano-banana-2 accepts at most 14 input images, got ${images.length}.`);
    const effectivePrompt = buildImageGenerationPrompt(prompt, images.length > 0);
    const parts = await buildNanoBanana2Parts({ prompt: effectivePrompt, images, fetchImpl: options.fetchImpl });
    const result = await client.generateContent(model, parts, {
      aspectRatio: stringParam(params.aspectRatio),
      imageSize: stringParam(params.imageSize)
    });
    if (!result.image) {
      throw new Error(
        `Nano Banana 2 (${model}) did not return an image.${result.text ? ` Provider text response: ${truncateProviderText(result.text)}` : ""} Try an explicit image-generation prompt.`
      );
    }
    const imageAsset = await writeGeneratedImage(result.image, {
      outputDirectory: context.outputDirectory,
      sourceNodeId: node.id,
      model
    });
    return {
      output: {
        image: imageAsset,
        output: result.output,
        text: result.text,
        model,
        cost: estimateGeminiImageCost(params.imageSize),
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
        estimatedCost: null,
        actualCost: null,
        pricingHint: "external-provider-billing"
      } satisfies ProviderUsageEvent
    };
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
    throw new Error("gemini.nano-banana-2 expected image input as a local path, image object, data URI, or remote URL.");
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
  const estimatedBySize: Record<string, number> = {
    "1K": 0.039,
    "2K": 0.039,
    "4K": 0.24
  };
  return {
    estimated: true,
    currency: "USD",
    amountUsd: estimatedBySize[size] ?? null,
    imageSize: size,
    source: "Gemini image generation public pricing hint",
    note: "Estimated provider cost for this image; final billing may differ."
  };
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
