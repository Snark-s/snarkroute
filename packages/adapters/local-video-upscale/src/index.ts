import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { NodeRunner } from "@snarkroute/executor";

export type LocalVideoUpscaleModel = {
  id: string;
  display_name: string;
  architecture: string;
  runtime: "pytorch" | "onnxruntime";
  file_format: "pth" | "onnx";
  native_scale: number;
  temporal: boolean;
  context_frames: number;
  recurrent: string;
  supported_pixel_formats: string[];
  supported_content_types: string[];
  supported_output_codecs: string[];
  supported_output_containers: string[];
  license: string;
  license_url: string;
  source_url: string;
  checkpoint_source: string;
  estimated_vram_mb: number | null;
  recommended_chunk_size: number;
  recommended_tile_size: number | null;
  spatial_tiling_supported: boolean;
  framewise_model_id: string | null;
  notes: string;
  weights_installed: boolean;
};

export type LocalVideoUpscaleJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage?: string;
  progress?: number;
  model?: string;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  output?: {
    filename: string;
    mime_type: "video/mp4";
    width: number;
    height: number;
    fps: number;
    frame_count: number;
    duration: number;
    codec: string;
    pixel_format: string;
    audio_preserved: boolean;
    audio_codec?: string;
    bytes: number;
    temporal: boolean;
    processing_seconds: number;
    processing_fps: number;
    peak_vram_mb: number | null;
  };
};

export class LocalVideoUpscaleProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "LocalVideoUpscaleProviderError";
  }
}

export function createLocalVideoUpscaleWorkerClient(options: {
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
    if (!baseUrl || !token?.trim()) throw new LocalVideoUpscaleProviderError("worker_not_configured", "The local upscale worker URL/token is not configured.");
    const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 30_000);
    const response = await fetcher(`${baseUrl}/v1/video${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token.trim()}`, ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) {
      const body = await response.text();
      let parsed: { error?: LocalVideoUpscaleJob["error"] } = {};
      try { parsed = JSON.parse(body) as typeof parsed; } catch { /* bounded text below */ }
      if (parsed.error) throw new LocalVideoUpscaleProviderError(parsed.error.code, parsed.error.message, parsed.error.retryable, parsed.error.details);
      throw new LocalVideoUpscaleProviderError("worker_request_failed", `Local video upscale worker request failed (${response.status}): ${body.slice(0, 500)}`, response.status >= 500);
    }
    return response;
  };
  return {
    configured: Boolean(baseUrl && (options.serviceToken ?? process.env.LOCAL_UPSCALE_WORKER_TOKEN)?.trim()),
    async capabilities() {
      return (await request("/capabilities")).json() as Promise<{ models: LocalVideoUpscaleModel[]; parameters: Array<Record<string, unknown>> }>;
    },
    async upload(data: Uint8Array, filename: string, mimeType: string, signal?: AbortSignal) {
      return (await request("/assets", { method: "POST", body: new Uint8Array(data).buffer, headers: { "Content-Type": mimeType, "X-Filename": filename } }, signal)).json() as Promise<{ id: string }>;
    },
    async create(input: Record<string, unknown>, signal?: AbortSignal) {
      return (await request("/jobs", { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } }, signal)).json() as Promise<LocalVideoUpscaleJob>;
    },
    async get(id: string, signal?: AbortSignal) {
      return (await request(`/jobs/${encodeURIComponent(id)}`, {}, signal)).json() as Promise<LocalVideoUpscaleJob>;
    },
    async cancel(id: string) {
      return (await request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).json() as Promise<LocalVideoUpscaleJob>;
    },
    async download(id: string, signal?: AbortSignal) {
      return (await request(`/jobs/${encodeURIComponent(id)}/content`, { headers: { Accept: "video/mp4" } }, signal)).arrayBuffer();
    },
    async run(input: Record<string, unknown>, control: { signal?: AbortSignal; onProgress?: (progress: number, stage?: string) => void | Promise<void> } = {}) {
      const created = await this.create(input, control.signal);
      const started = Date.now();
      const abort = () => { void this.cancel(created.id).catch(() => undefined); };
      control.signal?.addEventListener("abort", abort, { once: true });
      try {
        let job = created;
        while (!["succeeded", "failed", "cancelled"].includes(job.status)) {
          if (control.signal?.aborted) throw new LocalVideoUpscaleProviderError("cancelled", "Local video upscale job was cancelled.");
          if (Date.now() - started > (options.jobTimeoutMs ?? 2 * 60 * 60_000)) {
            await this.cancel(created.id).catch(() => undefined);
            throw new LocalVideoUpscaleProviderError("timeout", `Local video upscale job ${created.id} timed out.`, true);
          }
          await new Promise((resolve) => setTimeout(resolve, options.pollingIntervalMs ?? 250));
          job = await this.get(created.id, control.signal);
          await control.onProgress?.(job.progress ?? 0, job.stage);
        }
        if (job.status === "failed") throw new LocalVideoUpscaleProviderError(job.error?.code ?? "worker_failed", job.error?.message ?? "Local video upscale worker failed.", job.error?.retryable ?? false, job.error?.details);
        if (job.status === "cancelled") throw new LocalVideoUpscaleProviderError("cancelled", "Local video upscale job was cancelled.");
        return job;
      } finally {
        control.signal?.removeEventListener("abort", abort);
      }
    }
  };
}

export function createLocalVideoUpscaleNodeRunner(options: Parameters<typeof createLocalVideoUpscaleWorkerClient>[0] = {}): NodeRunner {
  const client = createLocalVideoUpscaleWorkerClient(options);
  return async ({ node, params, inputs, context }) => {
    const source = firstVideo(params.video ?? params.videos ?? inputs.video ?? inputs.videos);
    if (!source) throw new LocalVideoUpscaleProviderError("invalid_input", "local_video_upscale requires exactly one local video input.");
    const bytes = await readFile(source.path);
    const uploaded = await client.upload(bytes, source.filename ?? basename(source.path), source.mimeType ?? mimeFromPath(source.path), context.signal);
    const model = String(params.model ?? "").trim();
    const job = await client.run({
      model,
      input_asset: uploaded.id,
      scale: optionalNumber(params.scale),
      device: stringValue(params.device),
      output_codec: stringValue(params.output_codec ?? params.outputCodec),
      output_container: stringValue(params.output_container ?? params.outputContainer),
      crf: optionalNumber(params.crf),
      chunk_size: optionalNumber(params.chunk_size ?? params.chunkSize),
      overlap_frames: optionalNumber(params.overlap_frames ?? params.overlapFrames),
      audio_handling: stringValue(params.audio_handling ?? params.audioHandling),
      tile_size: optionalNumber(params.tile_size ?? params.tileSize),
      tile_overlap: optionalNumber(params.tile_overlap ?? params.tileOverlap)
    }, { signal: context.signal, onProgress: context.reportProgress });
    await mkdir(join(context.outputDirectory, "assets"), { recursive: true });
    const filename = `${node.id}-${job.id}.mp4`;
    const path = join(context.outputDirectory, "assets", filename);
    await writeFile(path, Buffer.from(await client.download(job.id, context.signal)));
    const video = {
      path, localPath: path, filename, mimeType: "video/mp4",
      width: job.output?.width, height: job.output?.height, duration: job.output?.duration,
      fps: job.output?.fps, frameCount: job.output?.frame_count, codec: job.output?.codec,
      sizeBytes: job.output?.bytes, audioPreserved: job.output?.audio_preserved,
      temporal: job.output?.temporal, processingSeconds: job.output?.processing_seconds,
      peakVramMb: job.output?.peak_vram_mb
    };
    return {
      output: { video, videos: [video], provider: "local_video_upscale", model, providerJobId: job.id, estimatedCost: 0, actualCost: 0, telemetry: job.output },
      provenance: { provider: "local_video_upscale", model },
      providerUsage: { provider: "local_video_upscale", model, nodeId: node.id, nodeType: node.type, externalId: job.id, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" }
    };
  };
}

function firstVideo(value: unknown): { path: string; filename?: string; mimeType?: string } | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string" && candidate.trim()) return { path: candidate };
  if (!candidate || typeof candidate !== "object") return null;
  const descriptor = candidate as Record<string, unknown>;
  const path = stringValue(descriptor.localPath) ?? stringValue(descriptor.path);
  return path ? { path, filename: stringValue(descriptor.filename), mimeType: stringValue(descriptor.mimeType) } : null;
}
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function mimeFromPath(path: string): string { const ext = extname(path).toLowerCase(); return ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : ext === ".mkv" ? "video/x-matroska" : "video/mp4"; }
