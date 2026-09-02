import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NodeRunner } from "@snarkroute/executor";

export type LocalUpscaleWorkerError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type LocalUpscaleModel = {
  id: string;
  display_name: string;
  architecture: string;
  runtime: "onnxruntime" | "pytorch";
  file_format: "onnx" | "pth";
  scale_factor: number;
  supported_content_types: string[];
  tags: string[];
  license: string;
  license_url: string;
  source_url: string;
  estimated_vram_mb: number | null;
  recommended_tile_size: number;
  tiling_supported: boolean;
  alpha_supported: boolean;
  weights_installed: boolean;
};

export type LocalUpscaleJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled";
  stage?: string;
  progress?: number;
  model?: string;
  error?: LocalUpscaleWorkerError;
  output?: { filename: string; mime_type: "image/png"; width: number; height: number; bytes: number };
};

export class LocalUpscaleProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LocalUpscaleProviderError";
  }
}

export function createLocalUpscaleWorkerClient(options: {
  baseUrl?: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  jobTimeoutMs?: number;
  pollingIntervalMs?: number;
} = {}) {
  const baseUrl = (options.baseUrl ?? process.env.LOCAL_UPSCALE_WORKER_URL ?? "").replace(/\/$/, "");
  const fetcher = options.fetchImpl ?? fetch;

  const request = async (path: string, init: RequestInit = {}, signal?: AbortSignal) => {
    const token = options.serviceToken ?? process.env.LOCAL_UPSCALE_WORKER_TOKEN;
    if (!baseUrl) throw new LocalUpscaleProviderError("worker_not_configured", "LOCAL_UPSCALE_WORKER_URL is not configured.");
    if (!token?.trim()) throw new LocalUpscaleProviderError("worker_not_configured", "LOCAL_UPSCALE_WORKER_TOKEN is not configured.");
    const timeoutSignal = AbortSignal.timeout(options.requestTimeoutMs ?? 30_000);
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token.trim()}`, ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
    if (!response.ok) {
      const body = await response.text();
      let parsed: { error?: LocalUpscaleWorkerError; detail?: LocalUpscaleWorkerError | string } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* use the bounded response text */ }
      const detail = parsed.error ?? parsed.detail;
      if (detail && typeof detail === "object") throw new LocalUpscaleProviderError(detail.code, detail.message, detail.retryable, detail.details);
      throw new LocalUpscaleProviderError("worker_request_failed", `Local upscale worker request failed (${response.status}): ${body.slice(0, 500)}`, response.status >= 500);
    }
    return response;
  };

  return {
    configured: Boolean(baseUrl && (options.serviceToken ?? process.env.LOCAL_UPSCALE_WORKER_TOKEN)?.trim()),
    async capabilities() {
      return (await request("/v1/capabilities")).json() as Promise<{ models: LocalUpscaleModel[]; parameters: Array<Record<string, unknown>> }>;
    },
    async upload(data: Uint8Array, filename: string, mimeType: string, signal?: AbortSignal) {
      return (await request("/v1/assets", { method: "POST", body: new Uint8Array(data).buffer, headers: { "Content-Type": mimeType, "X-Filename": filename } }, signal)).json() as Promise<{ id: string }>;
    },
    async create(input: Record<string, unknown>, signal?: AbortSignal) {
      return (await request("/v1/jobs", { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } }, signal)).json() as Promise<LocalUpscaleJob>;
    },
    async get(id: string, signal?: AbortSignal) {
      return (await request(`/v1/jobs/${encodeURIComponent(id)}`, {}, signal)).json() as Promise<LocalUpscaleJob>;
    },
    async cancel(id: string) {
      return (await request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).json() as Promise<LocalUpscaleJob>;
    },
    async download(id: string, signal?: AbortSignal) {
      return (await request(`/v1/jobs/${encodeURIComponent(id)}/content`, { headers: { Accept: "image/png" } }, signal)).arrayBuffer();
    },
    async run(input: Record<string, unknown>, control: { signal?: AbortSignal; onProgress?: (progress: number, stage?: string) => void | Promise<void> } = {}) {
      const created = await this.create(input, control.signal);
      const started = Date.now();
      const abort = () => { void this.cancel(created.id).catch(() => undefined); };
      control.signal?.addEventListener("abort", abort, { once: true });
      try {
        let job = created;
        while (!isTerminal(job.status)) {
          if (control.signal?.aborted) throw new LocalUpscaleProviderError("cancelled", "Local upscale job was cancelled.");
          if (Date.now() - started > (options.jobTimeoutMs ?? 30 * 60_000)) {
            await this.cancel(created.id).catch(() => undefined);
            throw new LocalUpscaleProviderError("timeout", `Local upscale job ${created.id} timed out.`, true);
          }
          await delay(options.pollingIntervalMs ?? 200);
          job = await this.get(created.id, control.signal);
          await control.onProgress?.(job.progress ?? 0, job.stage);
        }
        if (job.status === "failed") throw new LocalUpscaleProviderError(job.error?.code ?? "worker_failed", job.error?.message ?? "Local upscale worker failed.", job.error?.retryable ?? false, job.error?.details);
        if (job.status === "cancelled") throw new LocalUpscaleProviderError("cancelled", "Local upscale job was cancelled.");
        return job;
      } finally {
        control.signal?.removeEventListener("abort", abort);
      }
    }
  };
}

export function createLocalUpscaleNodeRunner(options: Parameters<typeof createLocalUpscaleWorkerClient>[0] = {}): NodeRunner {
  const client = createLocalUpscaleWorkerClient(options);
  return async ({ node, params, inputs, context }) => {
    const source = firstImage(params.image ?? params.images ?? inputs.image ?? inputs.images);
    if (!source) throw new LocalUpscaleProviderError("invalid_input", "local_upscale requires one PNG or JPEG image input.");
    const bytes = await readFile(source.path);
    const uploaded = await client.upload(bytes, source.filename ?? basename(source.path), source.mimeType ?? mimeFromPath(source.path), context.signal);
    const model = String(params.model ?? "").trim();
    const job = await client.run({
      model,
      input_asset: uploaded.id,
      scale: optionalNumber(params.scale),
      tile_size: optionalNumber(params.tile_size ?? params.tileSize),
      tile_overlap: optionalNumber(params.tile_overlap ?? params.tileOverlap),
      device: typeof params.device === "string" ? params.device : undefined,
      options: objectRecord(params.options)
    }, { signal: context.signal, onProgress: context.reportProgress });
    await mkdir(join(context.outputDirectory, "assets"), { recursive: true });
    const filename = `${node.id}-${job.id}.png`;
    const path = join(context.outputDirectory, "assets", filename);
    await writeFile(path, Buffer.from(await client.download(job.id, context.signal)));
    const image = { path, localPath: path, filename, mimeType: "image/png", width: job.output?.width, height: job.output?.height, sizeBytes: job.output?.bytes };
    return {
      output: { image, images: [image], provider: "local_upscale", model, providerJobId: job.id, estimatedCost: 0, actualCost: 0 },
      provenance: { provider: "local_upscale", model },
      providerUsage: { provider: "local_upscale", model, nodeId: node.id, nodeType: node.type, externalId: job.id, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" }
    };
  };
}

function firstImage(value: unknown): { path: string; filename?: string; mimeType?: string } | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string" && candidate.trim()) return { path: candidate };
  if (!candidate || typeof candidate !== "object") return null;
  const descriptor = candidate as Record<string, unknown>;
  const path = typeof descriptor.localPath === "string" ? descriptor.localPath : typeof descriptor.path === "string" ? descriptor.path : "";
  return path ? { path, filename: typeof descriptor.filename === "string" ? descriptor.filename : undefined, mimeType: typeof descriptor.mimeType === "string" ? descriptor.mimeType : undefined } : null;
}
function isTerminal(status: LocalUpscaleJob["status"]) { return ["succeeded", "completed", "failed", "cancelled"].includes(status); }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function mimeFromPath(path: string) { return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png"; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
