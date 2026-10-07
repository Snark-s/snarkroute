import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { failedProviderConnection, ModelGateway, verifiedProviderConnection, type ModelInvokeResult, type ProviderAdapter } from "@snarkroute/core";
import type { NodeRunner, ProviderUsageEvent } from "@snarkroute/executor";

const API_BASE = "https://api.replicate.com/v1";
const LOCAL_FILE_DATA_URI_LIMIT_BYTES = 256 * 1024;
const CLARITY_MODEL = "philz1337x/clarity-upscaler";
const MISSING_TOKEN_MESSAGE = "REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token.";

export interface ReplicateClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  modelGateway?: Pick<ModelGateway, "invoke">;
}

export interface RunPredictionOptions {
  pollingIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (prediction: { id: string; status: string }) => void | Promise<void>;
}

export interface ReplicatePredictionResult {
  predictionId: string;
  model: string;
  input: object;
  output: unknown;
  logs?: string;
  error?: unknown;
  status: string;
  metrics?: Record<string, unknown>;
  webUrl?: string;
}

export interface DownloadedImageAsset {
  originalUrl: string;
  localPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceNodeId: string;
  predictionId: string;
}

export interface DownloadedModelAsset {
  originalUrl: string;
  localPath: string;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceNodeId: string;
  predictionId: string;
}

export function createReplicateClient(options: ReplicateClientOptions = {}) {
  const fetcher = options.fetchImpl ?? fetch;

  async function request(path: string, init: RequestInit = {}) {
    const token = options.token ?? process.env.REPLICATE_API_TOKEN;
    if (!token?.trim()) throw new Error(MISSING_TOKEN_MESSAGE);
    let response: Response;
    try {
      response = await fetcher(`${API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Replicate API is unreachable while ${replicateRequestLabel(path)}: ${message}. Check internet access and Replicate availability.`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Replicate request failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  return {
    async testConnection(): Promise<{ ok: true }> {
      const account = await request("/account", { signal: AbortSignal.timeout(10_000) });
      if (!account || typeof account !== "object" || typeof (account as Record<string, unknown>).username !== "string") {
        throw new Error("Replicate returned a malformed account response.");
      }
      return { ok: true };
    },
    async getModelSchema(model: string) {
      const [owner, name] = parseModel(model);
      return request(`/models/${owner}/${name}`);
    },

    async createPrediction(model: string, input: object) {
      const version = await this.resolveVersion(model);
      return request("/predictions", {
        method: "POST",
        body: JSON.stringify({ version, input })
      });
    },

    async resolveVersion(model: string) {
      if (/^[a-f0-9]{32,}$/i.test(model)) return model;
      const schema = await this.getModelSchema(model);
      const version = schema.latest_version?.id ?? schema.default_example?.version;
      if (!version) throw new Error(`Replicate model "${model}" does not expose latest_version.id.`);
      return version;
    },

    async uploadFile(path: string) {
      const token = options.token ?? process.env.REPLICATE_API_TOKEN;
      if (!token?.trim()) throw new Error(MISSING_TOKEN_MESSAGE);
      const buffer = await readFile(path);
      const mimeType = mimeFromPath(path);
      const form = new FormData();
      form.append("content", new Blob([buffer], { type: mimeType }), basename(path));
      form.append("filename", basename(path));
      form.append("type", mimeType);
      form.append("metadata", JSON.stringify({ source: "snarkroute" }));
      let response: Response;
      try {
        response = await fetcher(`${API_BASE}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token.trim()}` },
          body: form
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Replicate file upload failed: ${message}.`);
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Replicate file upload failed (${response.status}): ${body}`);
      }
      const file = await response.json() as Record<string, unknown>;
      const urls = file.urls && typeof file.urls === "object" ? file.urls as Record<string, unknown> : {};
      const url = typeof urls.get === "string" ? urls.get : undefined;
      if (!url) throw new Error("Replicate file upload returned no file URL.");
      return url;
    },

    async getPrediction(predictionId: string) {
      return request(`/predictions/${predictionId}`);
    },

    async cancelPrediction(predictionId: string) {
      return request(`/predictions/${predictionId}/cancel`, { method: "POST" });
    },

    async runPrediction(model: string, input: object, runOptions: RunPredictionOptions = {}): Promise<ReplicatePredictionResult> {
      const pollingIntervalMs = runOptions.pollingIntervalMs ?? 1000;
      const timeoutMs = runOptions.timeoutMs ?? 120000;
      const started = Date.now();
      const created = await this.createPrediction(model, input);
      let prediction = created;
      await runOptions.onStatus?.({ id: String(prediction.id ?? ""), status: String(prediction.status ?? "starting") });

      while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
        if (runOptions.signal?.aborted) {
          if (prediction.id) {
            try { await this.cancelPrediction(prediction.id); } catch {}
          }
          throw new Error(`Replicate prediction cancelled${prediction.id ? ` (predictionId: ${prediction.id})` : ""}`);
        }
        if (Date.now() - started > timeoutMs) {
          if (prediction.id) {
            try { await this.cancelPrediction(prediction.id); } catch {}
          }
          throw new Error(`Replicate prediction timed out for model "${model}" after ${timeoutMs}ms${prediction.id ? ` (predictionId: ${prediction.id})` : ""}`);
        }
        await delay(pollingIntervalMs);
        prediction = await this.getPrediction(prediction.id);
        await runOptions.onStatus?.({ id: String(prediction.id ?? ""), status: String(prediction.status ?? "processing") });
      }

      return {
        predictionId: prediction.id,
        model,
        input,
        output: prediction.output,
        logs: prediction.logs,
        error: prediction.error,
        status: prediction.status,
        metrics: prediction.metrics,
        webUrl: prediction.urls?.web
      };
    }
  };
}

export function createReplicateNodeRunner(options: ReplicateClientOptions = {}): NodeRunner {
  return async ({ node, params }) => {
    const model = String(params.model ?? "");
    if (!model) throw new Error("replicate.model requires params.model.");
    const input = (await prepareReplicateInputs(asObject(params.input ?? {}))) as Record<string, unknown>;
    const gateway = options.modelGateway ?? createReplicateModelGateway(options, model);
    const gatewayResult = await gateway.invoke({
      capability: "image.generate",
      modelRef: `model://replicate/${model}`,
      input,
      parameters: {
        pollingIntervalMs: Number(params.pollingIntervalMs ?? 1000),
        timeoutMs: Number(params.timeoutMs ?? 120000)
      },
      metadata: { nodeId: node.id, nodeType: node.type }
    });
    const result = replicatePredictionFromGateway(gatewayResult, model, input);
    if (result.status !== "succeeded") {
      throw new Error(`Replicate prediction ${result.status}: ${result.error ?? "unknown error"}`);
    }
    return {
      output: {
        predictionId: result.predictionId,
        output: result.output,
        status: result.status,
        metrics: result.metrics,
        webUrl: result.webUrl
      },
      logs: result.logs ? [result.logs] : [],
      metrics: result.metrics,
      provenance: { provider: "replicate", model },
      providerUsage: replicateProviderUsage(result, node.id, node.type)
    };
  };
}

export function createReplicate3DNodeRunner(options: ReplicateClientOptions = {}): NodeRunner {
  return async ({ node, params, context }) => {
    const client = createReplicateClient(options);
    const model = String(params.providerModelId ?? params.model ?? "tencent/hunyuan-3d-3.1").trim();
    if (!model) throw new Error("ai.3d.generate requires a Replicate model id.");

    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    const images = Array.isArray(params.images) ? params.images : [];
    const firstImage = images[0];
    const input: Record<string, unknown> = {};
    const isTrellis = /(?:^|\/)trellis(?:$|[-_.])/i.test(model) || /firtoz\/trellis/i.test(model);

    if (isTrellis) {
      if (!firstImage) throw new Error("TRELLIS 3D generation requires an image input.");
      const prepared = await prepareImageValue(firstImage, client);
      input.images = [prepared];
      input.generate_model = true;
      input.generate_color = false;
      input.generate_normal = Boolean(params.generate_normal ?? params.generateNormal ?? false);
      input.save_gaussian_ply = Boolean(params.save_gaussian_ply ?? params.saveGaussianPly ?? false);
      input.return_no_background = false;
      const textureSize = Number(params.texture_size ?? params.textureSize ?? 1024);
      input.texture_size = Math.max(512, Math.min(2048, Math.round(Number.isFinite(textureSize) ? textureSize : 1024)));
      const simplify = Number(params.mesh_simplify ?? params.meshSimplify ?? 0.95);
      input.mesh_simplify = Math.max(0.9, Math.min(0.98, Number.isFinite(simplify) ? simplify : 0.95));
    } else {
      if (firstImage) input.image = await prepareImageValue(firstImage, client);
      else if (prompt) input.prompt = prompt;
      else throw new Error("3D generation requires either a prompt or one image.");

      if (firstImage && prompt) {
        // Hunyuan 3D 3.1 accepts either prompt OR image. The image is the
        // stronger geometric constraint, so keep it and omit prompt.
      }

      const faceCount = Number(params.face_count ?? params.faceCount ?? 500000);
      if (Number.isFinite(faceCount)) input.face_count = Math.max(40000, Math.min(1500000, Math.round(faceCount)));
      input.enable_pbr = Boolean(params.enable_pbr ?? params.enablePbr ?? true);
      input.generate_type = String(params.generate_type ?? params.generateType ?? "Normal");
    }

    const result = await client.runPrediction(model, input, {
      pollingIntervalMs: Number(params.pollingIntervalMs ?? 1000),
      timeoutMs: Number(params.timeoutMs ?? 900000),
      signal: context.signal,
      onStatus: async (prediction) => {
        const progress = prediction.status === "succeeded" ? 1
          : prediction.status === "processing" ? 0.55
          : prediction.status === "starting" ? 0.1
          : 0.2;
        await context.reportProgress?.(progress, prediction.id ? `provider_job:${prediction.id}` : prediction.status);
      }
    });
    if (result.status !== "succeeded") {
      throw new Error(`Replicate 3D prediction ${result.status}: ${result.error ?? "unknown error"}`);
    }

    const originalUrl = firstModelUrl(result.output);
    if (!originalUrl) throw new Error("Replicate 3D generation succeeded but returned no downloadable model URL.");
    const modelAsset = await downloadPredictionModel(originalUrl, {
      outputDirectory: context.outputDirectory,
      sourceNodeId: node.id,
      predictionId: result.predictionId,
      fetchImpl: options.fetchImpl
    });
    const cost = estimateReplicateCost(result.metrics, params.estimated_usd_per_second);
    return {
      output: {
        model: modelAsset,
        models: [modelAsset],
        predictionId: result.predictionId,
        status: result.status,
        metrics: result.metrics,
        cost,
        provider: "replicate",
        providerModelId: model
      },
      logs: [`Downloaded Replicate 3D output to ${modelAsset.localPath}`],
      metrics: result.metrics,
      provenance: { provider: "replicate", model },
      providerUsage: replicateProviderUsage(result, node.id, node.type)
    };
  };
}

export function createReplicateProviderAdapter(options: ReplicateClientOptions = {}): ProviderAdapter {
  const client = createReplicateClient(options);
  return {
    id: "replicate",
    title: "Replicate",
    capabilities: ["image.generate", "image.upscale"],
    async testConnection() {
      try {
        await client.testConnection();
        return verifiedProviderConnection("Replicate credentials verified.");
      } catch (error) {
        return failedProviderConnection("Replicate", error);
      }
    },
    async invoke(request) {
      const input = asObject(request.input);
      const result = await client.runPrediction(request.model.id, input, {
        pollingIntervalMs: Number(request.parameters?.pollingIntervalMs ?? 1000),
        timeoutMs: Number(request.parameters?.timeoutMs ?? 120000)
      });
      if (result.status !== "succeeded") {
        throw new Error(`Replicate prediction ${result.status}: ${result.error ?? "unknown error"}`);
      }
      return {
        modelId: request.model.id,
        providerId: "replicate",
        capability: request.capability,
        output: {
          predictionId: result.predictionId,
          output: result.output,
          status: result.status,
          metrics: result.metrics,
          webUrl: result.webUrl
        },
        usage: result.metrics,
        raw: result
      };
    }
  };
}

function createReplicateModelGateway(options: ReplicateClientOptions, model: string, capability: "image.generate" | "image.upscale" = "image.generate"): ModelGateway {
  return new ModelGateway({
    models: [{
      id: model,
      providerId: "replicate",
      title: model,
      capabilities: [capability],
      inputTypes: ["object"],
      outputTypes: ["prediction"],
      pricingHint: "external-provider-billing"
    }],
    adapters: [createReplicateProviderAdapter(options)],
    connections: [{
      providerId: "replicate",
      enabled: true,
      credentialRef: "provider.replicate.default",
      baseUrl: API_BASE
    }]
  });
}

function replicatePredictionFromGateway(gatewayResult: ModelInvokeResult, model: string, input: object): ReplicatePredictionResult {
  const raw = gatewayResult.raw;
  if (raw && typeof raw === "object" && "predictionId" in raw) return raw as ReplicatePredictionResult;
  return {
    predictionId: String(gatewayResult.output.predictionId ?? ""),
    model,
    input,
    output: gatewayResult.output.output,
    status: String(gatewayResult.output.status ?? "succeeded"),
    metrics: gatewayResult.output.metrics && typeof gatewayResult.output.metrics === "object" ? gatewayResult.output.metrics as Record<string, unknown> : undefined,
    webUrl: typeof gatewayResult.output.webUrl === "string" ? gatewayResult.output.webUrl : undefined
  };
}

export function createClarityUpscalerNodeRunner(options: ReplicateClientOptions = {}): NodeRunner {
  return async ({ node, params, inputs, context }) => {
    const image = params.image ?? firstInputImage(inputs);
    if (!image) throw new Error("replicate.clarity-upscaler requires an image input. Use params.image or connect input.image.");
    const prompt = firstInputText(inputs.prompt);
    const input = await buildClarityInput(prompt === undefined ? params : { ...params, prompt }, image);
    const gateway = options.modelGateway ?? createReplicateModelGateway(options, CLARITY_MODEL, "image.upscale");
    const gatewayResult = await gateway.invoke({
      capability: "image.upscale",
      modelRef: `model://replicate/${CLARITY_MODEL}`,
      input,
      parameters: {
        pollingIntervalMs: Number(params.pollingIntervalMs ?? 1000),
        timeoutMs: Number(params.timeoutMs ?? 120000)
      },
      metadata: { nodeId: node.id, nodeType: node.type }
    });
    const result = replicatePredictionFromGateway(gatewayResult, CLARITY_MODEL, input);
    if (result.status !== "succeeded") {
      throw new Error(`Clarity Upscaler prediction ${result.status} (predictionId: ${result.predictionId}): ${result.error ?? "unknown error"}${result.logs ? `\n${result.logs}` : ""}`);
    }
    const originalUrl = firstImageUrl(result.output);
    if (!originalUrl) throw new Error("Clarity Upscaler succeeded but did not return an image URL.");
    const imageAsset = await downloadPredictionImage(originalUrl, {
      outputDirectory: context.outputDirectory,
      sourceNodeId: node.id,
      predictionId: result.predictionId,
      fetchImpl: options.fetchImpl
    });
    const cost = estimateReplicateCost(result.metrics, params.estimated_usd_per_second);
    return {
      output: {
        image: imageAsset,
        output: result.output,
        predictionId: result.predictionId,
        status: result.status,
        metrics: result.metrics,
        cost,
        localPath: imageAsset.localPath,
        originalUrl
      },
      logs: [`Downloaded Clarity output to ${imageAsset.localPath}`],
      metrics: result.metrics,
      provenance: { provider: "replicate", model: CLARITY_MODEL },
      providerUsage: replicateProviderUsage(result, node.id, node.type)
    };
  };
}

function replicateProviderUsage(result: ReplicatePredictionResult, nodeId: string, nodeType: string): ProviderUsageEvent {
  return {
    provider: "replicate",
    model: result.model,
    nodeId,
    nodeType,
    externalId: result.predictionId,
    status: result.status,
    metrics: result.metrics,
    estimatedCost: null,
    actualCost: null,
    pricingHint: "external-provider-billing"
  };
}

export function estimateReplicateCost(metrics: Record<string, unknown> | undefined, usdPerSecondInput: unknown): Record<string, unknown> | undefined {
  const seconds = numberFromUnknown(metrics?.predict_time ?? metrics?.total_time);
  const usdPerSecond = numberFromUnknown(usdPerSecondInput) ?? 0.0014;
  if (seconds === undefined) return undefined;
  return {
    estimated: true,
    currency: "USD",
    seconds,
    usdPerSecond,
    amountUsd: Number((seconds * usdPerSecond).toFixed(6)),
    source: "Replicate prediction metrics",
    note: "Estimated from Replicate prediction metrics; final billing may differ."
  };
}

export async function buildClarityInput(params: Record<string, unknown>, image: unknown): Promise<Record<string, unknown>> {
  return filterDefined({
    image: await prepareImageValue(image),
    prompt: params.prompt ?? "masterpiece, best quality, highres",
    negative_prompt: params.negative_prompt ?? "(worst quality, low quality, normal quality:2)",
    scale_factor: numberParam(params.scale_factor, 2),
    dynamic: numberParam(params.dynamic, 6),
    creativity: numberParam(params.creativity, 0.35),
    resemblance: numberParam(params.resemblance, 0.6),
    tiling_width: numberParam(params.tiling_width, 112),
    tiling_height: numberParam(params.tiling_height, 144),
    scheduler: params.scheduler ?? "DPM++ 3M SDE Karras",
    num_inference_steps: numberParam(params.num_inference_steps, 18),
    seed: numberParam(params.seed, 1337),
    downscaling: Boolean(params.downscaling ?? false),
    downscaling_resolution: numberParam(params.downscaling_resolution, 768),
    lora_links: params.lora_links ?? ""
  });
}

export async function prepareReplicateInputs(input: unknown): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map((item) => prepareReplicateInputs(item)));
  if (input && typeof input === "object") {
    const entries = await Promise.all(
      Object.entries(input).map(async ([key, value]) => [
        key,
        key.toLowerCase().includes("image") ? await prepareImageValue(value) : await prepareReplicateInputs(value)
      ])
    );
    return Object.fromEntries(entries);
  }
  return input;
}

type ReplicateFileUploader = { uploadFile(path: string): Promise<string> };

export async function prepareImageValue(value: unknown, uploader?: ReplicateFileUploader): Promise<string> {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
    return localFileToReplicateInput(value, uploader);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = record.localPath ?? record.path ?? record.url ?? record.originalUrl;
    if (typeof candidate === "string") return prepareImageValue(candidate, uploader);
  }
  throw new Error("Expected image input to be an image object, local path string, data URI, or remote URL.");
}

export async function downloadPredictionImage(
  url: string,
  options: { outputDirectory: string; sourceNodeId: string; predictionId: string; fetchImpl?: typeof fetch }
): Promise<DownloadedImageAsset> {
  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not download Replicate output image from ${url}: ${message}.`);
  }
  if (!response.ok) throw new Error(`Could not download Replicate output image (${response.status}).`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? mimeFromPath(url);
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${options.sourceNodeId}-${options.predictionId}${extensionForMime(mimeType)}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, buffer);
  const metadata: DownloadedImageAsset = {
    originalUrl: url,
    localPath,
    filename,
    mimeType,
    sizeBytes: buffer.byteLength,
    sourceNodeId: options.sourceNodeId,
    predictionId: options.predictionId
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export async function downloadPredictionModel(
  url: string,
  options: { outputDirectory: string; sourceNodeId: string; predictionId: string; fetchImpl?: typeof fetch }
): Promise<DownloadedModelAsset> {
  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not download Replicate 3D output from ${url}: ${message}.`);
  }
  if (!response.ok) throw new Error(`Could not download Replicate 3D output (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "model/gltf-binary";
  const urlPath = new URL(url).pathname;
  const rawExt = extname(urlPath).toLowerCase();
  const ext = rawExt === ".glb" || rawExt === ".gltf" ? rawExt : ".glb";
  const assetsDirectory = join(options.outputDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const filename = `${options.sourceNodeId}-${options.predictionId}${ext}`;
  const localPath = join(assetsDirectory, filename);
  await writeFile(localPath, buffer);
  const metadata: DownloadedModelAsset = {
    originalUrl: url,
    localPath,
    path: localPath,
    filename,
    mimeType: contentType === "application/octet-stream" ? "model/gltf-binary" : contentType,
    sizeBytes: buffer.byteLength,
    sourceNodeId: options.sourceNodeId,
    predictionId: options.predictionId
  };
  await writeFile(join(assetsDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

function parseModel(model: string): [string, string] {
  const [owner, name] = model.split("/");
  if (!owner || !name) throw new Error(`Invalid Replicate model "${model}". Expected owner/name.`);
  return [owner, name];
}

function asObject(value: unknown): object {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error("Replicate input must be an object.");
}

function replicateRequestLabel(path: string): string {
  if (path.startsWith("/models/")) return "reading model schema";
  if (path === "/predictions") return "creating prediction";
  if (path.startsWith("/predictions/")) return "polling prediction";
  return "calling Replicate";
}

async function localFileToReplicateInput(path: string, uploader?: ReplicateFileUploader): Promise<string> {
  const buffer = await readFile(path);
  if (buffer.byteLength > LOCAL_FILE_DATA_URI_LIMIT_BYTES) {
    if (!uploader) {
      throw new Error(`Local image is too large for data URI upload (${buffer.byteLength} bytes). No Replicate file uploader is available.`);
    }
    return uploader.uploadFile(path);
  }
  return `data:${mimeFromPath(path)};base64,${buffer.toString("base64")}`;
}

function firstInputImage(inputs: Record<string, unknown>): unknown {
  if ("image" in inputs) return inputs.image;
  for (const value of Object.values(inputs)) {
    if (value && typeof value === "object" && "path" in value) return value;
    if (value && typeof value === "object" && "image" in value) return (value as { image: unknown }).image;
    if (typeof value === "string") return value;
  }
  return undefined;
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

function firstImageUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.find((item): item is string => typeof item === "string");
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of ["image", "url", "output"]) {
      const url = firstImageUrl(record[key]);
      if (url) return url;
    }
  }
  return undefined;
}

function firstModelUrl(output: unknown): string | undefined {
  if (typeof output === "string") {
    return /\.glb(?:$|[?#])/i.test(output) || /\.gltf(?:$|[?#])/i.test(output) ? output : undefined;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const url=firstModelUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (output && typeof output === "object") {
    const record=output as Record<string, unknown>;
    // Provider-specific model fields first. TRELLIS returns model_file.
    for (const key of ["model_file","modelFile","glb","gltf","model","url","output"]) {
      const url=firstModelUrl(record[key]);
      if (url) return url;
    }
  }
  return undefined;
}

function filterDefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function numberParam(value: unknown, fallback: number): number {
  const normalized = typeof value === "string" ? value.replace(",", ".") : value;
  const number = Number(normalized ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function numberFromUnknown(value: unknown): number | undefined {
  const normalized = typeof value === "string" ? value.replace(",", ".") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function mimeFromPath(path: string): string {
  const ext = extname(path.split("?")[0]).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  return "image/png";
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
