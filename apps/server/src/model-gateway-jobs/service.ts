import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunResult } from "@snarkroute/executor";
import type { OpenRoute } from "@snarkroute/protocol";
import { createRouteExecutor } from "../execution/service";
import { modelGatewayJobsDirectory } from "../server-paths";
import { errorMessage } from "../services/errors";

export type GenerationJobStatus = "queued" | "running" | "completed" | "failed";

export type GenerationMediaKind = "image" | "video" | "audio";
export type GenerationJobRequest = {
  capability: "image.generate" | "image.edit" | "image.reference" | "image.upscale" | "video.generate" | "video.upscale";
  nodeType: string;
  outputMediaType?: GenerationMediaKind;
  modelId: string;
  providerModelId: string;
  provider: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  inputs?: Array<{ kind: "image" | "video" | "audio"; role?: string; index?: number; assetId: string; path: string }>;
};

export type GenerationOutput = {
  kind: GenerationMediaKind;
  role: string;
  index: number;
  path: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  fileSize?: number;
  resultUrl?: string;
};

export type GenerationJob = {
  id: string;
  status: GenerationJobStatus;
  request: GenerationJobRequest;
  createdAt: string;
  updatedAt: string;
  result?: {
    path: string;
    filename: string;
    mimeType: string;
    provider: string | null;
    modelId: string;
    estimatedCost: number | null;
    actualCost: number | null;
  };
  outputMediaType?: GenerationMediaKind;
  outputs?: GenerationOutput[];
  error?: string;
};

type ExecuteJob = (job: GenerationJob, outputDirectory: string) => Promise<RunResult>;

export class ModelGatewayJobService {
  private readonly jobs = new Map<string, GenerationJob>();

  constructor(
    private readonly directory = modelGatewayJobsDirectory,
    private readonly execute: ExecuteJob = executeGenerationJob
  ) {}

  async create(request: GenerationJobRequest): Promise<GenerationJob> {
    validateRequest(request);
    const now = new Date().toISOString();
    const job: GenerationJob = { id: `gen_${randomUUID()}`, status: "queued", request: sanitizeRequest(request), createdAt: now, updatedAt: now };
    console.info("[SnarkRoute] model gateway provider-neutral request", {
      jobId: job.id,
      modelId: job.request.modelId,
      providerModelId: job.request.providerModelId,
      inputCount: job.request.inputs?.length ?? 0,
      request: redactSecrets(job.request)
    });
    this.jobs.set(job.id, job);
    await this.persist(job);
    void this.run(job.id);
    return publicJob(job);
  }

  async get(id: string): Promise<GenerationJob | null> {
    const cached = this.jobs.get(id);
    if (cached) return publicJob(cached);
    try {
      const parsed = JSON.parse(await readFile(this.jobPath(id), "utf8")) as GenerationJob;
      if (parsed.status === "queued" || parsed.status === "running") {
        parsed.status = "failed";
        parsed.error = "SnarkRoute server restarted before this job completed. Start the generation again.";
        parsed.updatedAt = new Date().toISOString();
        await this.persist(parsed);
      }
      this.jobs.set(id, parsed);
      return publicJob(parsed);
    } catch {
      return null;
    }
  }

  resultStream(job: GenerationJob, index = 0) {
    const path = job.outputs?.[index]?.path ?? (index === 0 ? job.result?.path : undefined);
    if (job.status !== "completed" || !path) throw new Error("Generation result is not ready.");
    return createReadStream(path);
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
    try {
      const outputDirectory = join(this.directory, job.id, "run");
      const result = await this.execute(job, outputDirectory);
      if (result.status !== "succeeded") throw new Error(result.nodeResults.generate?.error ?? "Generation failed.");
      const completed = resultsFromRun(result, job);
      job.outputMediaType = requestMediaKind(job.request);
      job.outputs = completed.outputs;
      job.result = completed.result;
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = errorMessage(error);
    }
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
  }

  private async persist(job: GenerationJob): Promise<void> {
    await mkdir(join(this.directory, job.id), { recursive: true });
    await writeFile(this.jobPath(job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  private jobPath(id: string): string {
    if (!/^gen_[a-f0-9-]+$/i.test(id)) throw new Error("Invalid generation job id.");
    return join(this.directory, id, "job.json");
  }
}

export const modelGatewayJobService = new ModelGatewayJobService();

async function executeGenerationJob(job: GenerationJob, outputDirectory: string): Promise<RunResult> {
  const executor = await createRouteExecutor();
  const route = generationRouteFromJob(job);
  return executor.executeRoute(route, { runId: job.id, outputDirectory });
}

export function generationRouteFromJob(job: GenerationJob): OpenRoute {
  return {
    routeVersion: "0.1",
    route: { id: `after-effects-${job.id}`, title: "After Effects Media Generation", author: { name: "SnarkRoute After Effects" } },
    nodes: [{
      id: "generate",
      type: job.request.nodeType,
      params: {
        ...(job.request.parameters ?? {}),
        model: job.request.providerModelId,
        ...(job.request.prompt ? { prompt: job.request.prompt } : {}),
        images: (job.request.inputs ?? []).filter((input) => input.kind === "image").map((input) => ({ assetId: input.assetId, path: input.path, localPath: input.path }))
      }
    }],
    edges: []
  };
}

function validateRequest(request: GenerationJobRequest): void {
  const supportedRunners: Record<string, { media: GenerationMediaKind; capabilities: string[] }> = {
    "polza.video.generate": { media: "video", capabilities: ["video.generate"] },
    "polza.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "ai.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "replicate.clarity-upscaler": { media: "image", capabilities: ["image.upscale"] }
  };
  const runner = supportedRunners[request.nodeType];
  if (!runner || runner.media !== requestMediaKind(request) || !runner.capabilities.includes(request.capability)) throw new Error("The selected model is not executable through the requested media runner.");
  if (!request.modelId?.trim()) throw new Error("modelId is required.");
  if (!request.providerModelId?.trim()) throw new Error("providerModelId is required.");
  for (const input of request.inputs ?? []) if (!input.assetId?.trim() || !input.path?.trim()) throw new Error("Each input must include an asset id and local path.");
}

function sanitizeRequest(request: GenerationJobRequest): GenerationJobRequest {
  const parameters = Object.fromEntries(Object.entries(request.parameters ?? {}).filter(([key]) => !/api[_-]?key|token|secret|password/i.test(key)));
  return { ...request, outputMediaType: requestMediaKind(request), modelId: request.modelId.trim(), providerModelId: request.providerModelId.trim(), prompt: request.prompt?.trim(), parameters, inputs: request.inputs ?? [] };
}

function resultsFromRun(run: RunResult, job: GenerationJob): { result: NonNullable<GenerationJob["result"]>; outputs: GenerationOutput[] } {
  const output = objectRecord(run.nodeResults.generate?.output);
  const media = requestMediaKind(job.request);
  const plural = Array.isArray(output[`${media}s`]) ? output[`${media}s`] as unknown[] : [];
  const candidates = plural.length ? plural : output[media] ? [output[media]] : [];
  const outputs = candidates.map((value, index): GenerationOutput => {
    const descriptor = objectRecord(value);
    const path = stringValue(descriptor.localPath) ?? stringValue(descriptor.path);
    if (!path || /^https?:\/\//i.test(path)) throw new Error(`Generation completed without a local ${media} result.`);
    return {
      kind: media,
      role: index === 0 ? "primary" : "alternate",
      index,
      path,
      filename: stringValue(descriptor.filename) ?? basename(path),
      mimeType: stringValue(descriptor.mimeType) ?? defaultMimeType(media),
      width: optionalNumber(descriptor.width),
      height: optionalNumber(descriptor.height),
      duration: optionalNumber(descriptor.duration),
      fileSize: optionalNumber(descriptor.sizeBytes) ?? optionalNumber(descriptor.fileSize)
    };
  });
  if (!outputs.length) throw new Error(`Generation completed without a local ${media} result.`);
  const primary = outputs[0];
  return { result: {
    path: primary.path,
    filename: primary.filename,
    mimeType: primary.mimeType,
    provider: stringValue(output.provider) ?? null,
    modelId: stringValue(output.model) ?? job.request.modelId,
    estimatedCost: numberValue(output.estimatedCost),
    actualCost: numberValue(output.actualCost)
  }, outputs };
}

function defaultMimeType(kind: GenerationMediaKind): string { return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg"; }
function requestMediaKind(request: GenerationJobRequest): GenerationMediaKind { return request.outputMediaType ?? (request.capability.startsWith("image.") ? "image" : request.capability.startsWith("audio.") ? "audio" : "video"); }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function publicJob(job: GenerationJob): GenerationJob {
  return JSON.parse(JSON.stringify(job)) as GenerationJob;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, /api[_-]?key|token|secret|password/i.test(key) ? "[redacted]" : redactSecrets(nested)]));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
