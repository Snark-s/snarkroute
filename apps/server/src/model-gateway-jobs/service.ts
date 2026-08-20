import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunResult } from "@snarkroute/executor";
import type { OpenRoute } from "@snarkroute/protocol";
import { createRouteExecutor } from "../execution/service";
import { modelGatewayJobsDirectory } from "../server-paths";
import { errorMessage } from "../services/errors";

export const generationJobStatuses = [
  "queued",
  "starting_provider",
  "loading_model",
  "generating",
  "generating_768p",
  "regenerating_2k",
  "downloading",
  "completed",
  "failed",
  "cancelled"
] as const;

export type GenerationJobStatus = (typeof generationJobStatuses)[number] | "running";

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
  toolId?: string;
  schemaVersion?: string;
  hostType?: "boojumroute" | "after_effects" | "photoshop" | "api";
  sourceContext?: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
  retryOf?: string;
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
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  providerJobId?: string;
  selectedOutputIndex?: number;
  retry?: { attempt: number; sourceJobId?: string };
  costs?: { providerCost: number | null; baseCost: number | null; markup: number | null; finalCredits: number | null };
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
  errorDetails?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
};

type ExecuteJob = (job: GenerationJob, outputDirectory: string, control: {
  signal: AbortSignal;
  onProgress: (progress: number, stage?: string) => Promise<void>;
}) => Promise<RunResult>;

export class ModelGatewayJobService {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly idempotency = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly directory = modelGatewayJobsDirectory,
    private readonly execute: ExecuteJob = executeGenerationJob
  ) {}

  async create(request: GenerationJobRequest, retryAttempt = request.retryOf ? 2 : 1): Promise<GenerationJob> {
    validateRequest(request);
    const sanitized = sanitizeRequest(request);
    const idempotencyKey = sanitized.idempotencyKey;
    if (idempotencyKey) {
      const existingId = this.idempotency.get(idempotencyKey);
      if (existingId) {
        const existing = await this.get(existingId);
        if (existing) return existing;
        this.idempotency.delete(idempotencyKey);
      }
    }
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: `gen_${randomUUID()}`,
      status: "queued",
      progress: 0,
      request: sanitized,
      createdAt: now,
      updatedAt: now,
      retry: { attempt: retryAttempt, ...(request.retryOf ? { sourceJobId: request.retryOf } : {}) }
    };
    console.info("[SnarkRoute] model gateway provider-neutral request", {
      jobId: job.id,
      modelId: job.request.modelId,
      providerModelId: job.request.providerModelId,
      inputCount: job.request.inputs?.length ?? 0,
      request: redactSecrets(job.request)
    });
    this.jobs.set(job.id, job);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, job.id);
    await this.persist(job);
    void this.run(job.id);
    return publicJob(job);
  }

  async get(id: string): Promise<GenerationJob | null> {
    const cached = this.jobs.get(id);
    if (cached) return publicJob(cached);
    try {
      const parsed = JSON.parse(await readFile(this.jobPath(id), "utf8")) as GenerationJob;
      if (!isTerminalStatus(parsed.status)) {
        parsed.status = "failed";
        parsed.error = "SnarkRoute server restarted before this job completed. Start the generation again.";
        parsed.updatedAt = new Date().toISOString();
        parsed.completedAt = parsed.updatedAt;
        await this.persist(parsed);
      }
      this.jobs.set(id, parsed);
      if (parsed.request.idempotencyKey) this.idempotency.set(parsed.request.idempotencyKey, id);
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

  async cancel(id: string): Promise<GenerationJob | null> {
    const job = await this.get(id);
    if (!job) return null;
    const internal = this.jobs.get(id)!;
    if (isTerminalStatus(internal.status)) return publicJob(internal);
    const now = new Date().toISOString();
    internal.status = "cancelled";
    this.controllers.get(id)?.abort();
    internal.cancelRequestedAt = now;
    internal.completedAt = now;
    internal.updatedAt = now;
    await this.persist(internal);
    return publicJob(internal);
  }

  async retry(id: string, idempotencyKey?: string): Promise<GenerationJob | null> {
    const source = await this.get(id);
    if (!source) return null;
    if (source.status !== "failed" && source.status !== "cancelled") throw new Error("Only failed or cancelled jobs can be retried.");
    return this.create({
      ...source.request,
      retryOf: source.id,
      idempotencyKey: idempotencyKey?.trim() || `${source.id}:retry:${(source.retry?.attempt ?? 1) + 1}`
    }, (source.retry?.attempt ?? 1) + 1);
  }

  async selectOutput(id: string, index: number): Promise<GenerationJob | null> {
    const job = await this.get(id);
    if (!job) return null;
    const internal = this.jobs.get(id)!;
    if (internal.status !== "completed") throw new Error("Results can only be selected after completion.");
    const output = internal.outputs?.find((candidate) => candidate.index === index);
    if (!output) throw new Error("The selected result does not exist.");
    internal.selectedOutputIndex = index;
    internal.updatedAt = new Date().toISOString();
    await this.persist(internal);
    return publicJob(internal);
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    await this.transition(job, "starting_provider", 0.05);
    try {
      if (job.status === "cancelled") { this.controllers.delete(id); return; }
      if (job.request.provider === "local_upscale") await this.transition(job, "loading_model", 0.1);
      await this.transition(job, job.request.provider === "minimax-h3" ? "generating_768p" : "generating", 0.15);
      const outputDirectory = join(this.directory, job.id, "run");
      const result = await this.execute(job, outputDirectory, {
        signal: controller.signal,
        onProgress: async (progress, stage) => {
          if (job.status === "cancelled") return;
          job.progress = Math.max(job.progress ?? 0.15, Math.min(0.88, 0.15 + Math.max(0, Math.min(progress, 1)) * 0.73));
          if (stage === "loading_model" && canTransitionGenerationJob(job.status, "loading_model")) job.status = "loading_model";
          job.updatedAt = new Date().toISOString();
          await this.persist(job);
        }
      });
      if (this.jobs.get(id)?.status === "cancelled") { this.controllers.delete(id); return; }
      if (result.status !== "succeeded") {
        const nodeError = result.nodeResults.generate;
        throw Object.assign(new Error(nodeError?.error ?? "Generation failed."), nodeError?.errorDetails ?? {});
      }
      await this.transition(job, "downloading", 0.9);
      const completed = resultsFromRun(result, job);
      job.outputMediaType = requestMediaKind(job.request);
      job.outputs = completed.outputs;
      job.result = completed.result;
      job.providerJobId = providerJobIdFromRun(result);
      job.costs = {
        providerCost: completed.result.actualCost ?? completed.result.estimatedCost,
        baseCost: completed.result.actualCost ?? completed.result.estimatedCost,
        markup: null,
        finalCredits: null
      };
      job.status = "completed";
      job.progress = 1;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      if (job.status === "cancelled") { this.controllers.delete(id); return; }
      job.status = "failed";
      job.error = errorMessage(error);
      job.errorDetails = structuredError(error);
      job.progress = 0;
      job.completedAt = new Date().toISOString();
    }
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
    this.controllers.delete(id);
  }

  private async transition(job: GenerationJob, status: GenerationJobStatus, progress: number): Promise<void> {
    if (job.status === "cancelled") return;
    if (!canTransitionGenerationJob(job.status, status)) throw new Error(`Invalid generation job transition: ${job.status} -> ${status}.`);
    const now = new Date().toISOString();
    job.status = status;
    job.progress = progress;
    job.updatedAt = now;
    job.startedAt ??= now;
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

async function executeGenerationJob(job: GenerationJob, outputDirectory: string, control: { signal: AbortSignal; onProgress: (progress: number, stage?: string) => Promise<void> }): Promise<RunResult> {
  const executor = await createRouteExecutor();
  const route = generationRouteFromJob(job);
  return executor.executeRoute(route, { runId: job.id, outputDirectory, signal: control.signal, onProgress: control.onProgress });
}

export function generationRouteFromJob(job: GenerationJob): OpenRoute {
  return {
    routeVersion: "0.1",
    route: { id: `model-gateway-${job.id}`, title: "Model Gateway Media Job", author: { name: "SnarkRoute" } },
    nodes: [{
      id: "generate",
      type: job.request.nodeType,
      params: {
        ...(job.request.parameters ?? {}),
        model: job.request.providerModelId,
        ...(job.request.prompt ? { prompt: job.request.prompt } : {}),
        images: normalizedRouteInputs(job.request.inputs, "image"),
        audios: normalizedRouteInputs(job.request.inputs, "audio"),
        videos: normalizedRouteInputs(job.request.inputs, "video")
      }
    }],
    edges: []
  };
}

function validateRequest(request: GenerationJobRequest): void {
  const supportedRunners: Record<string, { media: GenerationMediaKind; capabilities: string[] }> = {
    "ai.video.generate": { media: "video", capabilities: ["video.generate"] },
    "polza.video.generate": { media: "video", capabilities: ["video.generate"] },
    "polza.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "ai.image.generate": { media: "image", capabilities: ["image.generate", "image.edit", "image.reference"] },
    "replicate.clarity-upscaler": { media: "image", capabilities: ["image.upscale"] },
    "local_upscale": { media: "image", capabilities: ["image.upscale"] }
  };
  const runner = supportedRunners[request.nodeType];
  if (!runner || runner.media !== requestMediaKind(request) || !runner.capabilities.includes(request.capability)) throw new Error("The selected model is not executable through the requested media runner.");
  if (!request.modelId?.trim()) throw new Error("modelId is required.");
  if (!request.providerModelId?.trim()) throw new Error("providerModelId is required.");
  if ((request.prompt?.length ?? 0) > 20_000) throw new Error("prompt must not exceed 20000 characters.");
  if ((request.inputs?.length ?? 0) > 16) throw new Error("A generation job supports at most 16 inputs.");
  if (request.toolId && !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(request.toolId)) throw new Error("toolId is invalid.");
  if (request.schemaVersion && !/^\d+\.\d+(?:\.\d+)?$/.test(request.schemaVersion)) throw new Error("schemaVersion is invalid.");
  if (request.correlationId) validateCorrelationValue(request.correlationId, "correlationId");
  if (request.idempotencyKey) validateCorrelationValue(request.idempotencyKey, "idempotencyKey");
  if (request.retryOf && !/^gen_[a-f0-9-]+$/i.test(request.retryOf)) throw new Error("retryOf is invalid.");
  assertJsonSize(request.parameters, 64 * 1024, "parameters");
  assertJsonSize(request.sourceContext, 64 * 1024, "sourceContext");
  for (const input of request.inputs ?? []) if (!input.assetId?.trim() || !input.path?.trim()) throw new Error("Each input must include an asset id and local path.");
  if (request.nodeType === "local_upscale" && (request.inputs ?? []).filter((input) => input.kind === "image").length !== 1) throw new Error("local_upscale requires exactly one image input.");
}

function normalizedRouteInputs(inputs: GenerationJobRequest["inputs"], kind: GenerationMediaKind) {
  return (inputs ?? []).filter((input) => input.kind === kind).sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || (left.index ?? 0) - (right.index ?? 0)).map((input) => ({ assetId: input.assetId, path: input.path, localPath: input.path, role: input.role, index: input.index ?? 0 }));
}
function roleOrder(role?: string) { return role === "firstFrame" ? 0 : role === "lastFrame" ? 1 : 2; }

function sanitizeRequest(request: GenerationJobRequest): GenerationJobRequest {
  const parameters = Object.fromEntries(Object.entries(request.parameters ?? {}).filter(([key]) => !/api[_-]?key|token|secret|password/i.test(key)));
  return {
    ...request,
    outputMediaType: requestMediaKind(request),
    modelId: request.modelId.trim(),
    providerModelId: request.providerModelId.trim(),
    prompt: request.prompt?.trim(),
    parameters,
    inputs: request.inputs ?? [],
    sourceContext: sanitizeContext(request.sourceContext),
    correlationId: request.correlationId?.trim(),
    idempotencyKey: request.idempotencyKey?.trim()
  };
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

function providerJobIdFromRun(run: RunResult): string | undefined {
  const output = objectRecord(run.nodeResults.generate?.output);
  return stringValue(output.providerJobId) ?? stringValue(output.requestId) ?? stringValue(output.taskId);
}

function sanitizeContext(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return redactSecrets(value) as Record<string, unknown>;
}

function assertJsonSize(value: unknown, limit: number, label: string): void {
  if (value === undefined) return;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable.`); }
  if (Buffer.byteLength(serialized, "utf8") > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
}

function validateCorrelationValue(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value.trim())) throw new Error(`${label} is invalid.`);
}

function structuredError(error: unknown): GenerationJob["errorDetails"] {
  if (!error || typeof error !== "object") return { code: "provider_failed", message: errorMessage(error), retryable: false };
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === "string" && record.code ? record.code : "provider_failed",
    message: errorMessage(error),
    retryable: record.retryable === true,
    ...(record.details && typeof record.details === "object" && !Array.isArray(record.details) ? { details: record.details as Record<string, unknown> } : {})
  };
}

function isTerminalStatus(status: GenerationJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function canTransitionGenerationJob(from: GenerationJobStatus, to: GenerationJobStatus): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  if (to === "failed" || to === "cancelled") return true;
  const order: GenerationJobStatus[] = ["queued", "starting_provider", "loading_model", "generating", "generating_768p", "regenerating_2k", "downloading", "completed"];
  const normalizedFrom = from === "running" ? "generating" : from;
  return order.indexOf(to) > order.indexOf(normalizedFrom);
}
